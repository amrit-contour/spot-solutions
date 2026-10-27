// Nothing BOT Comedy: regular spots ("every Monday 9 PM at Bloom"). A rule is one doc; its occurrences are computed, never stored.
// A mySpots doc is written only when the comic touches one (mark it, add notes), keyed by regularId + date so it is idempotent.
// All dates are plain local calendar dates (YYYY-MM-DD), so there is no time zone or DST in here.
import { isoAddDays, isoMondayOf, weekdayOf, type MySpot, type Room } from "./rooms.ts";
import type { Weekday } from "./types.ts";

/** weekly (one or more weekdays, "custom" is the same with several), every other week, or monthly on the nth weekday. */
export type RegularCadence = "weekly" | "biweekly" | "monthly" | "custom";

export interface RegularSpot {
  id: string;
  roomId?: string;
  showId?: string;
  /** Free text when it isn't one of the comic's rooms. */
  roomName: string;
  showName?: string;
  cadence: RegularCadence;
  weekdays: Weekday[];
  /** monthly: which occurrences of the weekday (1..5, -1 = the last). */
  nth?: number[];
  /** First date it can happen on; an every-other-week rule counts its weeks from here. */
  startDate: string;
  endDate?: string;
  time?: string;
  notes?: string;
  /** Dates the comic skipped ("not this week"). */
  skipped?: string[];
  createdAt: number;
}

export const CADENCE_LABEL: Record<RegularCadence, string> = { weekly: "Every week", biweekly: "Every other week", monthly: "Monthly", custom: "Custom days" };
export const NTH_LABEL: Record<number, string> = { 1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 5: "5th", [-1]: "last" };

/** The mySpots doc id for one date of a regular. */
export const regularSpotId = (regularId: string, date: string) => `reg_${regularId}_${date}`;

/** Which occurrence of its weekday this date is in its month: 1..5. */
export const nthWeekdayOf = (date: string) => Math.ceil(Number(date.slice(8, 10)) / 7);
const isLastOfMonth = (date: string) => isoAddDays(date, 7).slice(0, 7) !== date.slice(0, 7);

/** The nth values a date counts as: [2] for the second Monday, [4, -1] for a fourth and last. */
export const nthValuesOf = (date: string): number[] => (isLastOfMonth(date) ? [nthWeekdayOf(date), -1] : [nthWeekdayOf(date)]);

const weeksBetween = (a: string, b: string) => Math.round((Date.parse(isoMondayOf(b)) - Date.parse(isoMondayOf(a))) / (7 * 86_400_000));

/** Does the rule fall on this date (ignoring skips)? */
export function regularOn(rule: Pick<RegularSpot, "cadence" | "weekdays" | "nth" | "startDate" | "endDate">, date: string): boolean {
  if (date < rule.startDate || (rule.endDate && date > rule.endDate)) return false;
  const wd = weekdayOf(date);
  const days = rule.weekdays.length ? rule.weekdays : [weekdayOf(rule.startDate)];
  if (!days.includes(wd)) return false;
  switch (rule.cadence) {
    case "biweekly":
      return weeksBetween(rule.startDate, date) % 2 === 0;
    case "monthly": {
      const want = rule.nth?.length ? rule.nth : [nthWeekdayOf(rule.startDate)];
      return nthValuesOf(date).some((n) => want.includes(n));
    }
    default:
      return true;
  }
}

/** Dates in [from, to] (inclusive) the rule falls on. Skipped dates are left out unless `withSkipped`. */
export function regularDates(rule: RegularSpot, from: string, to: string, withSkipped = false): string[] {
  const out: string[] = [];
  const start = from < rule.startDate ? rule.startDate : from;
  const end = rule.endDate && rule.endDate < to ? rule.endDate : to;
  for (let d = start; d <= end; d = isoAddDays(d, 1)) {
    if (!regularOn(rule, d)) continue;
    if (!withSkipped && rule.skipped?.includes(d)) continue;
    out.push(d);
  }
  return out;
}

/** A spot on the calendar: a mySpots doc, or one computed from a regular (`virtual`, nothing stored yet). */
export type CalendarSpot = MySpot & { virtual?: boolean; skippedRegular?: boolean };

/** The not-yet-stored spot for one date of a regular. */
export function regularSpotFor(rule: RegularSpot, date: string): CalendarSpot {
  return {
    id: regularSpotId(rule.id, date),
    date,
    ...(rule.time ? { time: rule.time } : {}),
    ...(rule.roomId ? { roomId: rule.roomId } : {}),
    ...(rule.showId ? { showId: rule.showId } : {}),
    roomName: rule.roomName,
    source: "regular",
    regularId: rule.id,
    happened: null,
    status: "booked",
    createdAt: rule.createdAt,
    virtual: true,
  };
}

/** What is saved when the comic interacts with a computed occurrence (no `virtual` flag). */
export function materializeRegular(spot: CalendarSpot): MySpot {
  const { virtual: _v, skippedRegular: _s, ...doc } = spot;
  return doc;
}

/**
 * The comic's spots with the regulars' occurrences in [from, to] folded in. A stored doc for a regular's date wins over the
 * computed one; stored docs outside the window are kept as they are. A skipped date drops out (a spot already marked as
 * played stays); with `withSkipped` it comes back as a cancelled placeholder so the calendar can offer "undo".
 */
export function mergeRegulars(spots: MySpot[], regulars: RegularSpot[], from: string, to: string, withSkipped = false): CalendarSpot[] {
  const byId = new Map(spots.map((s) => [s.id, s]));
  const out: CalendarSpot[] = [];
  const skippedIds = new Set<string>();
  for (const r of regulars) {
    for (const d of r.skipped ?? []) skippedIds.add(regularSpotId(r.id, d));
  }
  for (const s of spots) {
    if (skippedIds.has(s.id) && s.happened !== true) continue;
    out.push(s);
  }
  for (const r of regulars) {
    for (const d of regularDates(r, from, to, true)) {
      const id = regularSpotId(r.id, d);
      const skipped = r.skipped?.includes(d);
      if (skipped) {
        if (withSkipped && !(byId.get(id)?.happened === true)) out.push({ ...regularSpotFor(r, d), status: "cancelled", skippedRegular: true });
        continue;
      }
      if (!byId.has(id)) out.push(regularSpotFor(r, d));
    }
  }
  return out;
}

/** A readable rule: "Every Monday, 9:00 PM" / "2nd and last Friday". */
export function regularLabel(r: Pick<RegularSpot, "cadence" | "weekdays" | "nth" | "startDate">, dayNames: readonly string[]): string {
  const days = (r.weekdays.length ? r.weekdays : [weekdayOf(r.startDate)]).map((d) => dayNames[d]!);
  const list = days.length > 1 ? `${days.slice(0, -1).join(", ")} and ${days.at(-1)}` : days[0]!;
  if (r.cadence === "monthly") {
    const n = (r.nth?.length ? r.nth : [nthWeekdayOf(r.startDate)]).map((x) => NTH_LABEL[x] ?? String(x));
    const text = `${n.length > 1 ? `${n.slice(0, -1).join(", ")} and ${n.at(-1)}` : n[0]} ${list} of the month`;
    return text[0]!.toUpperCase() + text.slice(1);
  }
  if (r.cadence === "biweekly") return `Every other ${list}`;
  return `Every ${list}`;
}

/** Tidy a rule before saving; plain-language problems (empty: good to save). */
export function validateRegular(r: Pick<RegularSpot, "roomName" | "startDate" | "endDate" | "time" | "weekdays" | "cadence">): string[] {
  const out: string[] = [];
  if (!r.roomName?.trim()) out.push("Say which room it is at.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.startDate)) out.push("Pick the start date.");
  if (r.endDate && r.endDate < r.startDate) out.push("The end date is before the start date.");
  if (r.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time)) out.push("That time isn't valid.");
  if (r.cadence === "custom" && r.weekdays.length === 0) out.push("Pick at least one day.");
  return out;
}

/** A new rule from a one-off spot ("Make this a regular"): the same weekday, time and room, weekly from that date. */
export function regularFromSpot(spot: Pick<MySpot, "date" | "time" | "roomId" | "showId" | "roomName">, id: string, now: number): RegularSpot {
  return {
    id,
    ...(spot.roomId ? { roomId: spot.roomId } : {}),
    ...(spot.showId ? { showId: spot.showId } : {}),
    roomName: spot.roomName ?? "",
    cadence: "weekly",
    weekdays: [weekdayOf(spot.date)],
    startDate: spot.date,
    ...(spot.time ? { time: spot.time } : {}),
    createdAt: now,
  };
}

/** Shows the comic marked "I'm a regular" in their roster that have no regular spot yet. */
export function suggestRegulars(rooms: Room[], regulars: Pick<RegularSpot, "roomId" | "showId">[], today: string, newId: (roomId: string, showId: string) => string, now: number): RegularSpot[] {
  const out: RegularSpot[] = [];
  for (const room of rooms) {
    for (const show of room.shows) {
      if (show.myRole !== "regular" || !show.days.length) continue;
      if (regulars.some((r) => r.roomId === room.id && r.showId === show.id)) continue;
      const weekdays = [...new Set(show.days.map((d) => d.weekday))] as Weekday[];
      const monthly = show.cadence === "monthly";
      out.push({
        id: newId(room.id, show.id),
        roomId: room.id,
        showId: show.id,
        roomName: room.name,
        showName: show.name,
        cadence: monthly ? "monthly" : weekdays.length > 1 ? "custom" : "weekly",
        weekdays: monthly ? weekdays.slice(0, 1) : weekdays,
        ...(monthly && show.monthlyWeeks?.length ? { nth: show.monthlyWeeks } : {}),
        startDate: today,
        ...(show.times[0] ? { time: show.times[0] } : {}),
        createdAt: now,
      });
    }
  }
  return out;
}

/** Regular spots (computed) for the days that matter to planning and clash checks: today through `days` ahead, and the last `back`. */
export const regularWindow = (today: string, back = 60, ahead = 45) => ({ from: isoAddDays(today, -back), to: isoAddDays(today, ahead) });
