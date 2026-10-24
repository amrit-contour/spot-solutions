import type { Weekday } from "./types.ts";

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Calendar parts of `at` as seen in `timeZone`. */
function zonedParts(at: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
  const parts = Object.fromEntries(f.formatToParts(at).map((p) => [p.type, p.value]));
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    wd: DAY_SHORT.indexOf(parts.weekday as (typeof DAY_SHORT)[number]) as Weekday,
  };
}

const iso = (dt: Date) => dt.toISOString().slice(0, 10);

/**
 * The lineup week a moment belongs to, keyed by its Monday (YYYY-MM-DD).
 * A week stays "current" until its last show is over, then curation rolls to the next one.
 * `rolloverDay` is the first day that belongs to next week's curation; Monday means plain
 * calendar weeks (shows run until Sunday). Use `rolloverDayFor(shows)` to derive it.
 */
export function weekOf(at: Date = new Date(), timeZone = "Asia/Kolkata", rolloverDay: Weekday = 3): string {
  const { y, m, d, wd } = zonedParts(at, timeZone);
  const local = new Date(Date.UTC(y, m - 1, d));
  // Days since last Monday (Mon=0 ... Sun=6)
  const sinceMon = (wd + 6) % 7;
  const monday = new Date(local);
  monday.setUTCDate(local.getUTCDate() - sinceMon);
  const rollIdx = (rolloverDay + 6) % 7;
  if (rollIdx > 0 && sinceMon >= rollIdx) monday.setUTCDate(monday.getUTCDate() + 7);
  return iso(monday);
}

/** Day after the latest show in the (Mon→Sun) week. No shows: Wednesday, matching a Mon/Tue mic. */
export function rolloverDayFor(shows: { weekday: Weekday; active?: boolean }[]): Weekday {
  const days = shows.filter((s) => s.active !== false).map((s) => (s.weekday + 6) % 7);
  if (!days.length) return 3;
  return ((Math.max(...days) + 1) % 7 + 1) % 7 as Weekday;
}

export function shiftWeek(week: string, by: number): string {
  const dt = new Date(`${week}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + by * 7);
  return iso(dt);
}

/** Calendar date of `weekday` within the week keyed by Monday `week`. */
export function dateInWeek(week: string, weekday: Weekday): string {
  const dt = new Date(`${week}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + ((weekday + 6) % 7));
  return iso(dt);
}

export function formatDate(isoDate: string): string {
  const dt = new Date(`${isoDate}T00:00:00Z`);
  return dt.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

export const lineupId = (week: string, showId: string) => `${week}_${showId}`;
