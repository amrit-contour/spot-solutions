import { cooldownWeeks, recentSpot } from "./adhoc.ts";
import type { Comic, HoldReason, RuleSettings, Settings, Show, SpotHistoryEntry, Weekday } from "./types.ts";
import { comicIdsOf } from "./comicNumbers.ts";
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
/** `regular`: a regular of the show the ask is about; they repeat anyway, so the performed-recently hold never applies. */
export const HOST_LABEL = "Host / POC";
export function isHostComic(comic: Comic | null | undefined, shows: readonly Show[] | undefined): boolean {
  if (!comic || !shows?.length) return false;
  const ids = new Set(comicIdsOf(comic));
  return shows.some((s) => (s.active) && ([...(s.pocs ?? []), ...(s.protected ?? [])].some((x) => ids.has(x))));
}
export function hostShowOf(comic: Comic | null | undefined, shows: readonly Show[] | undefined): Show | null {
  if (!comic || !shows?.length) return null;
  const ids = new Set(comicIdsOf(comic));
  return shows.find((s) => s.active && ([...(s.pocs ?? []), ...(s.protected ?? [])].some((x) => ids.has(x)))) ?? null;
}
export function holdFor(opts: { comic?: Comic | null; week: string; at: Date; rules: RuleSettings; timeZone: string; regular?: boolean; show?: Show | null; shows?: readonly Show[] }): HoldReason | null {
  const { comic, week, at, rules, timeZone, regular, show, shows } = opts;
  if (comic?.list === "banned") return "banned";
  if (comic?.list === "ignored") return "ignored";
  if (comic?.list === "host" || isHostComic(comic, shows)) return "host";
  const settings = { rules, timezone: timeZone } as Settings;
  let open = false;
  if (show) open = showWindowOpen(show, at, settings, timeZone);
  else if (shows?.length) open = shows.filter((s) => s.active).some((s) => showWindowOpen(s, at, settings, timeZone));
  else open = inWindow(at, rules.window, timeZone);
  if (!open) return "midweek";
  if (rules.skipLastWeek && !regular && recentSpot(comic, week, cooldownWeeks(rules))) return "last_week";
  return null;
}

export const HOLD_LABEL: Record<HoldReason, string> = {
  midweek: "Outside request window",
  last_week: "Performed recently",
  banned: "Banned",
  ignored: "Ignored",
  host: "Host / POC",
  in_group_not_lineup: "In the group, not on the lineup",
  lineup_not_group: "On the lineup, not in the group",
  membership_unknown: "Group list unknown",
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
  const prev = (history ?? []).find((h) => h.date === entry.date && h.showId === entry.showId);
  const rest = (history ?? []).filter((h) => h !== prev);
  // A rating belongs to the night: re-recording the spot keeps it (unless the night didn't happen).
  if (prev?.rating != null && entry.rating === undefined && entry.status === "confirmed") entry = { ...entry, rating: prev.rating };
  if (prev?.note && entry.note === undefined && entry.status === "confirmed") entry = { ...entry, note: prev.note };
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

/**
 * Who a week's lineup starts with: the show's POCs, regulars, co-hosts and group admins, in that order, each once.
 * Same list for the first open of a week, "Add POCs, regulars and co-hosts" and the preview on the calendar.
 */
export function defaultLineupIds(show: Pick<Show, "pocs" | "regulars" | "protected"> | undefined, adminIds: readonly string[] = []): string[] {
  return [...new Set([...(show?.pocs ?? []), ...(show?.regulars ?? []), ...(show?.protected ?? []), ...adminIds])];
}

/** Is this show on for the given YYYY-MM-DD occurrence? */
export function isShowOn(show: Pick<Show, "active" | "weekday" | "activeDates" | "pausedDates">, date: string): boolean {
  if (show.pausedDates?.includes(date)) return false;
  if (show.activeDates?.includes(date)) return true;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return Boolean(show.active);
  if (d.getUTCDay() !== show.weekday) return false;
  return Boolean(show.active);
}

function hhmmOfMinute(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `${String(h).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - date.getTime();
}

function zonedToUtc(y: number, m: number, d: number, hhmm: string, timeZone: string): Date {
  const [h, min] = hhmm.split(":").map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, h, min, 0);
  const offset = timeZoneOffsetMs(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offset);
}

function zonedPartsYMD(at: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}

function addDaysYMD(y: number, m: number, d: number, days: number) {
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function nextWallOccurrence(openDay: number, openTime: string, at: Date, timeZone: string): Date {
  const { y, m, d, wd } = zonedPartsYMD(at, timeZone);
  let daysAhead = (openDay - wd + 7) % 7;
  let cand = addDaysYMD(y, m, d, daysAhead);
  let candidate = zonedToUtc(cand.y, cand.m, cand.d, openTime, timeZone);
  if (candidate.getTime() < at.getTime()) {
    cand = addDaysYMD(cand.y, cand.m, cand.d, 7);
    candidate = zonedToUtc(cand.y, cand.m, cand.d, openTime, timeZone);
  }
  return candidate;
}

function beforeWindow(show: Show, rw: Extract<Show["requestWindow"], { mode: "before" }>) {
  const startMin = toMin(show.weekday, show.startTime);
  const closeMin = ((startMin - rw.closesHoursBefore * 60) % (7 * 1440) + (7 * 1440)) % (7 * 1440);
  const openDay = ((show.weekday - rw.opensDaysBefore) % 7 + 7) % 7;
  const closeDay = Math.floor(closeMin / 1440);
  const closeTime = hhmmOfMinute(closeMin);
  return { enabled: true, startDay: openDay as Weekday, startTime: rw.opensAt, endDay: closeDay as Weekday, endTime: closeTime };
}

export function showWindowOpen(show: Show, at: Date, settings: Settings, tz: string): boolean {
  const rw = show.requestWindow ?? { mode: "default" };
  if (rw.mode === "always") return true;
  let w: RuleSettings["window"];
  if (rw.mode === "default") w = settings.rules.window;
  else if (rw.mode === "weekly") w = { enabled: true, startDay: rw.startDay, startTime: rw.startTime, endDay: rw.endDay, endTime: rw.endTime };
  else w = beforeWindow(show, rw as any) as RuleSettings["window"];
  return inWindow(at, w, tz);
}

export function nextWindowOpens(show: Show, at: Date, settings: Settings, tz: string): Date {
  const rw = show.requestWindow ?? { mode: "default" };
  if (rw.mode === "always") return new Date(at.getTime());
  let openDay: number;
  let openTime: string;
  let enabled = true;
  if (rw.mode === "default") {
    const w = settings.rules.window;
    if (!w.enabled) return new Date(at.getTime());
    openDay = w.startDay;
    openTime = w.startTime;
  } else if (rw.mode === "weekly") {
    openDay = rw.startDay;
    openTime = rw.startTime;
  } else if (rw.mode === "before") {
    openDay = ((show.weekday - rw.opensDaysBefore) % 7 + 7) % 7;
    openTime = rw.opensAt;
  } else {
    return new Date(at.getTime());
  }
  if (!enabled) return new Date(at.getTime());
  return nextWallOccurrence(openDay, openTime, at, tz);
}
