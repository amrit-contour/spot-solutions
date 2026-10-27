// Editing a lineup after it was confirmed: what changed since the comics were told, and how the "sent" record settles afterwards.
// Pure, so the app (review sheet) and the worker (send) agree on the same diff.
import type { Comic, Lineup, SentMap, Show, Slot, SpotRequest, RequestStatus } from "./types.ts";
import { withHistory } from "./rules.ts";
import { dateInWeek } from "./week.ts";

/** The set length a comic is (or would be) told: only shows that mention minutes have one. */
export function effectiveMinutes(show: Pick<Show, "includeSlotTime" | "defaultMinutes">, slot: Slot): number | null {
  return show.includeSlotTime ? (slot.minutes ?? show.defaultMinutes ?? null) : null;
}

/** Record every slot as told `at`, keeping the original time for anyone already in `prev`. */
export function sentSnapshot(slots: Slot[], show: Pick<Show, "includeSlotTime" | "defaultMinutes">, at: number, prev?: SentMap | null): SentMap {
  return Object.fromEntries(slots.map((s, order) => [s.comicId, { at: prev?.[s.comicId]?.at ?? at, minutes: effectiveMinutes(show, s), order }]));
}

export interface MinutesChange {
  comicId: string;
  from: number | null;
  to: number | null;
}
export interface MovedChange {
  comicId: string;
  /** 1-based positions. */
  from: number;
  to: number;
}

export interface LineupChanges {
  /** On the lineup now, never told. */
  added: string[];
  /** Told, no longer on the lineup. */
  removed: string[];
  /** Still on it, but their place relative to the others changed. */
  moved: MovedChange[];
  /** Still on it, set length changed. */
  minutes: MinutesChange[];
  /** Everything the curator changed, one per person. */
  total: number;
}

/**
 * Compare the lineup with what was last sent. `moved` looks at order among people who are still on it,
 * so removing someone doesn't flag everyone below them.
 */
export function diffLineup(slots: Slot[], sent: SentMap | null | undefined, show: Pick<Show, "includeSlotTime" | "defaultMinutes">): LineupChanges {
  const told = sent ?? {};
  const now = slots.map((s) => s.comicId);
  const added = now.filter((id) => !told[id]);
  const removed = Object.keys(told).filter((id) => !now.includes(id)).sort((a, b) => told[a].order - told[b].order);
  const kept = now.filter((id) => told[id]);
  const wasRank = new Map([...kept].sort((a, b) => told[a].order - told[b].order).map((id, i) => [id, i]));
  const moved: MovedChange[] = [];
  const minutes: MinutesChange[] = [];
  kept.forEach((id, rank) => {
    if (wasRank.get(id) !== rank) moved.push({ comicId: id, from: told[id].order + 1, to: now.indexOf(id) + 1 });
    const to = effectiveMinutes(show, slots[now.indexOf(id)]);
    if (show.includeSlotTime && to !== told[id].minutes) minutes.push({ comicId: id, from: told[id].minutes, to });
  });
  const resend = new Set([...moved.map((m) => m.comicId), ...minutes.map((m) => m.comicId)]);
  return { added, removed, moved, minutes, total: added.length + removed.length + resend.size };
}

/** People whose place or set length changed: they may want the confirmation again. */
export const resendCandidates = (c: LineupChanges): string[] => [...new Set([...c.moved.map((m) => m.comicId), ...c.minutes.map((m) => m.comicId)])];

/**
 * The sent record after an update. Removed people drop out, added people count as told, and everyone's order catches up.
 * `messaged` got a WhatsApp message now (their time moves). `failed` didn't get theirs and stay as they were:
 * an add that never went out is still an add, a removal that never went out is still listed.
 */
export function settleSent(slots: Slot[], show: Pick<Show, "includeSlotTime" | "defaultMinutes">, sent: SentMap | null | undefined, now: number, { messaged = [], failed = [] }: { messaged?: string[]; failed?: string[] } = {}): SentMap {
  const told = sent ?? {};
  const msg = new Set(messaged);
  const bad = new Set(failed);
  const out: SentMap = {};
  slots.forEach((s, order) => {
    const prev = told[s.comicId];
    if (bad.has(s.comicId)) {
      if (prev) out[s.comicId] = { ...prev, order };
      return;
    }
    out[s.comicId] = { at: prev && !msg.has(s.comicId) ? prev.at : now, minutes: effectiveMinutes(show, s), order };
  });
  for (const id of bad) if (told[id] && !out[id]) out[id] = told[id];
  return out;
}

/** One comic was just told (an accepted offer): add them to the record without settling anyone else's pending change. */
export function sentWith(sent: SentMap | null | undefined, slots: Slot[], show: Pick<Show, "includeSlotTime" | "defaultMinutes">, comicId: string, now: number): SentMap {
  const order = slots.findIndex((s) => s.comicId === comicId);
  if (order < 0) return { ...(sent ?? {}) };
  return { ...(sent ?? sentSnapshot(slots.filter((s) => s.comicId !== comicId), show, now)), [comicId]: { at: now, minutes: effectiveMinutes(show, slots[order]), order } };
}

/**
 * Record one comic as told on a lineup. On a confirmed lineup with no record yet the others count as told as they stand (the
 * existing rule); on a draft nobody else is, so only this comic gets an entry and Confirm & send still messages the rest.
 */
export function toldSent(lineup: Pick<Lineup, "status" | "sent" | "slots">, show: Pick<Show, "includeSlotTime" | "defaultMinutes">, comicId: string, now: number): SentMap {
  return sentWith(lineup.status === "confirmed" ? lineup.sent : (lineup.sent ?? {}), lineup.slots, show, comicId, now);
}

/**
 * Ad hoc comics who were told when they were booked (an accepted offer, a direct add with the confirmation on) but have no
 * "sent" entry: the ones to record, so a later Confirm & send or Send updates doesn't message them again. Null when none.
 */
export function adhocToldPatch(lineup: Pick<Lineup, "status" | "sent" | "slots" | "backfilled">, show: Pick<Show, "includeSlotTime" | "defaultMinutes">, acceptedIds: Set<string>, now: number): SentMap | null {
  if (lineup.backfilled || lineup.status === "cancelled" || lineup.status === "canned") return null;
  let cur: Pick<Lineup, "status" | "sent" | "slots"> = lineup;
  let changed = false;
  for (const slot of lineup.slots) {
    if (!slot.adhoc || slot.notTold || slot.backfill || !acceptedIds.has(slot.comicId) || cur.sent?.[slot.comicId]) continue;
    cur = { ...cur, sent: toldSent(cur, show, slot.comicId, now) };
    changed = true;
  }
  return changed ? (cur.sent ?? null) : null;
}

/** What the removal of a confirmed comic does to their records: history says cancelled, and a performed mark for this week is undone. */
export function cancelledPatch(comic: Pick<Comic, "history" | "lastPerformedWeek"> | undefined, lineup: Pick<Lineup, "weekOf" | "showId">, show: Pick<Show, "id" | "name" | "weekday"> | undefined, keepPerformed = false) {
  const date = show ? dateInWeek(lineup.weekOf, show.weekday) : lineup.weekOf;
  return {
    history: withHistory(comic?.history, { date, showId: lineup.showId, showName: show?.name ?? "Show", status: "cancelled" }),
    ...(!keepPerformed && comic?.lastPerformedWeek === lineup.weekOf ? { lastPerformedWeek: null } : {}),
  };
}

/** Back to the waiting state a request had before it was placed. */
export const waitingStatus = (r: Pick<SpotRequest, "ackedAt">): RequestStatus => (r.ackedAt ? "acked" : "new");
