// Say It: meal parsing, USDA lookups and calorie ranges.
// Modes: "status" (which keys are set), "parse" (diary line -> draft items), "extract" (pasted label text -> one food)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const USDA_KEY = Deno.env.get("USDA_API_KEY") ?? "";
const GROQ_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-haiku-5-5";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

type Per100 = { kcal: number; protein: number; carbs: number; fat: number };
type Ingredient = {
  label: string;
  usda_query: string;
  grams_low: number;
  grams_likely: number;
  grams_high: number;
  per100g: Per100;
};
type RawItem = {
  name: string;
  portion: string;
  meal: string;
  time: string;
  date: string;
  saved_food_id: string | null;
  servings: number;
  label: { serving: string | null; serving_g: number | null; kcal: number; protein: number; carbs: number; fat: number } | null;
  ingredients: Ingredient[];
  note: string;
  confidence: string;
};

const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : Number(v) || 0);
const r = (v: number) => Math.round(v);
const r1 = (v: number) => Math.round(v * 10) / 10;

type Img = { data: string; media_type: string } | null;

// An attached photo goes first, then the instructions, so Claude reads the text with the image in view.
function withImage(prompt: string, img: Img) {
  if (!img) return prompt;
  return [
    { type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } },
    { type: "text", text: prompt },
  ];
}

function readImage(body: Record<string, unknown>): Img {
  const data = typeof body.image === "string" ? body.image.replace(/^data:[^,]+,/, "") : "";
  if (!data) return null;
  const media_type = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(String(body.media_type))
    ? String(body.media_type) : "image/jpeg";
  if (data.length > 6_500_000) throw new Error("image_too_large");
  return { data, media_type };
}

async function callClaude(prompt: unknown, tool: { name: string; description: string; input_schema: unknown }, maxTokens = 2500) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`claude_${res.status}: ${body?.error?.message ?? "request failed"}`);
  const block = (body.content ?? []).find((b: { type: string }) => b.type === "tool_use");
  if (!block) throw new Error("claude_no_output");
  return { input: block.input, usage: body.usage };
}

// ---------- USDA FoodData Central ----------
function pickNutrients(food: { foodNutrients?: Array<Record<string, unknown>> }): Per100 | null {
  const byId = new Map<number, number>();
  for (const n of food.foodNutrients ?? []) {
    const id = num(n.nutrientId ?? (n.nutrient as Record<string, unknown>)?.id);
    const val = num(n.value ?? n.amount);
    if (id) byId.set(id, val);
  }
  // 1008 = Energy (kcal); Foundation foods often carry Atwater energy instead (2048 specific, 2047 general)
  const kcal = byId.get(1008) ?? byId.get(2048) ?? byId.get(2047);
  if (kcal === undefined) return null;
  return { kcal, protein: byId.get(1003) ?? 0, carbs: byId.get(1005) ?? 0, fat: byId.get(1004) ?? 0 };
}

async function usdaSearch(query: string, dataType: string) {
  const u = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
  u.searchParams.set("api_key", USDA_KEY || "DEMO_KEY");
  u.searchParams.set("query", query);
  u.searchParams.set("dataType", dataType);
  u.searchParams.set("pageSize", "5");
  const res = await fetch(u);
  if (!res.ok) throw new Error(`usda_${res.status}`);
  const body = await res.json();
  for (const f of body.foods ?? []) {
    const p = pickNutrients(f);
    if (p && p.kcal > 0 || (p && /water|tea|coffee|diet/i.test(f.description))) {
      return { fdc_id: f.fdcId as number, description: f.description as string, data_type: f.dataType as string, ...p! };
    }
  }
  return null;
}

type UsdaHit = { fdc_id: number | null; description: string | null; data_type: string | null; kcal_100g: number | null; protein_100g: number | null; carbs_100g: number | null; fat_100g: number | null };

async function usdaLookup(rawQuery: string): Promise<UsdaHit | null> {
  const query = rawQuery.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
  if (!query) return null;
  const { data: cached } = await admin.from("usda_cache").select("*").eq("query", query).maybeSingle();
  if (cached) return cached.fdc_id ? cached : null;
  let hit = null;
  try {
    hit = (await usdaSearch(query, "Foundation,SR Legacy")) ?? (await usdaSearch(query, "Survey (FNDDS)"));
  } catch (_e) {
    return null; // network or rate limit: fall back to model values, don't cache the miss
  }
  const row: UsdaHit & { query: string } = hit
    ? { query, fdc_id: hit.fdc_id, description: hit.description, data_type: hit.data_type, kcal_100g: hit.kcal, protein_100g: hit.protein, carbs_100g: hit.carbs, fat_100g: hit.fat }
    : { query, fdc_id: null, description: null, data_type: null, kcal_100g: null, protein_100g: null, carbs_100g: null, fat_100g: null };
  await admin.from("usda_cache").upsert(row);
  return hit ? row : null;
}

// ---------- Parse ----------
const PARSE_TOOL = {
  name: "log_meal",
  description: "Record the foods in the user's diary line.",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short display name, e.g. 'Chicken biryani'" },
            portion: { type: "string", description: "Amount as eaten, e.g. '1 plate, about 350 g'" },
            meal: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
            time: { type: "string", description: "HH:MM, 24 hour" },
            date: { type: "string", description: "YYYY-MM-DD" },
            saved_food_id: { type: ["string", "null"], description: "id of the matching saved food, or null" },
            servings: { type: "number", description: "Servings eaten of the saved food or printed label serving; 1 otherwise" },
            label: {
              type: ["object", "null"],
              description: "Only when the photo shows printed nutrition (label or pack): the printed values for ONE serving. Otherwise null.",
              properties: {
                serving: { type: ["string", "null"], description: "Serving as printed, e.g. '1 bar (40 g)'" },
                serving_g: { type: ["number", "null"] },
                kcal: { type: "number" }, protein: { type: "number" }, carbs: { type: "number" }, fat: { type: "number" },
              },
              required: ["serving", "serving_g", "kcal", "protein", "carbs", "fat"],
            },
            ingredients: {
              type: "array",
              description: "Empty for saved foods. Otherwise the dish broken into ingredients as eaten.",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "Plain label, e.g. 'Cooking oil'" },
                  usda_query: { type: "string", description: "Search phrase for USDA FoodData Central, generic and in USDA wording, e.g. 'rice white long-grain cooked', 'oil vegetable', 'chicken thigh meat cooked'" },
                  grams_low: { type: "number" },
                  grams_likely: { type: "number" },
                  grams_high: { type: "number" },
                  per100g: {
                    type: "object",
                    description: "Your best values per 100 g of this ingredient, used if USDA has no match",
                    properties: { kcal: { type: "number" }, protein: { type: "number" }, carbs: { type: "number" }, fat: { type: "number" } },
                    required: ["kcal", "protein", "carbs", "fat"],
                  },
                },
                required: ["label", "usda_query", "grams_low", "grams_likely", "grams_high", "per100g"],
              },
            },
            note: { type: "string", description: "A few words on the main assumption, or ''" },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["name", "portion", "meal", "time", "date", "saved_food_id", "servings", "label", "ingredients", "note", "confidence"],
        },
      },
    },
    required: ["items"],
  },
};

function parsePrompt(text: string, ctx: Record<string, string>, foods: unknown[], hasImage: boolean) {
  const photoRules = hasImage ? `
7. A photo is attached. Use it together with the user's words. The words win on what and how much was eaten ("I had half", "shared with a friend", "less oil"); the photo shows what the food is and how big the portion looks. Judge size from the plate, bowl, cutlery, hands or packaging. Only log food the user ate or says they ate.
8. If the photo shows printed nutrition (a nutrition facts table or a pack with calories printed), set label to the printed values for ONE serving, set servings to how many servings the user ate (from their words, default 1), set saved_food_id to null and ingredients to []. If only per-100 g values are printed, use 100 g as the serving and set servings from the grams eaten. Never estimate when printed numbers are readable.
9. For a photo of a plated meal, set label to null and break each dish into ingredients with low, likely and high grams as in rule 3. Photo portions are harder to judge, so keep the range honest.` : `
7. No photo is attached: always set label to null.`;
  return `You turn one food diary entry into structured log items for a calorie tracker. The entry is a spoken or typed line${hasImage ? " plus a photo" : ""}. The user lives in Dubai and eats Pakistani, Indian, Arab and international food.

Now: ${ctx.weekday} ${ctx.today} ${ctx.now} (user's local time). The day open in the app is ${ctx.viewing}.

The user's saved foods (exact published numbers per one serving):
${JSON.stringify(foods)}

Rules:
1. One item per distinct food or drink. Keep a composed dish (biryani, karahi with naan counts as two items: karahi, naan) as one item per dish.
2. If an item clearly matches a saved food by name or alias (allow for speech-to-text misspellings), set saved_food_id to its id, servings to how many servings were eaten (for grams, divide by serving_g), and ingredients to []. Never estimate a saved food.
3. Otherwise set saved_food_id to null, servings to 1, and break the item into its main ingredients as actually eaten, including cooking oil, ghee, butter, sugar and sauces, which are where most hidden calories are. Give grams_low, grams_likely and grams_high for each: the likely amount is a typical UAE restaurant or home portion unless the user gave a size; low and high bracket the realistic spread for that description. When the user gives an exact size, keep the range tight. Packaged drinks or simple foods can be one ingredient.
4. usda_query must be generic USDA FoodData Central wording for a single raw or cooked ingredient (not a dish name), so a database search finds it.
5. meal: use the user's words first, otherwise infer from the time. time: the stated time, else a typical time for the named meal, else ${ctx.now}. date: resolve words like "yesterday" against today ${ctx.today}; if no day is said use ${ctx.viewing}. Never a future date.
6. If the entry contains no food, return an empty items array.${photoRules}

The user's words:
"""${text.slice(0, 2000) || "(no description, use the photo)"}"""`;
}

async function handleParse(userId: string, body: Record<string, string>) {
  const text = String(body.text ?? "").trim();
  const img = readImage(body);
  if (!text && !img) return json({ error: "empty", message: "Say or type what you ate, or add a photo." }, 400);
  const { data: foods } = await admin
    .from("foods")
    .select("id,name,aliases,serving,serving_g,kcal,protein,carbs,fat")
    .eq("user_id", userId)
    .limit(400);
  const foodList = foods ?? [];
  const ctx = {
    today: body.today, now: body.now, viewing: body.viewing ?? body.today, weekday: body.weekday ?? "",
  };
  const { input, usage } = await callClaude(withImage(parsePrompt(text, ctx, foodList.map((f) => ({
    id: f.id, name: f.name, aliases: f.aliases, serving: f.serving, serving_g: f.serving_g, kcal: f.kcal,
  })), !!img), img), PARSE_TOOL, 3000);
  const fromPhoto = !!img;

  const raw: RawItem[] = Array.isArray(input?.items) ? input.items : [];
  const items = await Promise.all(raw.map(async (it) => {
    const base = {
      name: String(it.name || "Food"),
      meal: ["breakfast", "lunch", "dinner", "snack"].includes(it.meal) ? it.meal : "snack",
      time: /^\d{2}:\d{2}$/.test(it.time) ? it.time : ctx.now,
      date: /^\d{4}-\d{2}-\d{2}$/.test(it.date) && it.date <= ctx.today ? it.date : ctx.viewing,
      note: String(it.note ?? ""),
      confidence: it.confidence ?? "medium",
      from_photo: fromPhoto,
    };
    const saved = it.saved_food_id ? foodList.find((f) => f.id === it.saved_food_id) : null;
    if (saved) {
      const s = num(it.servings) > 0 ? num(it.servings) : 1;
      const kcal = num(saved.kcal) * s;
      return {
        ...base, name: saved.name, source: "saved", food_id: saved.id, servings: s,
        portion: `${r1(s)} × ${saved.serving}`,
        per_serving: { kcal: num(saved.kcal), protein: num(saved.protein), carbs: num(saved.carbs), fat: num(saved.fat) },
        kcal: r(kcal), kcal_low: r(kcal), kcal_high: r(kcal),
        protein: r1(num(saved.protein) * s), carbs: r1(num(saved.carbs) * s), fat: r1(num(saved.fat) * s),
        breakdown: [],
      };
    }
    // Printed nutrition read from a photo: exact, no range.
    if (fromPhoto && it.label && num(it.label.kcal) > 0) {
      const L = it.label, s = num(it.servings) > 0 ? num(it.servings) : 1;
      const serving = L.serving || (L.serving_g ? `${r(num(L.serving_g))} g` : "serving");
      const kcal = num(L.kcal) * s;
      return {
        ...base, source: "label", food_id: null, servings: s, portion: `${r1(s)} × ${serving}`,
        per_serving: { kcal: num(L.kcal), protein: num(L.protein), carbs: num(L.carbs), fat: num(L.fat), serving, serving_g: L.serving_g },
        kcal: r(kcal), kcal_low: r(kcal), kcal_high: r(kcal),
        protein: r1(num(L.protein) * s), carbs: r1(num(L.carbs) * s), fat: r1(num(L.fat) * s),
        breakdown: [],
      };
    }
    const ingredients = Array.isArray(it.ingredients) ? it.ingredients.slice(0, 12) : [];
    let allUsda = ingredients.length > 0;
    const breakdown = await Promise.all(ingredients.map(async (ing) => {
      const model = { kcal: num(ing.per100g?.kcal), protein: num(ing.per100g?.protein), carbs: num(ing.per100g?.carbs), fat: num(ing.per100g?.fat) };
      const hit = await usdaLookup(ing.usda_query || ing.label);
      let per = model, usda = null as null | { fdc_id: number; description: string; data_type: string };
      if (hit && hit.kcal_100g !== null) {
        const k = num(hit.kcal_100g);
        // Guard against a bad top search hit: if USDA is wildly off the model's own value, keep the model's.
        const plausible = model.kcal < 15 || k < 15 || (k / model.kcal > 0.45 && k / model.kcal < 2.2);
        if (plausible) {
          per = { kcal: k, protein: num(hit.protein_100g), carbs: num(hit.carbs_100g), fat: num(hit.fat_100g) };
          usda = { fdc_id: hit.fdc_id!, description: hit.description!, data_type: hit.data_type! };
        }
      }
      if (!usda) allUsda = false;
      let lo = Math.max(0, num(ing.grams_low)), mid = Math.max(0, num(ing.grams_likely)), hi = Math.max(0, num(ing.grams_high));
      [lo, mid, hi] = [Math.min(lo, mid, hi), [lo, mid, hi].sort((a, b) => a - b)[1], Math.max(lo, mid, hi)];
      return {
        label: ing.label, grams: { low: r(lo), likely: r(mid), high: r(hi) }, per100g: per,
        kcal: { low: (lo * per.kcal) / 100, likely: (mid * per.kcal) / 100, high: (hi * per.kcal) / 100 },
        protein: (mid * per.protein) / 100, carbs: (mid * per.carbs) / 100, fat: (mid * per.fat) / 100,
        usda,
      };
    }));
    const sum = (f: (b: typeof breakdown[number]) => number) => breakdown.reduce((a, b) => a + f(b), 0);
    return {
      ...base, portion: String(it.portion ?? ""), source: allUsda ? "usda" : "estimate", food_id: null, servings: 1,
      kcal: r(sum((b) => b.kcal.likely)), kcal_low: r(sum((b) => b.kcal.low)), kcal_high: r(sum((b) => b.kcal.high)),
      protein: r1(sum((b) => b.protein)), carbs: r1(sum((b) => b.carbs)), fat: r1(sum((b) => b.fat)),
      breakdown: breakdown.map((b) => ({ ...b, kcal: { low: r(b.kcal.low), likely: r(b.kcal.likely), high: r(b.kcal.high) }, protein: r1(b.protein), carbs: r1(b.carbs), fat: r1(b.fat) })),
    };
  }));
  return json({ items, transcript: text, from_photo: fromPhoto, model: MODEL, usage });
}

// ---------- Extract from pasted label text ----------
const EXTRACT_TOOL = {
  name: "food_label",
  description: "The published nutrition for one food.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: ["string", "null"] },
      serving: { type: ["string", "null"] },
      serving_g: { type: ["number", "null"] },
      kcal: { type: ["number", "null"] },
      protein: { type: ["number", "null"] },
      carbs: { type: ["number", "null"] },
      fat: { type: ["number", "null"] },
    },
    required: ["name", "serving", "serving_g", "kcal", "protein", "carbs", "fat"],
  },
};

async function handleExtract(body: Record<string, string>) {
  const text = String(body.text ?? "").trim().slice(0, 6000);
  const img = readImage(body);
  if (!text && !img) return json({ error: "empty", message: "Paste the nutrition text or add a label photo first." }, 400);
  const prompt = img
    ? `Read the printed nutrition for this one food from the photo (a nutrition facts label, pack or menu). Give values for ONE serving as printed; if only per-100 g values are printed, use 100 g as the serving. Use the product name on the pack if visible. Use null for anything not printed. Do not estimate.${text ? `\n\nThe user adds: """${text}"""` : ""}`
    : `Extract one food's published nutrition from this text pasted from a restaurant, meal-plan or product website. If several sizes are listed, use the first. Use null for anything not stated. Do not estimate.\n\nText:\n"""${text}"""`;
  const { input } = await callClaude(withImage(prompt, img), EXTRACT_TOOL, 600);
  return json({ food: input });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !u?.user) return json({ error: "unauthorized", message: "Sign in again." }, 401);
    const { data: allowed } = await admin.from("allowed_emails").select("email").ilike("email", u.user.email ?? "").maybeSingle();
    if (!allowed) return json({ error: "forbidden", message: "This app is private." }, 403);

    const body = await req.json().catch(() => ({}));
    if (body.mode === "status") {
      return json({ anthropic: !!ANTHROPIC_KEY, usda: USDA_KEY ? "own" : "demo", whisper: !!GROQ_KEY, model: MODEL });
    }
    if (!ANTHROPIC_KEY) return json({ error: "not_configured", message: "Add ANTHROPIC_API_KEY in Supabase secrets." }, 503);
    if (body.mode === "extract") return await handleExtract(body);
    return await handleParse(u.user.id, body);
  } catch (e) {
    console.error(e);
    const msg = String((e as Error)?.message ?? e);
    if (msg === "image_too_large") return json({ error: "image_too_large", message: "That photo is too large. Try another one." }, 413);
    if (msg.startsWith("claude_429")) return json({ error: "rate_limited", message: "Claude is busy. Try again in a moment." }, 429);
    if (msg.startsWith("claude_401")) return json({ error: "bad_key", message: "The Anthropic API key was rejected. Check the secret." }, 502);
    if (msg.startsWith("claude_")) return json({ error: "claude_error", message: msg.replace(/^claude_\d*:?\s*/, "") || "Claude failed." }, 502);
    return json({ error: "server_error", message: "Something went wrong reading that meal." }, 500);
  }
});
