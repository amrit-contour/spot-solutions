// "Check what I've already done": the curator sometimes answers a comic by hand in WhatsApp or adds them to the
// show group themselves, so the app still shows them as Waiting. These are the pure rules that turn what the model
// read in the curator's own replies, plus who is in which group, into a suggestion. No I/O.
import { INTENT_THRESHOLD } from "./defaults.ts";
import { effectiveMinutes, sentSnapshot } from "./lineupUpdates.ts";
import { comicIdForPhone } from "./people.ts";
import type { Comic, GroupMember, Lineup, SentMap, Show, Slot, SpotRequest } from "./types.ts";

export type ReconcileDecisionKind = "gave_spot" | "declined" | "unclear";

/** What the model concluded from the curator's own messages to one comic. */
export interface ReconcileDecision {
  decision: ReconcileDecisionKind;
  /** A show id from the week, or null when the messages don't say which. */
  showId: string | null;
  /** An exact quote from the curator's messages. */
  evidence: string;
}

export type ReconcileAction = "place" | "close_declined" | "none";

export interface ReconcileCore {
  action: ReconcileAction;
  showId: string | null;
  /** The curator already told them: mark the request confirmed and record them as told. */
  markTold: boolean;
  /** The show has a group and they are not in it. The normal group sync adds them; nothing is added here. */
  addToGroup: boolean;
  /** high: the curator's own words. low: only inferred from group membership. */
  confidence: "high" | "low" | "none";
  reason: string;
  evidence: string;
}

export interface ReconcileSuggestion extends ReconcileCore {
  requestId: string;
  comicId: string;
  comicName: string;
  /** Show ids whose group the comic is in. */
  inGroupOf: string[];
  /** How many of the curator's replies were read. */
  replies: number;
}

/** Is this comic one of the group's members? Members carry a phone-based id, or the raw @lid when the number is unknown. */
export function isGroupMember(comic: Pick<Comic, "id" | "chatId" | "phone"> | { id: string; chatId?: string; phone?: string }, members: GroupMember[]): boolean {
  const ids = new Set([comic.id, comic.chatId, comic.phone ? comicIdForPhone(comic.phone.replace(/\D/g, "")) : undefined].filter((x): x is string => Boolean(x)));
  return members.some((m) => ids.has(m.id));
}

type ShowLite = Pick<Show, "id" | "groupId">;

/**
 * One request's suggestion.
 * - The curator gave a spot for a known show: place them there, already told (and flag the group if they're not in it).
 * - The curator declined: close it, no regret message.
 * - Otherwise, in exactly one show's group: place them there, lower confidence.
 * - Otherwise nothing.
 */
export function suggestReconcile(input: { decision: ReconcileDecision | null; groupShowIds: string[]; shows: ShowLite[] }): ReconcileCore {
  const { decision: d, groupShowIds, shows } = input;
  const evidence = d?.evidence ?? "";
  const show = d?.showId ? shows.find((s) => s.id === d.showId) : undefined;

  if (d?.decision === "gave_spot" && show) {
    const inGroup = groupShowIds.includes(show.id);
    const addToGroup = Boolean(show.groupId) && !inGroup;
    return {
      action: "place",
      showId: show.id,
      markTold: true,
      addToGroup,
      confidence: "high",
      reason: !show.groupId ? "You told them they have a spot" : inGroup ? "You told them they have a spot. Already in the group" : "You told them they have a spot. Not in the group yet",
      evidence,
    };
  }
  if (d?.decision === "declined") {
    return { action: "close_declined", showId: null, markTold: false, addToGroup: false, confidence: "high", reason: "You told them there's no spot", evidence };
  }
  if (groupShowIds.length === 1) {
    return {
      action: "place",
      showId: groupShowIds[0],
      markTold: true,
      addToGroup: false,
      confidence: "low",
      reason: d?.decision === "gave_spot" ? "Said yes, but not which show. Already in the group" : "Already in the group, no reply found. Lower confidence",
      evidence: d?.decision === "gave_spot" ? evidence : "",
    };
  }
  const reason = d?.decision === "gave_spot" ? "You said yes, but it isn't clear which show" : groupShowIds.length > 1 ? "In more than one show's group" : "Nothing found";
  return { action: "none", showId: null, markTold: false, addToGroup: false, confidence: "none", reason, evidence: d?.decision === "gave_spot" ? evidence : "" };
}

export type ReconcileBucket = "gave" | "group" | "declined" | "none";

/** Which section of the review sheet a suggestion belongs in. */
export function reconcileBucket(s: Pick<ReconcileCore, "action" | "confidence">): ReconcileBucket {
  if (s.action === "close_declined") return "declined";
  if (s.action === "place") return s.confidence === "high" ? "gave" : "group";
  return "none";
}

/** High-confidence rows start ticked; group-only guesses and empty rows don't. */
export const reconcileTicked = (s: Pick<ReconcileCore, "action" | "confidence">) => s.action !== "none" && s.confidence === "high";

/** The requests the Waiting column shows, and the only ones worth checking. */
export function waitingRequests<R extends Pick<SpotRequest, "comicId" | "status" | "hold" | "holdOverridden" | "intent">>(requests: R[], placed: Set<string>): R[] {
  return requests.filter((r) => ["new", "acked"].includes(r.status) && !placed.has(r.comicId) && (!r.hold || r.holdOverridden) && (r.intent.confidence >= INTENT_THRESHOLD || r.status !== "new"));
}

/** The refresh rule: group members older than this are read again before checking. */
export const RECONCILE_MEMBERS_MAX_AGE_MS = 10 * 60_000;

export interface ReconcileApplyItem {
  requestId: string;
  action: "place" | "close_declined";
  showId?: string;
  markTold?: boolean;
  addToGroup?: boolean;
}

export interface ReconcileApplyResult {
  placed: { requestId: string; comicId: string; showId: string }[];
  closed: string[];
  /** Not applied, with a plain reason. "full" ones are reported so the curator can make room. */
  skipped: { requestId: string; comicId?: string; reason: "full" | "called_off" | "not_waiting" | "elsewhere" | "no_show" | "no_request" | "invalid" }[];
}

export const RECONCILE_SKIP_TEXT: Record<ReconcileApplyResult["skipped"][number]["reason"], string> = {
  full: "the show is full",
  called_off: "the show is called off",
  not_waiting: "no longer waiting",
  elsewhere: "already on another lineup this week",
  no_show: "the show is gone",
  no_request: "the request is gone",
  invalid: "not a valid change",
};

type LineupLite = Pick<Lineup, "slots" | "status"> & Partial<Pick<Lineup, "sent" | "sentAt">>;

/**
 * Adding one comic to a show's lineup. Mirrors the app's own placing (set length from the show, appended last) and
 * records them in `sent` when they were already told, so Send updates won't message them. On a confirmed lineup the
 * existing slots become the baseline first, so the new comic shows up as told rather than as a pending change.
 */
export function planReconcilePlace(input: { lineup?: LineupLite | null; show: Pick<Show, "slotCount" | "includeSlotTime" | "defaultMinutes">; comicId: string; markTold: boolean; now: number }) {
  const { lineup, show, comicId, markTold, now } = input;
  const prev = lineup?.slots ?? [];
  if (lineup && (lineup.status === "cancelled" || lineup.status === "canned")) return { outcome: "called_off" as const, slots: prev, sent: lineup.sent ?? null };
  const already = prev.some((s) => s.comicId === comicId);
  if (!already && prev.length >= show.slotCount) return { outcome: "full" as const, slots: prev, sent: lineup?.sent ?? null };
  const slots: Slot[] = already ? prev : [...prev, { comicId, minutes: show.includeSlotTime ? (show.defaultMinutes ?? null) : null }];
  const confirmed = lineup?.status === "confirmed";
  const base: SentMap | null = lineup?.sent ?? (confirmed ? sentSnapshot(prev, show, lineup?.sentAt ?? now) : null);
  let sent = base;
  if (markTold) {
    const order = slots.findIndex((s) => s.comicId === comicId);
    sent = { ...(base ?? {}), [comicId]: { at: base?.[comicId]?.at ?? now, minutes: effectiveMinutes(show, slots[order]), order } };
  }
  return { outcome: already ? ("already" as const) : ("placed" as const), slots, sent };
}

/**
 * Why Confirm & send skips someone: you already told them (dragged in from the group, or applied from your
 * own reply), or they're already in the show's WhatsApp group, which means they already have the spot.
 */
export function confirmSkipReason(
  comic: Pick<Comic, "id"> & Partial<Pick<Comic, "chatId" | "phone">>,
  lineup: Pick<Lineup, "status" | "sent"> | undefined,
  show: Pick<Show, "groupId" | "groupMembers">,
): "told" | "in_group" | null {
  if (lineup?.status !== "confirmed" && lineup?.sent?.[comic.id]) return "told";
  const cache = show.groupId && show.groupMembers?.groupId === show.groupId ? show.groupMembers.members : null;
  if (cache && isGroupMember(comic, cache)) return "in_group";
  return null;
}
