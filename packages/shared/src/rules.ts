import { cooldownWeeks, recentSpot } from "./adhoc.ts";
import type { Comic, HoldReason, RuleSettings, Show, SpotHistoryEntry, Weekday } from "./types.ts";
import { DAY_NAMES, formatTime } from "./week.ts";

const toMin = (day: Weekday, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return day * 1440 + h * 60 + m;
};

/** Minute-of-week for `at` in `timeZone` (Sunday 00:00 = 0). */
export function minuteOfWeek(at: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) as Weekday;
  return toMin(day, `${p.hour}:${p.minute}`);
}

/** Is `at` inside the weekly request window? Windows may wrap past Saturday night. */
export function inWindow(at: Date, w: RuleSettings["window"], timeZone: string) {
  if (!w.enabled) return true;
  const now = minuteOfWeek(at, timeZone);
  const start = toMin(w.startDay, w.startTime);
  const end = toMin(w.endDay, w.endTime);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

/** First rule that holds a request back, in priority order. */
export function holdFor(opts: { comic?: Comic | null; week: string; at: Date; rules: RuleSettings; timeZone: string }): HoldReason | null {
  const { comic, week, at, rules, timeZone } = opts;
  if (comic?.list === "banned") return "banned";
  if (comic?.list === "ignored") return "ignored";
  if (comic?.list === "host") return "host";
  if (!inWindow(at, rules.window, timeZone)) return "midweek";
  if (rules.skipLastWeek && recentSpot(comic, week, cooldownWeeks(rules))) return "last_week";
  return null;
}

export const HOLD_LABEL: Record<HoldReason, string> = {
  midweek: "Outside request window",
  last_week: "Performed recently",
  banned: "Banned",
  ignored: "Ignored",
  host: "Host / POC",
};

/** Most recent show they actually did (confirmed, on or before today). */
export function lastSpot(history: SpotHistoryEntry[] | undefined, today: string) {
  return history?.find((h) => h.status === "confirmed" && h.date <= today) ?? null;
}

export function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export const cancellations = (history: SpotHistoryEntry[] | undefined) => history?.filter((h) => h.status === "cancelled").length ?? 0;

/** Insert or replace this show's entry, newest first, capped. */
export function withHistory(history: SpotHistoryEntry[] | undefined, entry: SpotHistoryEntry, cap = 30) {
  const rest = (history ?? []).filter((h) => !(h.date === entry.date && h.showId === entry.showId));
  return [entry, ...rest].sort((a, b) => b.date.localeCompare(a.date)).slice(0, cap);
}

/** Today's date (YYYY-MM-DD) and HH:MM in the curator's timezone. */
export function localNow(at: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** "Saturday 3:00 PM": when the request window opens, for the held-request reply. */
export function windowOpensLabel(w: RuleSettings["window"]) {
  return `${DAY_NAMES[w.startDay]} ${formatTime(w.startTime)}`;
}

/**
 * Placing someone on `show`: should they come off the other shows this week? Only with "One show per week" on,
 * and never for the show's POCs, regulars or co-hosts (they're often on several nights).
 */
export function movesOffOtherShows(rules: Pick<RuleSettings, "onePerWeek">, show: Pick<Show, "pocs" | "regulars" | "protected"> | undefined, comicId: string): boolean {
  if (!rules.onePerWeek) return false;
  return !(show?.pocs?.includes(comicId) || show?.regulars?.includes(comicId) || show?.protected?.includes(comicId));
}
