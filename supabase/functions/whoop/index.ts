// Say It: WHOOP connection and sync.
// GET  /whoop/callback                 WHOOP sends the user back here after they approve access
// POST /whoop {action: "status"}       is WHOOP set up and connected
// POST /whoop {action: "start"}        returns the WHOOP sign-in URL
// POST /whoop {action: "sync"}         pulls recent WHOOP days (calories, steps) and workouts
// POST /whoop {action: "disconnect"}   revokes access and deletes WHOOP data
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
// Trim stray spaces, line breaks and quotes that often come along when pasting keys.
const env = (k: string) => (Deno.env.get(k) ?? "").trim().replace(/^["']|["']$/g, "").trim();

const API = "https://api.prod.whoop.com/developer";
const AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const SCOPES = "offline read:cycles read:workout";
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/whoop/callback`;
// Where the app may ask to be sent back to after connecting (stops this being an open redirect).
const RETURN_OK = [/^https:\/\/hamzatariq21\.github\.io\/say-it\//, /^http:\/\/localhost(:\d+)?\//, /^http:\/\/127\.0\.0\.1(:\d+)?\//];
const DEFAULT_RETURN = "https://hamzatariq21.github.io/say-it/";

const configured = () => !!env("WHOOP_CLIENT_ID") && !!env("WHOOP_CLIENT_SECRET");
const kcalFromKj = (kj: unknown) => (typeof kj === "number" && isFinite(kj) ? Math.round(kj / 4.184) : null);
const int = (v: unknown) => (typeof v === "number" && isFinite(v) ? Math.round(v) : null);

// Local calendar date of a moment, using WHOOP's timezone offset ("+04:00"), shifted by extra hours.
function localDay(startIso: string, offset: string | null | undefined, shiftHours = 0) {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset ?? "");
  const mins = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return new Date(Date.parse(startIso) + (mins + shiftHours * 60) * 60_000).toISOString().slice(0, 10);
}
// A WHOOP day starts when you fall asleep. Shifting 8 hours dates it by the morning you woke up,
// whether you slept at 11pm or 2am.
const wakeDay = (startIso: string, offset: string | null | undefined) => localDay(startIso, offset, 8);

async function signedInUser(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: ok } = await admin.from("allowed_emails").select("email").ilike("email", data.user.email ?? "").maybeSingle();
  return ok ? data.user : null;
}

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`whoop_token_${res.status}: ${body.error_description ?? body.error ?? ""}`);
  return body as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
}

const expiry = (secs?: number) => new Date(Date.now() + ((secs ?? 3600) - 60) * 1000).toISOString();

async function accessTokenFor(userId: string) {
  const { data: c } = await admin.from("whoop_connections").select("*").eq("user_id", userId).maybeSingle();
  if (!c) throw new Error("not_connected");
  if (Date.parse(c.expires_at) > Date.now()) return c.access_token as string;
  if (!c.refresh_token) throw new Error("reconnect");
  let t;
  try {
    t = await tokenRequest({
      grant_type: "refresh_token", refresh_token: c.refresh_token,
      client_id: env("WHOOP_CLIENT_ID"), client_secret: env("WHOOP_CLIENT_SECRET"), scope: "offline",
    });
  } catch (_e) {
    throw new Error("reconnect");
  }
  // Each refresh replaces both tokens, so store the new pair straight away.
  await admin.from("whoop_connections").update({
    access_token: t.access_token, refresh_token: t.refresh_token ?? c.refresh_token, expires_at: expiry(t.expires_in), scope: t.scope ?? c.scope,
  }).eq("user_id", userId);
  return t.access_token;
}

async function whoopGet(token: string, path: string, params: Record<string, string>) {
  const u = new URL(API + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new Error("reconnect");
  if (res.status === 429) throw new Error("whoop_busy");
  if (!res.ok) throw new Error(`whoop_${res.status}`);
  return await res.json();
}

async function collect(token: string, path: string, start: string) {
  const out: Record<string, unknown>[] = [];
  let next: string | null = null;
  for (let page = 0; page < 12; page++) {
    const params: Record<string, string> = { start, limit: "25" };
    if (next) params.nextToken = next;
    const body = await whoopGet(token, path, params);
    out.push(...(body.records ?? []));
    next = body.next_token ?? body.nextToken ?? null;
    if (!next) break;
  }
  return out;
}

async function sync(userId: string, days: number) {
  const token = await accessTokenFor(userId);
  const start = new Date(Date.now() - days * 864e5).toISOString();
  const [cycles, workouts] = await Promise.all([
    collect(token, "/v2/cycle", start),
    collect(token, "/v2/activity/workout", start),
  ]);
  const now = new Date().toISOString();
  // deno-lint-ignore no-explicit-any
  const dayRows = cycles.map((c: any) => ({
    user_id: userId, cycle_id: c.id, day: wakeDay(c.start, c.timezone_offset),
    started_at: c.start, ended_at: c.end ?? null, timezone_offset: c.timezone_offset ?? null, score_state: c.score_state ?? null,
    kcal: kcalFromKj(c.score?.kilojoule), strain: c.score?.strain ?? null,
    steps: int(c.step_count ?? c.score?.step_count), avg_hr: int(c.score?.average_heart_rate), max_hr: int(c.score?.max_heart_rate),
    updated_at: now,
  }));
  // deno-lint-ignore no-explicit-any
  const wkRows = workouts.map((w: any) => ({
    user_id: userId, workout_id: String(w.id), day: localDay(w.start, w.timezone_offset),
    started_at: w.start, ended_at: w.end ?? null, sport_name: w.sport_name ?? null, score_state: w.score_state ?? null,
    kcal: kcalFromKj(w.score?.kilojoule), strain: w.score?.strain ?? null, avg_hr: int(w.score?.average_heart_rate),
    updated_at: now,
  }));
  if (dayRows.length) {
    const { error } = await admin.from("whoop_days").upsert(dayRows, { onConflict: "user_id,cycle_id" });
    if (error) throw new Error("db_" + error.message);
  }
  if (wkRows.length) {
    const { error } = await admin.from("whoop_workouts").upsert(wkRows, { onConflict: "user_id,workout_id" });
    if (error) throw new Error("db_" + error.message);
  }
  await admin.from("whoop_connections").update({ last_synced_at: now, last_error: null }).eq("user_id", userId);
  return { days: dayRows.length, workouts: wkRows.length, last_synced_at: now };
}

function backTo(returnTo: string, status: string) {
  const u = new URL(returnTo);
  u.searchParams.set("whoop", status);
  return new Response(null, { status: 302, headers: { Location: u.toString() } });
}

async function handleCallback(url: URL) {
  const state = url.searchParams.get("state") ?? "";
  const { data: st } = await admin.from("whoop_oauth_states").select("*").eq("state", state).maybeSingle();
  if (st) await admin.from("whoop_oauth_states").delete().eq("state", state);
  if (!st || Date.now() - Date.parse(st.created_at) > 15 * 60_000) {
    return new Response("This WHOOP sign-in link has expired. Go back to Say It and tap Connect WHOOP again.", { status: 400, headers: CORS });
  }
  if (url.searchParams.get("error") || !url.searchParams.get("code")) return backTo(st.return_to, "denied");
  try {
    const t = await tokenRequest({
      grant_type: "authorization_code", code: url.searchParams.get("code")!, redirect_uri: REDIRECT_URI,
      client_id: env("WHOOP_CLIENT_ID"), client_secret: env("WHOOP_CLIENT_SECRET"),
    });
    await admin.from("whoop_connections").upsert({
      user_id: st.user_id, access_token: t.access_token, refresh_token: t.refresh_token ?? null,
      expires_at: expiry(t.expires_in), scope: t.scope ?? SCOPES, connected_at: new Date().toISOString(), last_error: null,
    });
  } catch (e) {
    console.error("whoop token exchange", e);
    return backTo(st.return_to, "error");
  }
  try { await sync(st.user_id, 30); } catch (e) {
    console.error("whoop first sync", e);
    await admin.from("whoop_connections").update({ last_error: String((e as Error).message).slice(0, 200) }).eq("user_id", st.user_id);
  }
  return backTo(st.return_to, "connected");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  try {
    if (req.method === "GET" && url.pathname.endsWith("/callback")) return await handleCallback(url);
    if (req.method !== "POST") return json({ error: "not_found" }, 404);

    const user = await signedInUser(req);
    if (!user) return json({ error: "unauthorized", message: "Sign in again." }, 401);
    const body = await req.json().catch(() => ({}));
    const { data: conn } = await admin.from("whoop_connections").select("connected_at,last_synced_at,last_error").eq("user_id", user.id).maybeSingle();

    if (body.action === "status") {
      // The Client ID is public (it appears in the WHOOP sign-in link), so it's safe to show for checking.
      const id = env("WHOOP_CLIENT_ID");
      return json({
        configured: configured(), connected: !!conn, last_synced_at: conn?.last_synced_at ?? null, last_error: conn?.last_error ?? null, redirect_uri: REDIRECT_URI,
        client_id: id || null, client_id_looks_right: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
        secret_length: env("WHOOP_CLIENT_SECRET").length,
      });
    }
    if (!configured()) return json({ error: "not_configured", message: "Add WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET in Supabase secrets." }, 503);

    if (body.action === "start") {
      const ret = RETURN_OK.some((re) => re.test(String(body.return_to ?? ""))) ? String(body.return_to) : DEFAULT_RETURN;
      const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
      await admin.from("whoop_oauth_states").delete().lt("created_at", new Date(Date.now() - 3600_000).toISOString());
      await admin.from("whoop_oauth_states").insert({ state, user_id: user.id, return_to: ret });
      const u = new URL(AUTH_URL);
      u.searchParams.set("client_id", env("WHOOP_CLIENT_ID"));
      u.searchParams.set("redirect_uri", REDIRECT_URI);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", SCOPES);
      u.searchParams.set("state", state);
      return json({ url: u.toString() });
    }

    if (body.action === "sync") {
      if (!conn) return json({ error: "not_connected", message: "Connect WHOOP first." }, 409);
      const fresh = conn.last_synced_at && Date.now() - Date.parse(conn.last_synced_at) < 5 * 60_000;
      if (fresh && !body.force) return json({ skipped: true, last_synced_at: conn.last_synced_at });
      const days = Math.min(60, Math.max(2, Number(body.days) || 14));
      try {
        return json(await sync(user.id, days));
      } catch (e) {
        const msg = String((e as Error).message);
        await admin.from("whoop_connections").update({ last_error: msg.slice(0, 200) }).eq("user_id", user.id);
        if (msg === "reconnect") return json({ error: "reconnect", message: "WHOOP access expired. Disconnect and connect WHOOP again." }, 409);
        if (msg === "whoop_busy") return json({ error: "rate_limited", message: "WHOOP is busy. Try again in a minute." }, 429);
        throw e;
      }
    }

    if (body.action === "disconnect") {
      try {
        const token = await accessTokenFor(user.id);
        await fetch(`${API}/v2/user/access`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      } catch (_e) { /* already revoked or expired: still remove it here */ }
      await admin.from("whoop_connections").delete().eq("user_id", user.id);
      await admin.from("whoop_days").delete().eq("user_id", user.id);
      await admin.from("whoop_workouts").delete().eq("user_id", user.id);
      return json({ disconnected: true });
    }

    return json({ error: "bad_request" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "server_error", message: "Couldn't reach WHOOP. Try again." }, 500);
  }
});
