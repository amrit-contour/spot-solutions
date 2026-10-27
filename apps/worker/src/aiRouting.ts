// Which models may answer for an account, in order (docs/fleet.md, "AI policy"). Pure, so it is easy to test.
import { DEFAULT_AI_POLICY, type AiRoute, type AiSettings } from "@spot/shared";

/** Used when a Gemini key exists but the curator picked a local model with no fallback. */
export const IMPLICIT_GEMINI_MODEL = "gemini-2.5-flash";

export class AiPolicyError extends Error {}

/**
 * The routes to try, best first.
 * - local_only: never Gemini, whatever is configured. Only Ollama routes survive; if none, there is nothing to try.
 * - local_first (default): the curator's primary, then their fallback. If they chose a local model with no
 *   fallback and a Gemini key is available, Gemini is added last, so a server without a working local model
 *   still answers.
 */
export function planRoutes(ai: Pick<AiSettings, "primary" | "fallback" | "policy">, hasGeminiKey: boolean): AiRoute[] {
  const policy = ai.policy ?? DEFAULT_AI_POLICY;
  const routes = [ai.primary, ...(ai.fallback ? [ai.fallback] : [])];
  if (policy === "local_only") return routes.filter((r) => r.provider === "ollama");
  if (hasGeminiKey && !routes.some((r) => r.provider === "gemini")) routes.push({ provider: "gemini", model: IMPLICIT_GEMINI_MODEL });
  return routes;
}

/**
 * How long Ollama keeps the model in memory after a call (NBS_OLLAMA_KEEP_ALIVE: "5m", "30s", "0", "-1"...). Short by default, so
 * an idle model gives its memory back and WhatsApp's browser isn't swapped out beside a 9 GB model for hours.
 */
export function ollamaKeepAlive(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  return /^(-1|0|\d+(\.\d+)?(ms|s|m|h))$/.test(v) ? v : "5m";
}
