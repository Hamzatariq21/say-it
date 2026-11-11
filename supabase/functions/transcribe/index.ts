// Say It: voice note -> text with Whisper on Groq (free tier). Optional: needs GROQ_API_KEY.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const GROQ_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

// Spelling hints so Whisper writes dish names the way the parser expects.
const BASE_VOCAB =
  "Food diary. Paratha, roti, chapati, naan, biryani, pulao, karahi, nihari, haleem, daal, chana, aloo, keema, " +
  "chapli kebab, seekh kebab, tikka, chai, lassi, laban, shawarma, machboos, mandi, hummus, falafel, manakish, " +
  "karak, kunafa, labneh, grams, ml, tablespoon.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u, error } = await admin.auth.getUser(token);
    if (error || !u?.user) return json({ error: "unauthorized", message: "Sign in again." }, 401);
    const { data: allowed } = await admin.from("allowed_emails").select("email").ilike("email", u.user.email ?? "").maybeSingle();
    if (!allowed) return json({ error: "forbidden", message: "This app is private." }, 403);
    if (!GROQ_KEY) return json({ error: "not_configured", message: "Whisper isn't set up." }, 503);

    const form = await req.formData();
    const audio = form.get("audio");
    if (!(audio instanceof File) || audio.size === 0) return json({ error: "empty", message: "No audio received." }, 400);
    if (audio.size > 24 * 1024 * 1024) return json({ error: "too_large", message: "That recording is too long." }, 413);
    const extra = String(form.get("vocab") ?? "").slice(0, 400);

    const out = new FormData();
    out.append("file", audio, audio.name || "voice.webm");
    out.append("model", "whisper-large-v3-turbo");
    out.append("response_format", "json");
    out.append("temperature", "0");
    out.append("prompt", (BASE_VOCAB + (extra ? " " + extra : "")).slice(0, 800));
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_KEY}` },
      body: out,
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 429) return json({ error: "rate_limited", message: "Voice is busy. Try again in a moment." }, 429);
    if (!res.ok) {
      console.error("groq", res.status, body);
      return json({ error: "whisper_error", message: "Couldn't transcribe that. Try again or type it." }, 502);
    }
    return json({ text: String(body.text ?? "").trim() });
  } catch (e) {
    console.error(e);
    return json({ error: "server_error", message: "Couldn't transcribe that." }, 500);
  }
});
