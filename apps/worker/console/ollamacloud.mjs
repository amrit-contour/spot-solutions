// "Ollama Cloud" on the server console: the key, URL, model and "Use cloud for", kept in data/ollama-cloud.json (next to power.json).
// The worker re-reads that file by itself (apps/worker/src/llm.ts), and the console restarts it after a save so the change is certain.
// The key is never sent back to the browser: the page only sees its last 4 characters and when it was saved.
// Name and error rules mirror apps/worker/src/ollamaCloud.ts (ollamaCloud.test.ts checks the two agree).

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import path from "node:path";

export const DEFAULT_CLOUD_URL = "https://ollama.com";
export const USES = { primary: "Primary: cloud first, local Ollama as fallback", fallback: "Fallback only: local first, cloud when local is missing or too slow", off: "Off" };
export const KEY_REJECTED = "Ollama rejected the key (401). Check it at ollama.com/settings/keys";
export const NOT_SIGNED_IN =
  "This server's Ollama isn't signed in to ollama.com, so cloud models return 401. Add an API key in Ollama Cloud above (or run `ollama signin` on this machine).";

const NAME_RE = /^[A-Za-z0-9._:/-]{1,100}$/;
// Ollama keys are long opaque strings (hex id + dot + secret today); accept any printable run without spaces.
const KEY_RE = /^[\x21-\x7e]{16,400}$/;

export const isCloudModelName = (name) => /(:cloud|-cloud)$/i.test(String(name ?? "").trim());
export function cloudApiModel(name) {
  const n = String(name ?? "").trim();
  if (/:cloud$/i.test(n)) return n.slice(0, -":cloud".length);
  if (/-cloud$/i.test(n) && n.includes(":")) return n.slice(0, -"-cloud".length);
  return n;
}
export function cloudRouteName(apiName) {
  const n = String(apiName ?? "").trim();
  if (!n || isCloudModelName(n)) return n;
  return n.includes(":") ? `${n}-cloud` : `${n}:cloud`;
}
const hostOf = (url) => /^https?:\/\/(\[[^\]]+\]|[^/:?#]+)/i.exec(String(url ?? "").trim())?.[1]?.toLowerCase() ?? null;
export const isCloudUrl = (url) => /(^|\.)ollama\.com$/.test(hostOf(url) ?? "");
export const trimUrl = (url) => String(url ?? "").trim().replace(/\/+$/, "");
export function validCloudUrl(url) {
  const u = trimUrl(url), h = hostOf(u);
  if (!h) return false;
  return /^https:\/\//i.test(u) || /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(h);
}
export const validKey = (k) => typeof k === "string" && KEY_RE.test(k.trim());
/** Messages for people: never contain the key. */
export const scrub = (msg, key) => (key ? String(msg ?? "").split(key).join("••••") : String(msg ?? "")).slice(0, 300);

/** An Ollama failure in plain words (same rules as the worker). */
export function describeOllamaError({ cloud, model = "", status, body, err, host }) {
  const where = host ?? (cloud ? "ollama.com" : "the local Ollama");
  if (err) {
    const code = err.cause?.code ?? "";
    if (err.name === "TimeoutError" || err.name === "AbortError") return cloud ? `${where} took too long to answer.` : "The local model took too long to answer.";
    if (cloud && /ENOTFOUND|EAI_AGAIN/.test(code)) return `Couldn't look up ${where} (DNS). Check this server's internet connection.`;
    if (cloud && /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|CERT|SSL/.test(code)) return `Couldn't connect to ${where} (${code}). Check this server's internet connection or firewall.`;
    if (cloud) return `Couldn't reach ${where}: ${err.cause?.message ?? err.message ?? "network error"}. Check this server's internet connection.`;
    if (/ECONNREFUSED/.test(code)) return "The local model isn't running. Start Ollama, or use Gemini.";
    return err.message ?? String(err);
  }
  let msg = String(body ?? "").slice(0, 300);
  try { const j = JSON.parse(msg); if (j?.error) msg = j.error; } catch { /* plain text */ }
  if (status === 401 || status === 403) {
    if (cloud) return KEY_REJECTED;
    if (isCloudModelName(model)) return NOT_SIGNED_IN;
  }
  if (status === 404) return cloud ? `${where} doesn't have a model called ${cloudApiModel(model)}. Fetch models and pick one from the list.` : `${model} isn't installed in the local Ollama.`;
  if (status === 429) return `${where} says too many requests (429). Your Ollama plan's limit may be used up; try again later.`;
  return `${cloud ? "Ollama Cloud" : "Ollama"} ${status ?? ""}: ${msg || "no details"}`.trim();
}

/** Writes JSON so a reader sees the old file or the new one, never half of one. Owner-only on Linux and Mac. */
export function writeJsonAtomic(file, data, fs = { writeFileSync, renameSync, mkdirSync, chmodSync }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.renameSync(tmp, file); } catch { fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 }); } // Windows can refuse a rename over an open file
  if (process.platform !== "win32") try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

/**
 * file: data/ollama-cloud.json. readEnv/writeEnv: the worker's .env (an older console put OLLAMA_API_KEY and OLLAMA_URL=https://ollama.com there;
 * the first save moves the key into the file and clears both). live(): the worker's live stats (which key source it uses, accounts' own keys, last 401).
 */
export function createCloud({ file, readEnv, writeEnv, restartWorker, ollamaUrl, live = () => null, localModels = async () => [], now = Date.now, fetchImpl = fetch }) {
  const read = () => { try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}; } catch { return {}; } };
  const legacyKey = () => { const e = readEnv(); return (e.OLLAMA_API_KEY || e.OLLAMA_KEY || "").trim(); };
  /** The key to use: one typed in the page (not saved yet), else the saved one, else one an older console left in .env. */
  const keyFor = (typed) => (validKey(typed) ? typed.trim() : read().key || legacyKey() || "");
  const urlFor = (typed) => (typed && validCloudUrl(typed) ? trimUrl(typed) : validCloudUrl(read().url) ? trimUrl(read().url) : DEFAULT_CLOUD_URL);

  async function view() {
    const c = read(), legacy = !c.key && legacyKey();
    const lv = live()?.ollamaCloud ?? null;
    const key = c.key || legacy || "";
    const local = await localModels().catch(() => []);
    return {
      url: validCloudUrl(c.url) ? trimUrl(c.url) : DEFAULT_CLOUD_URL,
      model: c.model || null,
      use: Object.hasOwn(USES, c.use) ? c.use : "off",
      uses: USES,
      key: key ? { hint: key.slice(-4), savedAt: c.key ? c.savedAt ?? null : null, legacy: Boolean(legacy) } : null,
      // Which key the worker uses: this console's wins; otherwise accounts' own keys from Curate (Settings, AI models).
      source: key ? "server" : lv?.accounts ? "account" : null,
      accountKeys: lv?.accounts ?? 0,
      // A 401 from before the last save is old news (the key was just changed).
      lastError: lv?.lastError && !(c.savedAt > lv.lastErrorAt) ? lv.lastError : null,
      lastErrorAt: lv?.lastError && !(c.savedAt > lv.lastErrorAt) ? lv.lastErrorAt : null,
      // Cloud models pulled into the local Ollama (`beam:cloud`): they only work if that Ollama is signed in, or with a key here.
      localCloudModels: local.filter(isCloudModelName),
    };
  }

  async function save({ url, key, removeKey, model, use } = {}) {
    const c = read();
    const next = { ...c };
    if (url !== undefined) {
      const u = trimUrl(url) || DEFAULT_CLOUD_URL;
      if (!validCloudUrl(u)) throw new Error("The URL must start with https:// (for example https://ollama.com).");
      next.url = u;
    }
    if (removeKey) { delete next.key; }
    else if (typeof key === "string" && key.trim()) {
      const k = key.replace(/\s+/g, "");
      if (!validKey(k)) throw new Error("That doesn't look like an Ollama API key. Copy it again from ollama.com/settings/keys.");
      next.key = k;
    } else if (!next.key && legacyKey()) next.key = legacyKey(); // moved out of .env on the first save
    if (model !== undefined) {
      if (model !== "" && model !== null && !NAME_RE.test(String(model))) throw new Error("That isn't a model name.");
      next.model = model ? cloudApiModel(String(model)) : undefined;
    }
    if (use !== undefined) {
      if (!Object.hasOwn(USES, use)) throw new Error("Pick what to use the cloud for.");
      next.use = use;
    }
    next.savedAt = now();
    writeJsonAtomic(file, Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)));
    // The .env an older console wrote: the key now lives in the file, and OLLAMA_URL must point at the local daemon again.
    const env = readEnv(), patch = {};
    if (env.OLLAMA_API_KEY !== undefined && env.OLLAMA_API_KEY !== "") patch.OLLAMA_API_KEY = "";
    if (env.OLLAMA_KEY !== undefined && env.OLLAMA_KEY !== "") patch.OLLAMA_KEY = "";
    if (isCloudUrl(env.OLLAMA_URL ?? "")) patch.OLLAMA_URL = "";
    if (Object.keys(patch).length) writeEnv(patch);
    let restarted = false;
    try { restarted = (await restartWorker()) === true; } catch { restarted = false; }
    return { ok: true, restarted, view: await view() };
  }

  /** Cloud models from <url>/api/tags (with the key: the list a key can use). */
  async function models({ url, key } = {}) {
    const k = keyFor(key), u = urlFor(url);
    let r;
    try {
      r = await fetchImpl(`${u}/api/tags`, { headers: k ? { authorization: `Bearer ${k}` } : {}, signal: AbortSignal.timeout(15_000) });
    } catch (err) { throw new Error(scrub(describeOllamaError({ cloud: true, err, host: hostOf(u) }), k)); }
    if (!r.ok) throw new Error(scrub(describeOllamaError({ cloud: true, status: r.status, body: await r.text().catch(() => ""), host: hostOf(u) }), k));
    const b = await r.json().catch(() => ({}));
    return (b.models ?? []).map((m) => String(m.name ?? m.model ?? "")).filter(Boolean).sort((a, b2) => a.localeCompare(b2, undefined, { numeric: true }));
  }

  /** A tiny /api/chat with the chosen model: { ms, reply, via }. With a key it goes to the cloud; without one, through the local Ollama (to show the signin case). */
  async function test({ url, key, model } = {}) {
    const m = String(model ?? "").trim();
    if (!NAME_RE.test(m)) throw new Error("Pick a model first.");
    const k = keyFor(key), u = urlFor(url);
    const cloud = Boolean(k);
    const target = cloud ? { url: `${u}/api/chat`, model: cloudApiModel(m), headers: { "content-type": "application/json", authorization: `Bearer ${k}` } }
      : { url: `${trimUrl(ollamaUrl)}/api/chat`, model: cloudRouteName(m), headers: { "content-type": "application/json" } };
    const t = now();
    let r;
    try {
      r = await fetchImpl(target.url, { method: "POST", headers: target.headers, body: JSON.stringify({ model: target.model, stream: false, think: false, options: { temperature: 0, num_predict: 16 }, messages: [{ role: "user", content: "Reply with only the word OK." }] }), signal: AbortSignal.timeout(60_000) });
    } catch (err) { throw new Error(scrub(describeOllamaError({ cloud, model: target.model, err, host: cloud ? hostOf(u) : undefined }), k)); }
    if (!r.ok) throw new Error(scrub(describeOllamaError({ cloud, model: target.model, status: r.status, body: await r.text().catch(() => ""), host: cloud ? hostOf(u) : undefined }), k));
    const b = await r.json().catch(() => ({}));
    return { ms: now() - t, reply: String(b.message?.content ?? "").trim().slice(0, 60), via: cloud ? hostOf(u) : "local Ollama" };
  }

  return { view, save, models, test, read };
}
