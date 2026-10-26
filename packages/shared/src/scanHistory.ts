// "Scan past messages": pure helpers for reading old DMs into requests. No I/O, so they are easy to test.
import { MAYBE_THRESHOLD } from "./defaults.ts";
import { holdFor } from "./rules.ts";
import { weekOf } from "./week.ts";
import type { Comic, HoldReason, InboundMessage, Intent, RuleSettings, SpotRequest, Weekday } from "./types.ts";

export const SCAN_DAYS_MIN = 1;
export const SCAN_DAYS_MAX = 21;
export const SCAN_DAYS_DEFAULT = 7;
export const SCAN_CONTEXT_MAX = 12;

/** Days to look back, as a whole number from 1 to 21. Anything unreadable becomes the default. */
export function clampScanDays(v: unknown, fallback = SCAN_DAYS_DEFAULT) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(SCAN_DAYS_MAX, Math.max(SCAN_DAYS_MIN, Math.round(n)));
}

/** Gap that starts a new burst: the debounce setting, or 45 s when it is missing. */
export const burstGapMs = (debounceSeconds?: number) => (debounceSeconds && debounceSeconds > 0 ? debounceSeconds : 45) * 1000;

/** Group one chat's messages into bursts. A gap longer than `gapMs` between neighbours starts a new one. Oldest first. */
export function splitBursts<T extends { at: number }>(messages: T[], gapMs: number): T[][] {
  const sorted = [...messages].sort((a, b) => a.at - b.at);
  const bursts: T[][] = [];
  for (const m of sorted) {
    const cur = bursts[bursts.length - 1];
    if (cur && m.at - cur[cur.length - 1].at <= gapMs) cur.push(m);
    else bursts.push([m]);
  }
  return bursts;
}

/** The week a burst belongs to: its newest message, with the same rollover rules as live intake. */
export const burstWeek = (burst: { at: number }[], timeZone: string, rolloverDay: Weekday) => weekOf(new Date(Math.max(...burst.map((m) => m.at))), timeZone, rolloverDay);

const LOCKED = ["assigned", "confirmed", "rejected", "dismissed"];
const NOT_A_REQUEST = ["cancel_spot", "status_query", "last_spot_query", "show_info"];

/** Placed, confirmed, closed or dismissed: a scan never touches these. */
export const isLockedRequest = (r?: Pick<SpotRequest, "status"> | null) => Boolean(r && LOCKED.includes(r.status));

/** Before spending a Gemma call: is there anything this burst could change? */
export function scanNeedsReading(existing: Pick<SpotRequest, "status" | "messages"> | undefined, burst: InboundMessage[]) {
  if (!burst.length) return false;
  if (!existing) return true;
  if (isLockedRequest(existing)) return false;
  const seen = new Set(existing.messages.map((m) => m.id));
  return burst.some((m) => !seen.has(m.id));
}

export type ScanPlan =
  | { action: "skip"; reason: "locked" | "no_new_messages" | "not_a_request" | "empty" }
  | { action: "create" | "update"; messages: InboundMessage[]; intent: Intent };

/**
 * What a read burst does to the week's request.
 * - Locked requests (placed, confirmed, closed, dismissed) are never changed.
 * - Chatter that is not a spot request is never stored, and never added to an open request.
 * - Open requests get the new messages merged in (deduped by id) and keep the stronger reading.
 */
export function planScanMerge(opts: { existing?: SpotRequest; burst: InboundMessage[]; intent: Intent; maxContext?: number }): ScanPlan {
  const { existing, burst, intent } = opts;
  const cap = opts.maxContext ?? SCAN_CONTEXT_MAX;
  if (!burst.length) return { action: "skip", reason: "empty" };
  if (isLockedRequest(existing)) return { action: "skip", reason: "locked" };
  if (intent.kind && NOT_A_REQUEST.includes(intent.kind)) return { action: "skip", reason: "not_a_request" };
  if (intent.confidence < MAYBE_THRESHOLD) return { action: "skip", reason: "not_a_request" };
  if (!existing) return { action: "create", messages: [...burst].sort((a, b) => a.at - b.at).slice(-cap), intent };

  const seen = new Set(existing.messages.map((m) => m.id));
  const fresh = burst.filter((m) => !seen.has(m.id));
  if (!fresh.length) return { action: "skip", reason: "no_new_messages" };
  const messages = [...existing.messages, ...fresh].sort((a, b) => a.at - b.at).slice(-cap);
  // A follow-up like "thanks" never downgrades a clearer earlier reading.
  const keep = existing.intent.confidence > intent.confidence;
  return {
    action: "update",
    messages,
    intent: keep ? { ...existing.intent, note: intent.note ?? existing.intent.note, ...(intent.isSpotRequest && { tags: intent.tags, venueId: intent.venueId }) } : intent,
  };
}

/**
 * Held or not, judged at the time the burst was sent, so an old request outside the window is held with that
 * reason instead of being dropped. A request the curator already let through keeps its hold as is.
 */
export function scanHold(opts: { existing?: Pick<SpotRequest, "hold" | "holdOverridden">; comic?: Comic | null; week: string; burst: { at: number }[]; rules: RuleSettings; timeZone: string }): HoldReason | null {
  if (opts.existing) return opts.existing.hold ?? null;
  return holdFor({ comic: opts.comic, week: opts.week, at: new Date(Math.max(...opts.burst.map((m) => m.at))), rules: opts.rules, timeZone: opts.timeZone });
}
