// Ollama Cloud next to the local Ollama: which URL a model call goes to, with which auth, and in what order.
// Pure, so it is easy to test. The console has the same rules in console/ollamacloud.mjs (ollamaCloud.test.ts checks they agree).
//
// - Local Ollama is always the local daemon (OLLAMA_URL, default 127.0.0.1:11434) and never gets a key.
// - A cloud model is named the way a local daemon lists one it proxies: `beam:cloud`, `gpt-oss:20b-cloud`. With a key, it is sent
//   straight to <cloudUrl>/api/chat with `Authorization: Bearer <key>` under the name ollama.com uses (`beam`, `gpt-oss:20b`).
//   Without a key it goes to the local daemon, which only answers if it is signed in to ollama.com (`ollama signin`); else 401.
// - Where the key comes from: the server console (data/ollama-cloud.json) wins over the account's own (users/{uid}/secrets/ollamaCloud).
import type { AiPolicy, AiRoute } from "@spot/shared";

export const DEFAULT_LOCAL_OLLAMA = "http://127.0.0.1:11434";
export const DEFAULT_CLOUD_URL = "https://ollama.com";
export type CloudUse = "primary" | "fallback" | "off";

/** data/ollama-cloud.json, written by the server console. */
export interface ServerCloudConfig {
  url?: string;
  key?: string;
  /** The cloud model for automatic use, as ollama.com names it (`beam`) or in route form (`beam:cloud`). */
  model?: string;
  use?: CloudUse;
  savedAt?: number;
}
/** users/{uid}/secrets/ollamaCloud, written by Curate (Settings, AI models). */
export interface AccountCloudSecret {
  key?: string;
  url?: string;
  model?: string;
  savedAt?: number;
}
export interface CloudConfig {
  url: string;
  key: string;
  source: "server" | "account";
  /** For automatic use (primary / fallback); routes that name a cloud model use the cloud whatever this says. */
  model: string | null;
  use: CloudUse;
}

const CLOUD_RE = /(:cloud|-cloud)$/i;
/** `beam:cloud`, `gpt-oss:120b-cloud`: a model that runs on ollama.com, not on this machine. */
export const isCloudModelName = (name: string) => CLOUD_RE.test(String(name ?? "").trim());
/** The name ollama.com's API expects: `beam:cloud` -> `beam`, `gpt-oss:20b-cloud` -> `gpt-oss:20b`. */
export function cloudApiModel(name: string): string {
  const n = String(name ?? "").trim();
  if (/:cloud$/i.test(n)) return n.slice(0, -":cloud".length);
  if (/-cloud$/i.test(n) && n.includes(":")) return n.slice(0, -"-cloud".length);
  return n;
}
/** A name from ollama.com's /api/tags in route form, the way a local daemon would list it: `beam` -> `beam:cloud`, `gpt-oss:20b` -> `gpt-oss:20b-cloud`. */
export function cloudRouteName(apiName: string): string {
  const n = String(apiName ?? "").trim();
  if (!n || isCloudModelName(n)) return n;
  return n.includes(":") ? `${n}-cloud` : `${n}:cloud`;
}

function hostOf(url: string): string | null {
  const m = /^https?:\/\/(\[[^\]]+\]|[^/:?#]+)/i.exec(String(url ?? "").trim());
  return m ? m[1].toLowerCase() : null;
}
/** ollama.com (or a subdomain): the cloud, never the local daemon. */
export const isCloudUrl = (url: string) => /(^|\.)ollama\.com$/.test(hostOf(url) ?? "");
export const trimUrl = (url: string) => String(url ?? "").trim().replace(/\/+$/, "");
/** A URL we would send a key to: https, or plain http only to this machine. */
export function validCloudUrl(url: string): boolean {
  const u = trimUrl(url);
  const h = hostOf(u);
  if (!h) return false;
  return /^https:\/\//i.test(u) || /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(h);
}

/**
 * The local daemon's URL. An older console wrote OLLAMA_URL=https://ollama.com into the worker's .env, which sent every local
 * call (and the key) to the cloud: a cloud URL there is ignored, so local stays local.
 */
export function localOllamaUrl(env: Record<string, string | undefined>): string {
  const u = trimUrl(env.OLLAMA_URL || env.OLLAMA_BASE_URL || "");
  return u && !isCloudUrl(u) ? u : DEFAULT_LOCAL_OLLAMA;
}

const validUse = (u: unknown): u is CloudUse => u === "primary" || u === "fallback" || u === "off";

/**
 * The cloud settings for one account: the server's key wins over the account's. `legacyEnv` is the .env an older console wrote
 * (OLLAMA_API_KEY, maybe OLLAMA_URL=https://ollama.com): honoured as a server key until the console moves it into the file.
 */
export function resolveCloud(server: ServerCloudConfig | null | undefined, account: AccountCloudSecret | null | undefined, legacyEnv: Record<string, string | undefined> = {}): CloudConfig | null {
  const legacyKey = (legacyEnv.OLLAMA_API_KEY || legacyEnv.OLLAMA_KEY || "").trim();
  const legacyUrl = isCloudUrl(legacyEnv.OLLAMA_URL ?? "") ? trimUrl(legacyEnv.OLLAMA_URL!) : "";
  const use: CloudUse = validUse(server?.use) ? server!.use! : "off";
  const model = (server?.model || account?.model || "").trim() || null;
  const pickUrl = (u?: string) => (u && validCloudUrl(u) ? trimUrl(u) : DEFAULT_CLOUD_URL);
  if (server?.key?.trim()) return { url: pickUrl(server.url), key: server.key.trim(), source: "server", model, use };
  if (legacyKey) return { url: pickUrl(server?.url || legacyUrl), key: legacyKey, source: "server", model, use };
  if (account?.key?.trim()) return { url: pickUrl(account.url), key: account.key.trim(), source: "account", model, use };
  return null;
}

export interface OllamaTarget {
  url: string;
  model: string;
  headers: Record<string, string>;
  cloud: boolean;
}
/** Where one Ollama route's call goes: a cloud model with a key straight to the cloud (bearer, API name); anything else to the local daemon, no auth. */
export function ollamaTarget(model: string, localUrl: string, cloud: CloudConfig | null): OllamaTarget {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cloud && isCloudModelName(model)) return { url: `${cloud.url}/api/chat`, model: cloudApiModel(model), headers: { ...headers, authorization: `Bearer ${cloud.key}` }, cloud: true };
  return { url: `${trimUrl(localUrl)}/api/chat`, model, headers, cloud: false };
}

/**
 * The routes with the server's automatic cloud use applied (after planRoutes):
 * - primary: the cloud model goes where the first local route was, and that local route becomes its backup.
 * - fallback: the cloud model goes right after the first local route (or where it would have been, when no local model is installed).
 * - local_only: nothing that runs on ollama.com survives, whatever is configured (chats never leave this machine).
 * `hadLocal`: the account's own settings had a local route (it may have been dropped because nothing is installed).
 */
export function withCloudRoutes(routes: AiRoute[], cloud: CloudConfig | null, policy: AiPolicy | undefined, hadLocal: boolean): AiRoute[] {
  if (policy === "local_only") return routes.filter((r) => !(r.provider === "ollama" && isCloudModelName(r.model)));
  if (!cloud || cloud.use === "off" || !cloud.model || !hadLocal) return routes;
  const c: AiRoute = { provider: "ollama", model: cloudRouteName(cloud.model) };
  const rest = routes.filter((r) => !(r.provider === "ollama" && cloudApiModel(r.model) === cloudApiModel(c.model) && isCloudModelName(r.model)));
  const firstLocal = rest.findIndex((r) => r.provider === "ollama" && !isCloudModelName(r.model));
  const at = firstLocal < 0 ? 0 : cloud.use === "primary" ? firstLocal : firstLocal + 1;
  return [...rest.slice(0, at), c, ...rest.slice(at)];
}

/** How long a local route may take before a cloud fallback behind it gets its turn ("too slow"). NBS_CLOUD_FALLBACK_AFTER_MS overrides. */
export function localTimeoutMs(routes: AiRoute[], i: number, normalMs: number, env: Record<string, string | undefined> = {}): number {
  const r = routes[i];
  if (r?.provider !== "ollama" || isCloudModelName(r.model)) return normalMs;
  const cloudNext = routes.slice(i + 1).some((x) => x.provider === "ollama" && isCloudModelName(x.model));
  if (!cloudNext) return normalMs;
  const cap = Number(env.NBS_CLOUD_FALLBACK_AFTER_MS) || 90_000;
  return Math.min(normalMs, cap);
}

export const NOT_SIGNED_IN =
  "This server's Ollama isn't signed in to ollama.com, so cloud models return 401. Add an API key in Ollama Cloud above (or run `ollama signin` on this machine).";
export const KEY_REJECTED = "Ollama rejected the key (401). Check it at ollama.com/settings/keys";

/** An Ollama failure in plain words. `target` says whether the call went to the cloud; `status`/`body` from the HTTP answer, or `err` from fetch. */
export function describeOllamaError(o: { cloud: boolean; model: string; status?: number; body?: string; err?: unknown; host?: string }): string {
  const host = o.host ?? (o.cloud ? "ollama.com" : "the local Ollama");
  if (o.err) {
    const e = o.err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    const code = e.cause?.code ?? "";
    if (e.name === "TimeoutError" || e.name === "AbortError") return o.cloud ? `${host} took too long to answer.` : "The local model took too long to answer.";
    if (o.cloud && /ENOTFOUND|EAI_AGAIN/.test(code)) return `Couldn't look up ${host} (DNS). Check this server's internet connection.`;
    if (o.cloud && /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|CERT|SSL/.test(code)) return `Couldn't connect to ${host} (${code}). Check this server's internet connection or firewall.`;
    if (o.cloud) return `Couldn't reach ${host}: ${e.cause?.message ?? e.message ?? "network error"}. Check this server's internet connection.`;
    if (/ECONNREFUSED/.test(code)) return "The local model isn't running. Start Ollama, or use Gemini.";
    return e.message ?? String(o.err);
  }
  let msg = String(o.body ?? "").slice(0, 300);
  try { const j = JSON.parse(msg) as { error?: string }; if (j?.error) msg = j.error; } catch { /* plain text */ }
  if (o.status === 401 || o.status === 403) {
    if (o.cloud) return KEY_REJECTED;
    if (isCloudModelName(o.model)) return NOT_SIGNED_IN;
  }
  if (o.status === 404) return o.cloud ? `${host} doesn't have a model called ${cloudApiModel(o.model)}. Fetch models and pick one from the list.` : `${o.model} isn't installed in the local Ollama.`;
  if (o.status === 429) return `${host} says too many requests (429). Your Ollama plan's limit may be used up; try again later.`;
  return `${o.cloud ? "Ollama Cloud" : "Ollama"} ${o.status ?? ""}: ${msg || "no details"}`.trim();
}
