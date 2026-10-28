// Date maths for the calendar. Dates are plain "YYYY-MM-DD" strings (the same keys lineups use) and every
// calculation runs in UTC, so a viewer's own timezone can never shift a day.
import { useEffect, useState } from "react";
import type { Weekday } from "@spot/shared";
import { boolPref, enumPref } from "@spot/ui";

export type CalView = "day" | "week" | "month";
export const CAL_VIEWS: CalView[] = ["day", "week", "month"];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(`${s}T00:00:00Z`);

export const isISODate = (s: string | null | undefined): s is string => Boolean(s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parse(s).getTime()));

export function addDays(date: string, n: number) {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

/** Same day of the month, n months on (clamped: 31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: string, n: number) {
  const d = parse(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return iso(d);
}

export const weekdayOf = (date: string) => parse(date).getUTCDay() as Weekday;

/** The Monday of the week a date is in. This is the key lineups and requests use. */
export function mondayOf(date: string) {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

export const monthKey = (date: string) => date.slice(0, 7);

/** The weeks (Monday keys) a month grid covers: 4 to 6 rows, leading and trailing days included. */
export function monthWeeks(date: string): string[] {
  const first = `${monthKey(date)}-01`;
  const last = addDays(addMonths(first, 1), -1);
  const out: string[] = [];
  for (let m = mondayOf(first); m <= last; m = addDays(m, 7)) out.push(m);
  return out;
}

export const weekDates = (monday: string) => Array.from({ length: 7 }, (_, i) => addDays(monday, i));

const fmt = (date: string, o: Intl.DateTimeFormatOptions) => parse(date).toLocaleDateString("en-IN", { ...o, timeZone: "UTC" });

export const fmtMonth = (date: string) => fmt(date, { month: "long", year: "numeric" });
export const fmtDayLong = (date: string) => fmt(date, { weekday: "long", day: "numeric", month: "long" });
export const fmtDayShort = (date: string) => fmt(date, { weekday: "short", day: "numeric", month: "short" });

/** "26 Oct – 1 Nov", or "28 Sep – 4 Oct" across a month edge. */
export function fmtWeekRange(monday: string) {
  const a = fmt(monday, { day: "numeric", month: "short" });
  const b = fmt(addDays(monday, 6), { day: "numeric", month: "short" });
  return `${a} – ${b}`;
}

export const dayNum = (date: string) => Number(date.slice(8));

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
};

/** "8 PM", or "8:30 PM" when it is not on the hour. */
export function fmtHour(min: number) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  const h12 = h % 12 || 12;
  return `${h12}${m ? ":" + String(m).padStart(2, "0") : ""} ${h >= 12 ? "PM" : "AM"}`;
}

/** The date a view should move to for "previous" / "next". */
export function stepDate(view: CalView, date: string, dir: -1 | 1) {
  return view === "day" ? addDays(date, dir) : view === "week" ? addDays(date, 7 * dir) : addMonths(date, dir);
}

/** The Monday keys a view needs data for. Day also needs the next 7 days for its agenda. */
export function weeksFor(view: CalView, date: string): string[] {
  if (view === "month") return monthWeeks(date);
  if (view === "week") return [mondayOf(date)];
  return [...new Set([mondayOf(date), mondayOf(addDays(date, 7))])];
}

export function useMedia(query: string) {
  const [on, setOn] = useState(() => (typeof window === "undefined" ? false : window.matchMedia(query).matches));
  useEffect(() => {
    const m = window.matchMedia(query);
    const h = () => setOn(m.matches);
    h();
    m.addEventListener("change", h);
    return () => m.removeEventListener("change", h);
  }, [query]);
  return on;
}

/** Home's remembered choices, synced with the account (see @spot/ui viewPrefs); the localStorage keys are the ones this screen always used. */
export const CAL_VIEW_PREF = enumPref<CalView>("calView", "spot.calendar.view", CAL_VIEWS, "week");
/** Whether the side column is folded into its rail (folded by default; only an explicit "show" is remembered). */
export const CAL_SIDE_PREF = boolPref("calSideCollapsed", "spot.calendar.sideCollapsed", true);
/** "Hide empty days" in the phone Week view. */
export const HIDE_EMPTY_DAYS_PREF = boolPref("hideEmptyDays", "spot.calendar.hideEmptyDays", false);
