// Which models may answer for an account, in order (docs/fleet.md, "AI policy"). Pure, so it is easy to test.
import { DEFAULT_AI_POLICY, type AiRoute, type AiSettings } from "@spot/shared";

/** Used when a Gemini key exists but the curator picked a local model with no fallback. */
export const IMPLICIT_GEMINI_MODEL = "gemini-2.5-flash";

export class AiPolicyError extends Error {}

/** Ollama lists `llama3:latest` for a model pulled as `llama3`. */
const canon = (name: string) => (name.includes(":") ? name : `${name}:latest`);
const family = (name: string) => canon(name).split(":")[0].replace(/n$/, "");

export interface Substitution {
  /** The routed model that isn't installed. */
  from: string;
  /** The installed model used instead; null when nothing local is installed (that route is skipped). */
  to: string | null;
}

/**
 * The installed Ollama model to use for `wanted`: itself when installed; else the same family (gemma4:e4b -> gemma4:e2b; gemma3n
 * counts as gemma3), then the first of `prefer` that is installed (the account's own local model, the server's default), then any
 * installed model (smallest name first, so a stable choice). null when nothing is installed.
 */
export function pickInstalledModel(wanted: string, installed: string[], prefer: string[] = []): string | null {
  const have = new Map(installed.map((n) => [canon(n), n]));
  const exact = have.get(canon(wanted));
  if (exact) return exact;
  const sorted = [...installed].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const kin = sorted.find((n) => family(n) === family(wanted));
  if (kin) return kin;
  for (const p of prefer) {
    const hit = have.get(canon(p));
    if (hit) return hit;
  }
  return sorted[0] ?? null;
}

/**
 * The routes to try, best first, and which routed Ollama models were swapped.
 * - `installed`: the models Ollama has right now (null: unknown, or Ollama is down; an empty list means up with nothing installed; routes are left alone so the call fails and
 *   falls through as before). A routed local model that isn't installed is swapped for the best installed one instead of being
 *   called for a 404; with nothing installed that route is skipped.
 * - local_only: never Gemini, whatever is configured. Only Ollama routes survive; if none, there is nothing to try.
 * - local_first (default): the curator's primary, then their fallback. If they chose a local model with no
 *   fallback and a Gemini key is available, Gemini is added last, so a server without a working local model
 *   still answers.
 */
export function planRoutesDetailed(
  ai: Pick<AiSettings, "primary" | "fallback" | "policy">,
  hasGeminiKey: boolean,
  installed?: string[] | null,
  serverDefaultLocal?: string,
): { routes: AiRoute[]; substitutions: Substitution[] } {
  const policy = ai.policy ?? DEFAULT_AI_POLICY;
  let routes: AiRoute[] = [ai.primary, ...(ai.fallback ? [ai.fallback] : [])];
  const substitutions: Substitution[] = [];
  if (installed) {
    const have = new Set(installed.map(canon));
    const prefer = [...routes.filter((r) => r.provider === "ollama" && have.has(canon(r.model))).map((r) => r.model), ...(serverDefaultLocal ? [serverDefaultLocal] : [])];
    routes = routes.flatMap((r): AiRoute[] => {
      if (r.provider !== "ollama" || have.has(canon(r.model))) return [r];
      const to = pickInstalledModel(r.model, installed, prefer);
      substitutions.push({ from: r.model, to });
      return to ? [{ provider: "ollama", model: to }] : [];
    });
    // Two routes can land on the same model: ask it once.
    routes = routes.filter((r, i) => routes.findIndex((x) => x.provider === r.provider && canon(x.model) === canon(r.model)) === i);
  }
  if (policy === "local_only") return { routes: routes.filter((r) => r.provider === "ollama"), substitutions };
  if (hasGeminiKey && !routes.some((r) => r.provider === "gemini")) routes.push({ provider: "gemini", model: IMPLICIT_GEMINI_MODEL });
  return { routes, substitutions };
}

export function planRoutes(ai: Pick<AiSettings, "primary" | "fallback" | "policy">, hasGeminiKey: boolean, installed?: string[] | null, serverDefaultLocal?: string): AiRoute[] {
  return planRoutesDetailed(ai, hasGeminiKey, installed, serverDefaultLocal).routes;
}

/**
 * What the curator is told once when a routed local model isn't installed on their server. `saved`: the setting was changed to `to`.
 * `kept`: they chose to keep it (Undo, or picked on purpose), so nothing was saved and it is substituted only at run time.
 */
export function missingModelText(host: string, from: string, to: string | null, o: { gemini: boolean; localOnly: boolean; saved?: boolean; kept?: boolean }): string {
  const fix = "Install it from the server console's AI models, or pick another model in Settings.";
  if (to && o.kept) return `${from} isn't installed; using ${to} until you install it. Install it from the server console's AI models on ${host}.`;
  if (to && o.saved) return `${from} isn't installed on ${host}, so your model is now ${to}. Change it in Settings → AI.`;
  if (to) return `${from} isn't installed on ${host}, so Nothing BOT used ${to}. ${fix}`;
  if (o.localOnly) return `${from} isn't installed on ${host}, and no other local model is, so nothing could read your messages (AI policy is Local only). ${fix}`;
  return o.gemini ? `${from} isn't installed on ${host}, and no other local model is, so Nothing BOT used Gemini. ${fix}` : `${from} isn't installed on ${host}, and no other local model is, so Nothing BOT couldn't read messages. ${fix}`;
}

const sameName = (a: string, b: string) => canon(a) === canon(b);

/** Has the curator (or the server owner) chosen to keep `model` although it isn't installed? */
export function isKept(model: string, keepMissing?: { model: string } | null, serverKeep?: string | null): boolean {
  return Boolean((keepMissing && sameName(keepMissing.model, model)) || (serverKeep && sameName(serverKeep, model)));
}

/**
 * May the saved setting be changed from `from` to `to`? Only when the model list is fresh and definitely lacks `from`: Ollama up
 * (`installed` not null) and the list non-empty (an empty list is an outage or the wrong models folder, never proof), and `to` is there.
 * Never when the curator chose to keep `from` (`keepMissing`): that is what stops Undo from flip-flopping.
 */
export function canAutoSwitch(installed: string[] | null, from: string, to: string | null, keepMissing?: { model: string } | null): boolean {
  if (!installed || !installed.length || !to) return false;
  if (keepMissing && sameName(keepMissing.model, from)) return false;
  const have = new Set(installed.map(canon));
  return !have.has(canon(from)) && have.has(canon(to));
}

/**
 * What to do about a routed model that isn't installed: `update` is the Firestore write that saves the switch (null: don't save), and
 * `kept` says the curator chose to keep it, so only the notice and the run-time substitution happen.
 */
export function switchDecision(ai: Pick<AiSettings, "primary" | "fallback" | "keepMissing"> | undefined, installed: string[] | null, from: string, to: string | null, meta: { server: string; at: number }, serverKeep?: string | null): { update: Record<string, unknown> | null; kept: boolean } {
  const kept = isKept(from, ai?.keepMissing, serverKeep);
  if (kept || !to || !canAutoSwitch(installed, from, to, ai?.keepMissing)) return { update: null, kept };
  return { update: autoSwitchUpdate(ai, from, to, meta), kept };
}

/** True when the account's keepMissing is spent: the model is now installed (on a fresh, non-empty list), or no route uses it any more. */
export function keepMissingSpent(ai: Pick<AiSettings, "primary" | "fallback" | "keepMissing"> | undefined, installed: string[] | null): boolean {
  const k = ai?.keepMissing;
  if (!k) return false;
  const routed = [ai.primary, ai.fallback].some((r) => r?.provider === "ollama" && sameName(r.model, k.model));
  if (!routed) return true;
  return Boolean(installed && installed.length && installed.some((n) => sameName(n, k.model)));
}

/** Firestore field updates that save the switch, or null when the account's own `ai` doesn't hold `from` (it came from the server default). */
export function autoSwitchUpdate(ai: Pick<AiSettings, "primary" | "fallback"> | undefined, from: string, to: string, meta: { server: string; at: number }): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (ai?.primary?.provider === "ollama" && ai.primary.model === from) out["settings.ai.primary.model"] = to;
  if (ai?.fallback?.provider === "ollama" && ai.fallback.model === from) out["settings.ai.fallback.model"] = to;
  if (!Object.keys(out).length) return null;
  out["settings.ai.autoSwitched"] = { from, to, at: meta.at, server: meta.server };
  return out;
}

/** Id of the one notice per server and model, so `create()` dedupes it (a dismissed notice isn't brought back). */
export const missingModelNoticeId = (serverId: string, model: string, kept = false) => `aimodel-${serverId}-${model}${kept ? "-kept" : ""}`.replace(/[^\w.-]/g, "_").slice(0, 200);

/**
 * How long Ollama keeps the model in memory after a call (NBS_OLLAMA_KEEP_ALIVE: "5m", "30s", "0", "-1"...). Short by default, so
 * an idle model gives its memory back and WhatsApp's browser isn't swapped out beside a 9 GB model for hours.
 */
export function ollamaKeepAlive(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  return /^(-1|0|\d+(\.\d+)?(ms|s|m|h))$/.test(v) ? v : "5m";
}
