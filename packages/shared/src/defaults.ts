import type { Settings } from "./types.ts";
import { DEFAULT_ACK_TEMPLATE, DEFAULT_CANCEL_SPOT_TEMPLATE, DEFAULT_CONFIRM_TEMPLATE, DEFAULT_REJECT_TEMPLATE } from "./template.ts";

export const DEFAULT_SETTINGS: Settings = {
  // Off until the curator opts in. Nothing leaves their WhatsApp without them choosing it.
  ack: { enabled: false, template: DEFAULT_ACK_TEMPLATE },
  confirm: { template: DEFAULT_CONFIRM_TEMPLATE },
  cancelSpot: { template: DEFAULT_CANCEL_SPOT_TEMPLATE },
  reject: { enabled: true, template: DEFAULT_REJECT_TEMPLATE },
  ai: { primary: { provider: "ollama", model: "gemma3:4b" }, fallback: null },
  ignoreGroups: true,
  timezone: "Asia/Kolkata",
  debounceSeconds: 45,
  // V1 defaults: requests open Saturday 3 PM, close Monday 10 AM.
  rules: { window: { enabled: false, startDay: 6, startTime: "15:00", endDay: 1, endTime: "10:00" }, skipLastWeek: false },
  selfService: { enabled: true, autoSend: false },
  onboarding: { enabled: true },
  micCheck: { enabled: true, time: "10:00", whatsapp: false, afterHours: 2, rate: true },
  hostPoll: { groupId: null },
  offers: { expiryHours: 3 },
  googleContacts: { enabled: false },
  messages: {},
  snippets: [],
  heldReplies: { enabled: false },
  followUp: { enabled: true, auto: false },
  voice: { enabled: false, profile: null },
  scanDays: 7,
  retention: { closedRequestsWeeks: 8 },
  agent: { enabled: true, notify: true, answer: true, actions: true, digest: true, digestTime: "10:00", politeNote: false, agentTagPeople: true, agentPolls: true },
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
  if (s?.ai?.primary) return { primary: s.ai.primary, fallback: s.ai.fallback ?? null, ...(s.ai.policy && { policy: s.ai.policy }), ...(s.ai.autoSwitched && { autoSwitched: s.ai.autoSwitched }), ...(s.ai.keepMissing && { keepMissing: s.ai.keepMissing }) };
  if (s?.model) {
    const primary = { provider: s.model.provider, model: s.model.provider === "gemini" ? "gemma-3-27b-it" : s.model.name };
    return { primary, fallback: s.model.fallback && s.model.provider === "ollama" ? { provider: "gemini", model: "gemma-3-27b-it" } : null };
  }
  return DEFAULT_SETTINGS.ai;
}

// ---- AI model switches: what the app writes for Undo, "Switch back" and picking a model (paths are relative to settings.ai) ----
export interface AiPatch {
  set: Record<string, unknown>;
  /** Fields to delete. */
  remove: string[];
}
type Ai = import("./types.ts").AiSettings;
type Route = import("./types.ts").AiRoute;
const modelKey = (m: string) => (m.includes(":") ? m : `${m}:latest`);
const sameModel = (r: Route | null | undefined, m: string) => r?.provider === "ollama" && modelKey(r.model) === modelKey(m);

/**
 * Restores the model the worker swapped out (`autoSwitched.from`) wherever `to` was saved. `keepMissing`: `from` is still not installed
 * (Undo on the server that lacks it), so the worker must not swap it again; otherwise (Switch back, the model is installed) nothing to keep.
 * null when there is nothing to restore.
 */
export function revertAutoSwitch(ai: Pick<Ai, "primary" | "fallback" | "autoSwitched">, o: { keepMissing: boolean; now: number }): AiPatch | null {
  const sw = ai.autoSwitched;
  if (!sw) return null;
  const set: Record<string, unknown> = {};
  if (sameModel(ai.primary, sw.to)) set["primary.model"] = sw.from;
  if (sameModel(ai.fallback, sw.to)) set["fallback.model"] = sw.from;
  const remove = ["autoSwitched"];
  if (o.keepMissing) set["keepMissing"] = { model: sw.from, at: o.now };
  else remove.push("keepMissing");
  return { set, remove };
}

/** After the curator picks routes: a pick of a model that isn't installed on purpose is kept; moving to other models drops keepMissing and a stale autoSwitched. */
export function pickRoutes(ai: Pick<Ai, "primary" | "fallback" | "autoSwitched" | "keepMissing">, next: { primary?: Route; fallback?: Route | null }, installed: string[] | null, now: number): AiPatch {
  const primary = next.primary ?? ai.primary;
  const fallback = next.fallback === undefined ? ai.fallback : next.fallback;
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  if (next.primary) set["primary"] = next.primary;
  if (next.fallback !== undefined) set["fallback"] = next.fallback;
  const have = installed && installed.length ? new Set(installed.map(modelKey)) : null;
  const routed = (m: string) => sameModel(primary, m) || sameModel(fallback, m);
  // A pick the list lacks, on a list that is known: kept on purpose.
  const missingPick = [next.primary, next.fallback].find((r): r is Route => !!r && r.provider === "ollama" && !!r.model && !!have && !have.has(modelKey(r.model)));
  if (missingPick) set["keepMissing"] = { model: missingPick.model, at: now };
  else if (ai.keepMissing && !routed(ai.keepMissing.model)) remove.push("keepMissing");
  if (ai.autoSwitched && !routed(ai.autoSwitched.to)) remove.push("autoSwitched");
  return { set, remove };
}
