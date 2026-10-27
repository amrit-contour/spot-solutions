// Backfilling a past lineup: the curator records who actually performed on a show date that has already happened.
// Nothing is sent and nobody is messaged; it only keeps history right (cooldown, "performed last week", comic stats,
// requests). Pure helpers, shared by the app and the worker's tests.
import { withHistory } from "./rules.ts";
import { effectiveMinutes, sentSnapshot } from "./lineupUpdates.ts";
import type { Comic, Lineup, SentMap, Show, Slot, SpotHistoryEntry, SpotRequest, Weekday } from "./types.ts";

/** A regular lineup spot counts toward the cooldown; an ad hoc one never does. Both are history. */
export type SpotKind = "regular" | "adhoc";

/** A show date strictly before today is "past" and can be backfilled. */
export const isPastShow = (date: string, today: string) => date < today;

export const kindOfSlot = (s: Pick<Slot, "adhoc"> | undefined): SpotKind => (s?.adhoc ? "adhoc" : "regular");

/** The week key (its Monday) a show date falls in. Show dates sit on or before the rollover, so plain calendar weeks are right. */
export function weekOfDate(date: string, _rolloverDay?: Weekday): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** A lineup the worker must leave alone: a pure record of a past show. */
export const isBackfilled = (l: Pick<Lineup, "backfilled"> | null | undefined) => Boolean(l?.backfilled);

export interface BackfillInput {
  date: string;
  weekOf: string;
  show: Pick<Show, "id" | "name">;
  /** regular / adhoc: record it. null: take the spot out of their record. */
  kind: SpotKind | null;
  rolloverDay: Weekday;
}

/**
 * What changes on a comic's record when a past spot is recorded, switched between regular and ad hoc, or taken out.
 * History always follows. lastPerformedWeek only moves forward for a regular spot, and only steps back when the spot
 * that set it is gone and nothing else regular in that week remains.
 */
export function backfillPatch(comic: Pick<Comic, "history" | "lastPerformedWeek"> | undefined, o: BackfillInput): { history: SpotHistoryEntry[]; lastPerformedWeek?: string | null } {
  const without = (comic?.history ?? []).filter((h) => !(h.date === o.date && h.showId === o.show.id));
  const history = o.kind ? withHistory(without, { date: o.date, showId: o.show.id, showName: o.show.name, status: "confirmed", ...(o.kind === "adhoc" && { adhoc: true }) }) : without;
  const cur = comic?.lastPerformedWeek ?? null;
  if (o.kind === "regular") return { history, ...(!cur || cur < o.weekOf ? { lastPerformedWeek: o.weekOf } : {}) };
  if (cur !== o.weekOf) return { history };
  if (history.some((h) => h.status === "confirmed" && !h.adhoc && weekOfDate(h.date, o.rolloverDay) === o.weekOf)) return { history };
  const prev = history.find((h) => h.status === "confirmed" && !h.adhoc);
  return { history, lastPerformedWeek: prev ? weekOfDate(prev.date, o.rolloverDay) : null };
}

/**
 * Fields to write on a past lineup before recording anyone. One that was never sent (or has no doc) becomes a backfilled
 * record: confirmed, happened, flagged so the worker never acts on it. One that really went out is left as it is.
 */
export function backfillBase(cur: Lineup | undefined): Partial<Lineup> {
  if (cur && cur.status !== "draft") return {};
  return { status: "confirmed", outcome: "happened", backfilled: true, sentAt: null, groupSync: null };
}

/** Slots after adding (or switching the kind of) one comic. Never duplicates. */
export function backfillAddSlot(slots: Slot[], comicId: string, kind: SpotKind, show: Pick<Show, "includeSlotTime" | "defaultMinutes">): Slot[] {
  const mark = (s: Slot): Slot => {
    const rest = { ...s };
    delete rest.adhoc;
    return { ...rest, backfill: true, ...(kind === "adhoc" && { adhoc: true }) };
  };
  if (slots.some((s) => s.comicId === comicId)) return slots.map((s) => (s.comicId === comicId ? mark(s) : s));
  return [...slots, mark({ comicId, minutes: show.includeSlotTime ? (show.defaultMinutes ?? null) : null })];
}

/**
 * For a past lineup that really was sent: the change counts as already told, so "Send updates" never offers it.
 * Everything that was already pending stays pending. Undefined for pure records (nothing is tracked there).
 */
export function toldAfterBackfill(cur: Lineup, slotsAfter: Slot[], show: Pick<Show, "includeSlotTime" | "defaultMinutes">, touched: string, now: number): SentMap | undefined {
  if (cur.backfilled || cur.status !== "confirmed") return undefined;
  const base = cur.sent ?? sentSnapshot(cur.slots, show, cur.sentAt ?? now);
  const out: SentMap = {};
  slotsAfter.forEach((s, order) => {
    const was = base[s.comicId];
    if (was || s.comicId === touched) out[s.comicId] = { at: was?.at ?? now, minutes: was ? was.minutes : effectiveMinutes(show, s), order };
  });
  return out;
}

/** A request from this comic for that week is settled by a recorded spot. The status to set, or null to leave it. */
export const requestAfterBackfill = (r: Pick<SpotRequest, "status"> | undefined): "confirmed" | null => (r && ["new", "acked", "assigned"].includes(r.status) ? "confirmed" : null);
