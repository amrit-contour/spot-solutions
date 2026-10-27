// Nothing BOT Comedy: My spots. Pure helpers on MySpot: where a spot stands, the calendar grouping, clashes, notes and the stats header.
import { clashes, isoAddDays, isoMondayOf, weekdayOf, type Ask, type MySpot, type SpotNotes, type SpotSource } from "./rooms.ts";
import { DAY_NAMES, formatDate } from "./week.ts";

export const SPOT_SOURCE_LABEL: Record<SpotSource, string> = {
  ask: "From an ask",
  adhoc: "Ad hoc",
  group_offer: "Group offer",
  regular: "Regular",
};

export type SpotState =
  /** A booked spot in the future. */
  | "upcoming"
  /** Today. */
  | "tonight"
  /** In the past and not yet marked: did it happen? */
  | "to_check"
  | "happened"
  | "didnt"
  | "cancelled";

/** Where a spot stands against `today` (and `time` now, "HH:MM", for a spot later today). */
export function spotState(s: Pick<MySpot, "date" | "happened" | "status">, today: string): SpotState {
  if (s.status === "cancelled") return "cancelled";
  if (s.happened === true) return "happened";
  if (s.happened === false) return "didnt";
  if (s.date < today) return "to_check";
  return s.date === today ? "tonight" : "upcoming";
}

export const SPOT_STATE_LABEL: Record<SpotState, string> = {
  upcoming: "Booked",
  tonight: "Tonight",
  to_check: "Did it happen?",
  happened: "Done",
  didnt: "Didn't happen",
  cancelled: "Cancelled",
};

/** Chronological. Spots with no time sort after the day's timed ones. */
export const bySpotTime = (a: Pick<MySpot, "date" | "time">, b: Pick<MySpot, "date" | "time">) =>
  a.date.localeCompare(b.date) || (a.time ?? "99:99").localeCompare(b.time ?? "99:99");

export interface SpotDay {
  date: string;
  spots: MySpot[];
}

/** Spots grouped by date, earliest first (or latest first with `desc`). */
export function spotsByDay(spots: MySpot[], desc = false): SpotDay[] {
  const map = new Map<string, MySpot[]>();
  for (const s of [...spots].sort(bySpotTime)) map.set(s.date, [...(map.get(s.date) ?? []), s]);
  const days = [...map.entries()].map(([date, list]) => ({ date, spots: list }));
  return desc ? days.reverse() : days;
}

/** "Thu 29 Oct". */
export const spotDateLabel = (date: string) => `${DAY_NAMES[weekdayOf(date)].slice(0, 3)} ${formatDate(date)}`;

/** Spots (other than this one) that sit too close in time to it. */
export function spotClashes(spots: MySpot[], spot: Pick<MySpot, "id" | "date" | "time">, bufferMin?: number): MySpot[] {
  return clashes(spots.filter((s) => s.id !== spot.id), spot, bufferMin);
}

/** Ids of every spot that clashes with another, for the calendar to flag. */
export function clashingIds(spots: MySpot[]): Set<string> {
  const out = new Set<string>();
  for (const s of spots) {
    if (s.status === "cancelled" || s.happened === false) continue;
    if (spotClashes(spots, s).length) out.add(s.id);
  }
  return out;
}

const hasNotes = (n: SpotNotes | undefined) => Boolean(n && (n.room || n.crowd || n.rating || n.whatWorked || n.whatDidnt || n.setList));
export const spotHasNotes = (s: Pick<MySpot, "notes">) => hasNotes(s.notes);

/** Trim notes and drop empty fields; the rating stays 1 to 5 or goes. */
export function cleanNotes(n: SpotNotes | undefined): SpotNotes | undefined {
  if (!n) return undefined;
  const out: SpotNotes = {};
  for (const k of ["room", "crowd", "whatWorked", "whatDidnt", "setList"] as const) {
    const v = n[k]?.trim();
    if (v) out[k] = v;
  }
  if (n.rating && n.rating >= 1 && n.rating <= 5) out.rating = Math.round(n.rating);
  return hasNotes(out) ? out : undefined;
}

/** Plain-language problems with a hand-added spot; empty means good to save. */
export function validateSpot(s: Pick<MySpot, "date" | "time" | "roomName">): string[] {
  const out: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date)) out.push("Pick the date.");
  if (!s.roomName?.trim()) out.push("Say which room it is at.");
  if (s.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) out.push("That time isn't valid.");
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------------------------------------------

export interface RoomCount {
  roomId?: string;
  roomName: string;
  count: number;
}
export interface SpotStats {
  /** Spots done this week / month (marked happened). */
  doneWeek: number;
  doneMonth: number;
  /** Booked (not marked yet), this week and still to come. */
  bookedWeek: number;
  /** Done in all, and the ones still to mark. */
  done: number;
  toCheck: number;
  byRoom: RoomCount[];
  /** Asks the comic sent, and how they went. */
  asks: { sent: number; gotIt: number; declined: number; noReply: number; waiting: number };
  /** Average of the ratings given, or null. */
  avgRating: number | null;
}

/** The numbers for the header: spots this week and month, per room, asks sent vs got. `today` is the comic's date. */
export function spotStats(spots: MySpot[], asks: Ask[], today: string): SpotStats {
  const live = spots.filter((s) => s.status !== "cancelled");
  const done = live.filter((s) => s.happened === true);
  const week = isoMondayOf(today);
  const weekEnd = isoAddDays(week, 6);
  const month = today.slice(0, 7);
  const rooms = new Map<string, RoomCount>();
  for (const s of done) {
    const key = s.roomId ?? `n:${(s.roomName ?? "").toLowerCase()}`;
    const e = rooms.get(key) ?? { roomId: s.roomId, roomName: s.roomName ?? "Other", count: 0 };
    e.count++;
    rooms.set(key, e);
  }
  const sent = asks.filter((a) => !a.skipped && a.status !== "planned" && a.status !== "expired");
  const ratings = done.map((s) => s.notes?.rating).filter((r): r is number => typeof r === "number");
  return {
    doneWeek: done.filter((s) => s.date >= week && s.date <= weekEnd).length,
    doneMonth: done.filter((s) => s.date.startsWith(month)).length,
    bookedWeek: live.filter((s) => s.happened == null && s.date >= today && s.date <= weekEnd).length,
    done: done.length,
    toCheck: live.filter((s) => s.happened == null && s.date < today).length,
    byRoom: [...rooms.values()].sort((a, b) => b.count - a.count || a.roomName.localeCompare(b.roomName)),
    asks: {
      sent: sent.length,
      gotIt: sent.filter((a) => a.status === "got_it").length,
      declined: sent.filter((a) => a.status === "declined").length,
      noReply: sent.filter((a) => a.status === "no_reply").length,
      waiting: sent.filter((a) => a.status === "sent").length,
    },
    avgRating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null,
  };
}

/** A new hand-added spot. */
export function manualSpot(input: { date: string; time?: string; roomId?: string; showId?: string; roomName: string; source?: SpotSource }, id: string, now: number): MySpot {
  return {
    id,
    date: input.date,
    ...(input.time ? { time: input.time } : {}),
    ...(input.roomId ? { roomId: input.roomId } : {}),
    ...(input.showId ? { showId: input.showId } : {}),
    roomName: input.roomName.trim(),
    source: input.source ?? "adhoc",
    happened: null,
    status: "booked",
    createdAt: now,
  };
}
