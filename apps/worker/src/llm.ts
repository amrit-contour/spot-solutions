// One door to every model: route a JSON-producing prompt to the curator's primary model,
// falling back to their second choice if it fails. Ollama is local; Gemini uses the curator's
// own key (from users/{uid}/secrets/ai), or the server's GEMINI_API_KEY if they have none.
import { GoogleGenAI } from "@google/genai";
import type { AiRoute, AiSettings } from "@spot/shared";
import { col } from "./firebase.ts";
import { counters } from "./stats.ts";

export const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 90_000);
const GEMINI_TIMEOUT_MS = 30_000;
const SERVER_GEMINI_KEY = process.env.GEMINI_API_KEY || null;
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

async function ollama(model: string, prompt: string, schema: Schema) {
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
        options: { temperature: 0 },
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

async function gemini(uid: string | null, model: string, prompt: string, schema: Schema) {
  const ai = geminiFor(uid);
  // Gemma models on the Gemini API don't take a response schema; Gemini models do.
  const structured = !model.startsWith("gemma");
  const res = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      temperature: 0,
      abortSignal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      ...(structured ? { responseMimeType: "application/json", responseJsonSchema: schema } : {}),
    },
  });
  return res.text ?? "";
}

function run(uid: string | null, route: AiRoute, prompt: string, schema: Schema) {
  return route.provider === "gemini" ? gemini(uid, route.model, prompt, schema) : ollama(route.model, prompt, schema);
}

// Local models run one generation at a time, so queue everything to avoid timeouts in bursts.
let gate: Promise<unknown> = Promise.resolve();

/** Run a prompt that must answer in JSON. Returns the raw text and which model produced it. */
export function generateJson(uid: string | null, ai: AiSettings, prompt: string, schema: Schema) {
  const task = gate.catch(() => undefined).then(async () => {
    try {
      const text = await run(uid, ai.primary, prompt, schema);
      counters.classified++;
      return { text, model: `${ai.primary.provider}/${ai.primary.model}` };
    } catch (err) {
      if (!ai.fallback) {
        counters.errors++;
        throw err;
      }
      console.warn(`[llm] ${ai.primary.provider}/${ai.primary.model} failed, trying ${ai.fallback.provider}/${ai.fallback.model}:`, (err as Error).message);
      try {
        const text = await run(uid, ai.fallback, prompt, schema);
        counters.classified++;
        return { text, model: `${ai.fallback.provider}/${ai.fallback.model}` };
      } catch (e2) {
        counters.errors++;
        throw e2;
      }
    }
  });
  gate = task;
  return task;
}

export async function ollamaState() {
  try {
    const [tags, ps] = await Promise.all([
      fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json() as Promise<{ models: { name: string; size: number }[] }>),
      fetch(`${OLLAMA_URL}/api/ps`, { signal: AbortSignal.timeout(3000) })
        .then((r) => r.json() as Promise<{ models: { name: string }[] }>)
        .catch(() => ({ models: [] })),
    ]);
    return { up: true, models: tags.models.map((m) => ({ name: m.name, size: m.size })), loaded: ps.models.map((m) => m.name) };
  } catch {
    return { up: false, models: [], loaded: [] as string[] };
  }
}

/** Download a model into Ollama (used by the "Pull" button in the app). */
export async function ollamaPull(model: string) {
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
