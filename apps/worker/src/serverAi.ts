// The server's default AI routing, set in the server console (AI models) and stored in the worker's .env:
//   NBS_AI_MODE   local_first | gemini_first | gemini_only | local_only   (unset: leave curators' defaults alone)
//   NBS_LOCAL_MODEL, NBS_GEMINI_MODEL   which model each side uses
// It applies only to curators who have never saved AI settings of their own; their choice in the app always wins.
import type { AiRoute, AiSettings } from "@spot/shared";
import { IMPLICIT_GEMINI_MODEL } from "./aiRouting.ts";

export const DEFAULT_LOCAL_MODEL = "gemma3:4b";

export function serverAiDefault(env: Record<string, string | undefined>, noLocal: boolean): AiSettings | null {
  const mode = env.NBS_AI_MODE;
  if (!mode) return null;
  const local: AiRoute = { provider: "ollama", model: env.NBS_LOCAL_MODEL || DEFAULT_LOCAL_MODEL };
  const gemini: AiRoute = { provider: "gemini", model: env.NBS_GEMINI_MODEL || IMPLICIT_GEMINI_MODEL };
  // A server without a local model can only answer with Gemini, whatever was picked.
  if (noLocal && mode !== "local_only") return { primary: gemini, fallback: null };
  switch (mode) {
    case "local_first":
      return { primary: local, fallback: gemini };
    case "gemini_first":
      return { primary: gemini, fallback: local };
    case "gemini_only":
      return { primary: gemini, fallback: null };
    case "local_only":
      return { primary: local, fallback: null, policy: "local_only" };
    default:
      return null;
  }
}

/** For settings docs with no AI choice of their own (neither `ai` nor the older `model`), the server's default if one is set. */
export function defaultAiFor(data: { ai?: { primary?: unknown; policy?: AiSettings["policy"] }; model?: unknown } | undefined): AiSettings | null {
  if (data?.ai?.primary || data?.model) return null;
  const d = serverAiDefault(process.env, /^(1|true|yes)$/i.test(process.env.NBS_NO_LOCAL_MODEL ?? ""));
  // The curator's own privacy choice still wins over the server's.
  return d && data?.ai?.policy ? { ...d, policy: data.ai.policy } : d;
}
