// One door to every model: route a JSON-producing prompt to the curator's primary model,
// falling back to their second choice if it fails. Ollama is local; Gemini uses the curator's
// own key (from users/{uid}/secrets/ai), or the server's GEMINI_API_KEY if they have none.
import { GoogleGenAI } from "@google/genai";
import { DEFAULT_AI_POLICY, type AiRoute, type AiSettings } from "@spot/shared";
import { col } from "./firebase.ts";
import { counters, live } from "./stats.ts";
import { AiPolicyError, IMPLICIT_GEMINI_MODEL, planRoutes } from "./aiRouting.ts";

export const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
// Slow laptops (an old i5 with 8 GB) can take a few minutes on a cold model. Waiting longer beats failing: messages are
// read in the background, and a failed read is retried anyway (intake.ts). NBS_OLLAMA_TIMEOUT_MS overrides.
const OLLAMA_TIMEOUT_MS = Number(process.env.NBS_OLLAMA_TIMEOUT_MS ?? process.env.OLLAMA_TIMEOUT_MS ?? 300_000);
const GEMINI_TIMEOUT_MS = 30_000;
const SERVER_GEMINI_KEY = process.env.GEMINI_API_KEY || null;
/** Set by the installers for Gemini-only servers. */
export const NO_LOCAL_MODEL = /^(1|true|yes)$/i.test(process.env.NBS_NO_LOCAL_MODEL ?? "");
export const hasServerGeminiKey = Boolean(SERVER_GEMINI_KEY);

type Schema = Record<string, unknown>;

// ---- keys: watched live so a key added in the app works without a restart ----
const keys = new Map<string, string | null>();
const keyWatch = new Map<string, () => void>();
export function watchKeys(uid: string) {
  if (keyWatch.has(uid)) return;
  keyWatch.set(
    uid,
    col(uid, "secrets")
      .doc("ai")
      .onSnapshot((s) => keys.set(uid, (s.data()?.geminiKey as string | undefined) || null)),
  );
}
export function unwatchKeys(uid: string) {
  keyWatch.get(uid)?.();
  keyWatch.delete(uid);
  keys.delete(uid);
}
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

async function ollama(model: string, prompt: string, schema: Schema, temperature = 0) {
  if (NO_LOCAL_MODEL) throw new Error("This server has no local model (Gemini-only)");
  const call = (structured: boolean) =>
    fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        ...(structured ? { format: schema } : {}),
        keep_alive: "24h",
        options: { temperature },
        messages: [{ role: "user", content: prompt }],
      }),
    });
  let res = await call(!noSchema.has(model));
  if (res.status === 501 && !noSchema.has(model)) {
    noSchema.add(model);
    res = await call(false);
  }
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { message: { content: string } }).message.content;
}

async function gemini(uid: string | null, model: string, prompt: string, schema: Schema, temperature = 0) {
  const ai = geminiFor(uid);
  // Gemma models on the Gemini API don't take a response schema; Gemini models do.
  const structured = !model.startsWith("gemma");
  const res = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      temperature,
      abortSignal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      ...(structured ? { responseMimeType: "application/json", responseJsonSchema: schema } : {}),
    },
  });
  return res.text ?? "";
}

function run(uid: string | null, route: AiRoute, prompt: string, schema: Schema, temperature?: number) {
  return route.provider === "gemini" ? gemini(uid, route.model, prompt, schema, temperature) : ollama(route.model, prompt, schema, temperature);
}

// Local models run one generation at a time, so queue everything to avoid timeouts in bursts.
let gate: Promise<unknown> = Promise.resolve();

/** Run a prompt that must answer in JSON. Returns the raw text and which model produced it. */
/** `temperature` above 0 for writing (voice drafts); classification stays at 0. */
export function generateJson(uid: string | null, ai: AiSettings, prompt: string, schema: Schema, opts: { temperature?: number } = {}) {
  const task = gate.catch(() => undefined).then(async () => {
    // The account's AI policy decides which routes exist at all (local_only never reaches Gemini).
    const routes = planRoutes(ai, Boolean((uid && keys.get(uid)) || SERVER_GEMINI_KEY));
    if (!routes.length) {
      counters.errors++;
      live.noteError();
      throw new AiPolicyError("AI policy is Local only, but no local model is selected for this account.");
    }
    let last: unknown;
    for (const [i, route] of routes.entries()) {
      const t0 = Date.now();
      try {
        const text = await run(uid, route, prompt, schema, opts.temperature);
        counters.classified++;
        live.noteAi(route.provider, Date.now() - t0, i > 0);
        return { text, model: `${route.provider}/${route.model}` };
      } catch (err) {
        last = err;
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
  const res = await fetch(`${OLLAMA_URL}/api/pull`, { method: "POST", body: JSON.stringify({ model, stream: false }), signal: AbortSignal.timeout(60 * 60_000) });
  if (!res.ok) throw new Error(`pull failed: ${(await res.text()).slice(0, 200)}`);
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
