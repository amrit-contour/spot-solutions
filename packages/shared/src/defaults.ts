import type { Settings } from "./types.ts";
import { DEFAULT_ACK_TEMPLATE, DEFAULT_CONFIRM_TEMPLATE, DEFAULT_REJECT_TEMPLATE } from "./template.ts";

export const DEFAULT_SETTINGS: Settings = {
  // Off until the curator opts in. Nothing leaves their WhatsApp without them choosing it.
  ack: { enabled: false, template: DEFAULT_ACK_TEMPLATE },
  confirm: { template: DEFAULT_CONFIRM_TEMPLATE },
  reject: { enabled: true, template: DEFAULT_REJECT_TEMPLATE },
  ai: { primary: { provider: "ollama", model: "gemma3:4b" }, fallback: null },
  ignoreGroups: true,
  timezone: "Asia/Kolkata",
  debounceSeconds: 45,
  // V1 defaults: requests open Saturday 3 PM, close Monday 10 AM.
  rules: { window: { enabled: false, startDay: 6, startTime: "15:00", endDay: 1, endTime: "10:00" }, skipLastWeek: false },
  selfService: { enabled: true, autoSend: false },
  onboarding: { enabled: true },
  micCheck: { enabled: true, time: "10:00", whatsapp: false },
  hostPoll: { groupId: null },
  offers: { expiryHours: 3 },
};

/** Loose yes/no for replies to offers and mic checks (English + common Hindi/Kannada). null = unclear. */
export function parseYesNo(text: string): boolean | null {
  const t = text.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const yes = /^(y|ya|yes|yeah|yep|yup|sure|ok|okay|done|in|i m in|im in|haan|ha|han|haa|bilkul|hogaya|chalega|houdu|aithu|absolutely|definitely|count me in|book me)\b/;
  const no = /^(n|no|nope|nah|nahi|nahin|na|can t|cant|cannot|not|pass|skip|illa|beda|sorry)\b/;
  if (no.test(t)) return false;
  if (yes.test(t)) return true;
  if (/\b(can t make it|won t make it|not available|unavailable|didn t happen|did not happen|cancelled|canceled)\b/.test(t)) return false;
  if (/\b(happened|went well|it was great|yes it did)\b/.test(t)) return true;
  return null;
}

/** Confidence at/above which a message becomes a request (and gets acked). */
export const INTENT_THRESHOLD = 0.6;
/** Between this and INTENT_THRESHOLD the request lands in the "Maybe" lane. */
export const MAYBE_THRESHOLD = 0.4;
/** Auto-acknowledge needs far more certainty than surfacing a request in the inbox. */
export const AUTO_ACK_THRESHOLD = 0.85;
/** Only reply to messages this fresh, so a delayed or replayed message never triggers a reply. */
export const AUTO_ACK_MAX_AGE_MS = 10 * 60_000;

/** Requests that should get a regret once the week's lineups are final. */
export function pendingRejections<R extends { comicId: string; status: string; intent: { confidence: number }; hold?: string | null; holdOverridden?: boolean }>(requests: R[], placed: Set<string>): R[] {
  return requests.filter((r) => ["new", "acked"].includes(r.status) && r.intent.confidence >= INTENT_THRESHOLD && !placed.has(r.comicId) && (!r.hold || r.holdOverridden));
}

/** Settings docs written before `ai` existed carry the older `model` field. */
export function aiFromLegacy(s: { ai?: Partial<import("./types.ts").AiSettings>; model?: { provider: "ollama" | "gemini"; name: string; fallback: boolean } } | undefined): import("./types.ts").AiSettings {
  if (s?.ai?.primary) return { primary: s.ai.primary, fallback: s.ai.fallback ?? null, ...(s.ai.policy && { policy: s.ai.policy }) };
  if (s?.model) {
    const primary = { provider: s.model.provider, model: s.model.provider === "gemini" ? "gemma-3-27b-it" : s.model.name };
    return { primary, fallback: s.model.fallback && s.model.provider === "ollama" ? { provider: "gemini", model: "gemma-3-27b-it" } : null };
  }
  return DEFAULT_SETTINGS.ai;
}
