import type { Settings } from "./types.ts";
import { DEFAULT_ACK_TEMPLATE, DEFAULT_CONFIRM_TEMPLATE, DEFAULT_REJECT_TEMPLATE } from "./template.ts";

export const DEFAULT_SETTINGS: Settings = {
  // Off until the curator opts in. Nothing leaves their WhatsApp without them choosing it.
  ack: { enabled: false, template: DEFAULT_ACK_TEMPLATE },
  confirm: { template: DEFAULT_CONFIRM_TEMPLATE },
  reject: { enabled: true, template: DEFAULT_REJECT_TEMPLATE },
  model: { provider: "ollama", name: "gemma3:4b", fallback: true },
  ignoreGroups: true,
  timezone: "Asia/Kolkata",
  debounceSeconds: 45,
};

/** Confidence at/above which a message becomes a request (and gets acked). */
export const INTENT_THRESHOLD = 0.6;
/** Between this and INTENT_THRESHOLD the request lands in the "Maybe" lane. */
export const MAYBE_THRESHOLD = 0.4;
/** Auto-acknowledge needs far more certainty than surfacing a request in the inbox. */
export const AUTO_ACK_THRESHOLD = 0.85;
/** Only reply to messages this fresh, so a delayed or replayed message never triggers a reply. */
export const AUTO_ACK_MAX_AGE_MS = 10 * 60_000;

/** Requests that should get a regret once the week's lineups are final. */
export function pendingRejections<R extends { comicId: string; status: string; intent: { confidence: number } }>(requests: R[], placed: Set<string>): R[] {
  return requests.filter((r) => ["new", "acked"].includes(r.status) && r.intent.confidence >= INTENT_THRESHOLD && !placed.has(r.comicId));
}
