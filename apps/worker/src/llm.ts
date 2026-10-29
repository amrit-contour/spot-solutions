// One door to every model: route a JSON-producing prompt to the curator's primary model,
// falling back to their second choice if it fails. Ollama is local; Gemini uses the curator's
// own key (from users/{uid}/secrets/ai), or the server's GEMINI_API_KEY if they have none.
import { GoogleGenAI } from "@google/genai";
import { AI_INTERACTIVE_DEADLINE_MS, DEFAULT_AI_POLICY, TTL_DAYS, aiFailureMessage, routeBudgetMs, type AiRoute, type AiSettings } from "@spot/shared";
import { FieldValue, col, expireAt, userRef } from "./firebase.ts";
import { counters, live } from "./stats.ts";
import os from "node:os";
import { AiPolicyError, IMPLICIT_GEMINI_MODEL, canAutoSwitch, isKept, keepMissingSpent, missingModelNoticeId, missingModelText, ollamaKeepAlive, planRoutes, planRoutesDetailed, switchDecision, type Substitution } from "./aiRouting.ts";
import { DEFAULT_LOCAL_MODEL } from "./serverAi.ts";
import { DATA_DIR, SERVER_ID } from "./serverIdentity.ts";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { cloudRouteName, describeOllamaError, isCloudModelName, localOllamaUrl, localTimeoutMs, ollamaTarget, resolveCloud, withCloudRoutes, type AccountCloudSecret, type CloudConfig, type ServerCloudConfig } from "./ollamaCloud.ts";

/** The local daemon only, never a cloud URL (an older console wrote OLLAMA_URL=https://ollama.com here; see ollamaCloud.ts). No key is ever sent to it. */
export const OLLAMA_URL = localOllamaUrl(process.env);
// Slow laptops (an old i5 with 8 GB) can take a few minutes on a cold model. Waiting longer beats failing: messages are
// read in the background, and a failed read is retried anyway (intake.ts). NBS_OLLAMA_TIMEOUT_MS overrides.
const OLLAMA_TIMEOUT_MS = Number(process.env.NBS_OLLAMA_TIMEOUT_MS ?? process.env.OLLAMA_TIMEOUT_MS ?? 300_000);
const KEEP_ALIVE = ollamaKeepAlive(process.env.NBS_OLLAMA_KEEP_ALIVE);
const GEMINI_TIMEOUT_MS = 45_000;
const SERVER_GEMINI_KEY = process.env.GEMINI_API_KEY || null;
/** Set by the installers for Gemini-only servers. */
export const NO_LOCAL_MODEL = /^(1|true|yes)$/i.test(process.env.NBS_NO_LOCAL_MODEL ?? "");
export const hasServerGeminiKey = Boolean(SERVER_GEMINI_KEY);

type Schema = Record<string, unknown>;

// ---- keys: watched live so a key added in the app works without a restart ----
const keys = new Map<string, string | null>();
// Ollama Cloud key from Curate (users/{uid}/secrets/ollamaCloud). The server console's key wins over it (resolveCloud).
const cloudKeys = new Map<string, AccountCloudSecret | null>();
const keyWatch = new Map<string, () => void>();
export function watchKeys(uid: string) {
  if (keyWatch.has(uid)) return;
  const offAi = col(uid, "secrets")
    .doc("ai")
    .onSnapshot((s) => keys.set(uid, (s.data()?.geminiKey as string | undefined) || null));
  const offCloud = col(uid, "secrets")
    .doc("ollamaCloud")
    .onSnapshot(
      (s) => cloudKeys.set(uid, (s.data() as AccountCloudSecret | undefined) ?? null),
      (e) => console.warn(`[llm] couldn't watch ${uid}'s Ollama Cloud key:`, e.message),
    );
  keyWatch.set(uid, () => { offAi(); offCloud(); });
}
export function unwatchKeys(uid: string) {
  keyWatch.get(uid)?.();
  keyWatch.delete(uid);
  keys.delete(uid);
  cloudKeys.delete(uid);
}

// ---- Ollama Cloud: the server console's settings (data/ollama-cloud.json), re-read when the file changes ----
// Next to power.json in the data folder (WWEBJS_DATA is <data>/wwebjs on every installer).
const CLOUD_FILE = process.env.NBS_OLLAMA_CLOUD_FILE || path.join(process.env.NBS_DATA_DIR || path.dirname(DATA_DIR), "ollama-cloud.json");
let serverCloud: { cfg: ServerCloudConfig | null; mtime: number; checkedAt: number } = { cfg: null, mtime: -1, checkedAt: 0 };
function serverCloudConfig(): ServerCloudConfig | null {
  if (Date.now() - serverCloud.checkedAt < 5_000) return serverCloud.cfg;
  serverCloud.checkedAt = Date.now();
  try {
    const m = statSync(CLOUD_FILE).mtimeMs;
    if (m !== serverCloud.mtime) serverCloud = { cfg: JSON.parse(readFileSync(CLOUD_FILE, "utf8")) as ServerCloudConfig, mtime: m, checkedAt: Date.now() };
  } catch {
    serverCloud = { cfg: null, mtime: -1, checkedAt: Date.now() };
  }
  return serverCloud.cfg;
}
/** The Ollama Cloud settings this account's calls use, or null (no key anywhere). */
export function cloudFor(uid: string | null): CloudConfig | null {
  return resolveCloud(serverCloudConfig(), uid ? cloudKeys.get(uid) : null, process.env);
}
/** For the console (live stats): which key source is in use here, and how many accounts brought their own. */
export function cloudSummary() {
  const server = resolveCloud(serverCloudConfig(), null, process.env);
  const accounts = [...cloudKeys.values()].filter((v) => v?.key).length;
  return { source: server ? ("server" as const) : accounts ? ("account" as const) : null, accounts, keyHint: server ? server.key.slice(-4) : null };
}
live.setCloudInfo(cloudSummary);

const clients = new Map<string, GoogleGenAI>();
function geminiFor(uid: string | null) {
  const key = (uid && keys.get(uid)) || SERVER_GEMINI_KEY;
  if (!key) throw new Error("No Gemini API key. Add one in Settings → AI models.");
  let c = clients.get(key);
  if (!c) clients.set(key, (c = new GoogleGenAI({ apiKey: key })));
  return c;
}

// ---- providers ----
const noSchema = new Set<string>(); // Ollama models that reject JSON-schema output

async function ollama(model: string, prompt: string, schema: Schema, temperature = 0, timeoutMs = OLLAMA_TIMEOUT_MS, cloud: CloudConfig | null = null) {
  const t = ollamaTarget(model, OLLAMA_URL, cloud);
  if (NO_LOCAL_MODEL && !t.cloud) throw new Error("This server has no local model (Gemini-only)");
  const key = `${t.cloud ? "cloud" : "local"}|${t.model}`;
  const call = (structured: boolean) =>
    fetch(t.url, {
      method: "POST",
      headers: t.headers,
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: t.model,
        stream: false,
        think: false,
        ...(structured ? { format: schema } : {}),
        // keep_alive only means something to a local daemon
        ...(t.cloud ? {} : { keep_alive: KEEP_ALIVE }),
        options: { temperature },
        messages: [{ role: "user", content: prompt }],
      }),
    });
  let res: Response;
  try {
    res = await call(!noSchema.has(key));
    if ((res.status === 501 || (t.cloud && res.status === 400)) && !noSchema.has(key)) {
      noSchema.add(key);
      res = await call(false);
    }
  } catch (err) {
    throw new Error(describeOllamaError({ cloud: t.cloud, model, err }), { cause: err });
  }
  if (!res.ok) {
    const msg = describeOllamaError({ cloud: t.cloud, model, status: res.status, body: await res.text().catch(() => "") });
    if (res.status === 401 || res.status === 403) noteCloudAuth(msg, model);
    throw new Error(msg);
  }
  return ((await res.json()) as { message: { content: string } }).message.content;
}
// A 401 from the cloud (bad key) or from a local daemon proxying a cloud model (not signed in): logged once an hour, shown in the console.
let authLoggedAt = 0;
function noteCloudAuth(msg: string, model: string) {
  live.noteCloudError(msg);
  if (Date.now() - authLoggedAt < 3600_000) return;
  authLoggedAt = Date.now();
  console.warn(`[llm] ollama/${model}: ${msg}`);
}

async function gemini(uid: string | null, model: string, prompt: string, schema: Schema, temperature = 0, timeoutMs = GEMINI_TIMEOUT_MS) {
  const ai = geminiFor(uid);
  // Gemma models on the Gemini API don't take a response schema; Gemini models do.
  const structured = !model.startsWith("gemma");
  const res = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      temperature,
      abortSignal: AbortSignal.timeout(timeoutMs),
      ...(structured ? { responseMimeType: "application/json", responseJsonSchema: schema } : {}),
    },
  });
  return res.text ?? "";
}

function run(uid: string | null, route: AiRoute, prompt: string, schema: Schema, temperature?: number, timeoutMs?: number) {
  return route.provider === "gemini" ? gemini(uid, route.model, prompt, schema, temperature, timeoutMs) : ollama(route.model, prompt, schema, temperature, timeoutMs, cloudFor(uid));
}

// ---- which Ollama models exist: cached, refreshed about every minute (the heartbeat and pulls refresh it too) ----
const INSTALLED_TTL_MS = 60_000;
let installedCache: { names: string[] | null; at: number } = { names: null, at: 0 };
let installedRefresh: Promise<unknown> | null = null;
/** Installed model names; null when unknown (Ollama down, or a Gemini-only server): routes are then left as configured. */
async function installedModels(): Promise<string[] | null> {
  if (NO_LOCAL_MODEL) return null;
  if (Date.now() - installedCache.at > INSTALLED_TTL_MS) await (installedRefresh ??= ollamaState().finally(() => (installedRefresh = null)));
  return installedCache.names;
}
/** Tests: forget what was cached. */
export const resetInstalledCache = () => (installedCache = { names: null, at: 0 });

// A routed model that isn't installed is logged once per model per hour, and the curator is told once (a notice).
const LOG_EVERY_MS = 3600_000;
const loggedAt = new Map<string, number>();
const told = new Set<string>();
async function noteSubstitution(uid: string | null, s: Substitution, routes: AiRoute[], localOnly: boolean, installed: string[] | null, ai: AiSettings) {
  const key = `${s.from}->${s.to ?? "none"}`;
  if (Date.now() - (loggedAt.get(key) ?? 0) >= LOG_EVERY_MS) {
    loggedAt.set(key, Date.now());
    console.warn(`[llm] ollama/${s.from} isn't installed; ${s.to ? `using ollama/${s.to}` : routes.length ? `no local model installed, using ${routes[0].provider}/${routes[0].model}` : "no local model installed and nothing else to try"}`);
  }
  live.noteMissingModel(s.from, s.to);
  if (!uid) return;
  const host = os.hostname();
  const serverKeep = process.env.NBS_LOCAL_MODEL_KEEP?.replace(/@\d+$/, "") || null;
  // Save the working model as the setting so this never recurs, but only on a fresh, non-empty list that lacks the model, and never
  // over a model the curator chose to keep (Undo, or picked on purpose): that is only substituted here, at run time.
  let saved = false;
  let kept = isKept(s.from, ai.keepMissing, serverKeep);
  if (!kept && !told.has(`${uid}|${key}`) && s.to && canAutoSwitch(installed, s.from, s.to)) {
    try {
      const doc = await userRef(uid).get();
      const fresh = (doc.data()?.settings as { ai?: AiSettings } | undefined)?.ai;
      const d = switchDecision(fresh, installed, s.from, s.to, { server: host, at: Date.now() }, serverKeep);
      kept = d.kept;
      if (d.update) {
        await userRef(uid).update(d.update);
        saved = true;
        console.warn(`[llm] saved ollama/${s.to} as ${uid}'s model (was ollama/${s.from}, not installed on ${host})`);
      }
    } catch (e) {
      console.warn("[llm] couldn't save the model switch:", (e as Error).message);
    }
  }
  const told1 = `${uid}|${key}|${kept ? "kept" : ""}`;
  if (told.has(told1)) return;
  told.add(told1);
  told.add(`${uid}|${key}`);
  const text = missingModelText(host, s.from, s.to, { gemini: routes.some((r) => r.provider === "gemini"), localOnly, saved, kept });
  await col(uid, "notices")
    .doc(missingModelNoticeId(SERVER_ID, s.from, kept))
    .create({ level: "warn", kind: "server", text, createdAt: Date.now(), read: false, expireAt: expireAt(TTL_DAYS.notices), link: "/settings", linkLabel: saved ? "Pick another" : "AI models" })
    .catch(() => undefined); // already told (ALREADY_EXISTS), or a write failure: the log line has it
}

// keepMissing is spent once the model is installed or no route uses it: forget it (once per account until it is set again).
const keepCleared = new Set<string>();
function clearSpentKeep(uid: string | null, ai: AiSettings, installed: string[] | null) {
  if (!uid || !ai.keepMissing || keepCleared.has(`${uid}|${ai.keepMissing.at}`) || !keepMissingSpent(ai, installed)) return;
  keepCleared.add(`${uid}|${ai.keepMissing.at}`);
  userRef(uid).update({ "settings.ai.keepMissing": FieldValue.delete() }).catch(() => keepCleared.delete(`${uid}|${ai.keepMissing?.at}`));
}

// Local models run one generation at a time, so queue everything to avoid timeouts in bursts.
let gate: Promise<unknown> = Promise.resolve();

/** Run a prompt that must answer in JSON. Returns the raw text and which model produced it. */
/** `temperature` above 0 for writing (voice drafts); classification stays at 0. */
/**
 * `interactive`: someone is waiting (Messages summary, a drafted reply). The whole job, queue wait included, has
 * AI_INTERACTIVE_DEADLINE_MS; each route gets its own cap of what is left (a local model times out in time for Gemini to try),
 * `onStage` hears what is happening, and a timeout is reported in plain words.
 */
export function generateJson(uid: string | null, ai: AiSettings, prompt: string, schema: Schema, opts: { temperature?: number; interactive?: boolean; onStage?: (s: string) => void } = {}) {
  const deadlineAt = Date.now() + AI_INTERACTIVE_DEADLINE_MS;
  if (opts.interactive) opts.onStage?.("Waiting for the model…");
  const task = gate.catch(() => undefined).then(async () => {
    // The account's AI policy decides which routes exist at all (local_only never reaches Gemini).
    const installed = await installedModels();
    const planned = planRoutesDetailed(ai, Boolean((uid && keys.get(uid)) || SERVER_GEMINI_KEY), installed, process.env.NBS_LOCAL_MODEL || DEFAULT_LOCAL_MODEL);
    const { substitutions } = planned;
    // Ollama Cloud: the server's "Use cloud for" (primary / fallback) slots the cloud model in; local_only drops anything on ollama.com.
    const hadLocal = [ai.primary, ai.fallback].some((r) => r?.provider === "ollama" && !isCloudModelName(r.model));
    const routes = withCloudRoutes(planned.routes, cloudFor(uid), ai.policy ?? DEFAULT_AI_POLICY, hadLocal);
    clearSpentKeep(uid, ai, installed);
    for (const s of substitutions) void noteSubstitution(uid, s, routes, (ai.policy ?? DEFAULT_AI_POLICY) === "local_only", installed, ai);
    if (!routes.length) {
      counters.errors++;
      live.noteError();
      throw new AiPolicyError("AI policy is Local only, but no local model is selected for this account.");
    }
    let last: unknown;
    for (const [i, route] of routes.entries()) {
      const t0 = Date.now();
      const cloudRoute = route.provider === "ollama" && isCloudModelName(route.model);
      // A cloud call gets the cloud's budget; a local one in front of a cloud fallback gets a shorter leash ("too slow").
      const budget = opts.interactive ? routeBudgetMs(cloudRoute ? "gemini" : route.provider, deadlineAt, t0) : route.provider === "ollama" ? localTimeoutMs(routes, i, OLLAMA_TIMEOUT_MS, process.env) : undefined;
      if (opts.interactive && !budget) {
        last = last ?? new Error("The model took too long. Try again.");
        break;
      }
      opts.interactive && opts.onStage?.(cloudRoute ? "Writing… (Ollama Cloud)" : route.provider === "ollama" ? "Writing… (local model)" : "Writing… (Gemini)");
      try {
        const text = await run(uid, route, prompt, schema, opts.temperature, budget);
        counters.classified++;
        live.noteAi(route.provider, Date.now() - t0, i > 0);
        return { text, model: `${route.provider}/${route.model}` };
      } catch (err) {
        last = cloudRoute ? err : new Error(aiFailureMessage(route.provider, err), { cause: err });
        live.noteAiFail();
        const next = routes[i + 1];
        if (next) console.warn(`[llm] ${route.provider}/${route.model} failed, trying ${next.provider}/${next.model}:`, (err as Error).message);
      }
    }
    counters.errors++;
    live.noteError();
    throw last;
  });
  gate = task;
  return task;
}

/** A PDF or picture to JSON. Only Gemini reads these (the local Gemma is text-only), so the account's AI policy has to allow the cloud. */
const GEMINI_FILE_TIMEOUT_MS = 90_000;
export async function generateJsonFromFile(uid: string | null, ai: AiSettings, prompt: string, schema: Schema, file: { mime: string; data: string }) {
  const what = file.mime === "application/pdf" ? "PDFs" : "Images";
  if ((ai.policy ?? DEFAULT_AI_POLICY) === "local_only") {
    throw new AiPolicyError(`${what} need Gemini, and this account's AI policy is Local only. Paste the text instead, or change the policy in Settings → AI models.`);
  }
  if (!((uid && keys.get(uid)) || SERVER_GEMINI_KEY)) throw new AiPolicyError(`${what} need Gemini: add a key in Settings → AI models.`);
  // Gemma on the Gemini API can't see files; use the account's Gemini model, or the default one.
  const route = planRoutes(ai, true).find((r) => r.provider === "gemini" && !r.model.startsWith("gemma"));
  const model = route?.model ?? IMPLICIT_GEMINI_MODEL;
  const t0 = Date.now();
  try {
    const res = await geminiFor(uid).models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: file.mime, data: file.data } }] }],
      config: { temperature: 0, abortSignal: AbortSignal.timeout(GEMINI_FILE_TIMEOUT_MS), responseMimeType: "application/json", responseJsonSchema: schema },
    });
    counters.classified++;
    live.noteAi("gemini", Date.now() - t0, false);
    return { text: res.text ?? "", model: `gemini/${model}` };
  } catch (err) {
    counters.errors++;
    live.noteAiFail();
    live.noteError();
    throw err;
  }
}

export async function ollamaState() {
  const r = await readOllamaState();
  installedCache = { names: r.up ? r.models.map((m) => m.name) : null, at: Date.now() };
  return r;
}
async function readOllamaState() {
  // Gemini-only servers (NBS_NO_LOCAL_MODEL=1) have no Ollama at all: answer at once, no network call.
  if (NO_LOCAL_MODEL) return { up: false, models: [], loaded: [] as string[] };
  try {
    const [tags, ps] = await Promise.all([
      fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json() as Promise<{ models: { name: string; size: number }[] }>),
      fetch(`${OLLAMA_URL}/api/ps`, { signal: AbortSignal.timeout(3000) })
        .then((r) => r.json() as Promise<{ models: { name: string }[] }>)
        .catch(() => ({ models: [] })),
    ]);
    return { up: true, models: (tags.models ?? []).map((m) => ({ name: m.name, size: m.size })), loaded: ps.models.map((m) => m.name) };
  } catch {
    return { up: false, models: [], loaded: [] as string[] };
  }
}

/** Download a model into Ollama (used by the "Pull" button in the app). */
export async function ollamaPull(model: string) {
  if (NO_LOCAL_MODEL) throw new Error("This server runs without a local model (Gemini-only)");
  const res = await fetch(`${OLLAMA_URL}/api/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, stream: false }), signal: AbortSignal.timeout(60 * 60_000) });
  if (!res.ok) throw new Error(`pull failed: ${(await res.text()).slice(0, 200)}`);
}

/**
 * Cloud models this account can pick (route form: `beam:cloud`), from <cloudUrl>/api/tags. Empty when no key is set for it
 * (server console or Curate) or the cloud can't be reached; `error` then says why.
 */
export async function listCloudModels(uid: string | null): Promise<{ models: string[]; source: CloudConfig["source"] | null; error?: string }> {
  const cloud = cloudFor(uid);
  if (!cloud) return { models: [], source: null };
  try {
    const res = await fetch(`${cloud.url}/api/tags`, { headers: { authorization: `Bearer ${cloud.key}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { models: [], source: cloud.source, error: describeOllamaError({ cloud: true, model: "", status: res.status, body: await res.text().catch(() => "") }) };
    const body = (await res.json()) as { models?: { name: string }[] };
    return { models: (body.models ?? []).map((m) => cloudRouteName(m.name)).filter(Boolean), source: cloud.source };
  } catch (err) {
    return { models: [], source: cloud.source, error: describeOllamaError({ cloud: true, model: "", err }) };
  }
}

/** Quick end-to-end check of a route: does it answer with JSON? */
export async function testRoute(uid: string, route: AiRoute) {
  const t = Date.now();
  const text = await run(uid, route, 'Reply ONLY with this JSON: {"ok": true}', { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] });
  if (!text.includes("true")) throw new Error(`Unexpected reply: ${text.slice(0, 120)}`);
  return { ms: Date.now() - t };
}

/** Text-capable Gemini/Gemma models this curator's key can use, newest first. */
export async function listGeminiModels(uid: string) {
  const key = keys.get(uid) || SERVER_GEMINI_KEY;
  if (!key) throw new Error("Add a Gemini key first");
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(15_000) });
  const body = (await res.json().catch(() => ({}))) as { models?: { name: string; supportedGenerationMethods?: string[] }[]; error?: { message?: string } };
  if (!res.ok) throw new Error(body.error?.message ?? `Gemini said ${res.status}`);
  return (body.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => /^(gemini|gemma)/.test(n) && !/(embedding|image|imagen|veo|tts|audio|live|vision|aqa|learnlm)/.test(n))
    .sort((a, b) => Number(b.startsWith("gemini")) - Number(a.startsWith("gemini")) || b.localeCompare(a, undefined, { numeric: true }));
}
