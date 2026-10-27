// Calendar date math on plain YYYY-MM-DD strings (no time zones, no DST).
import { isoAddDays, isoMondayOf, type CalendarSpot, type SpotSource } from "@spot/shared";

/** The 7 dates of the Monday-to-Sunday week `date` is in, shifted by `weeks`. */
export const weekDates = (date: string, weeks = 0) => {
  const mon = isoAddDays(isoMondayOf(date), weeks * 7);
  return Array.from({ length: 7 }, (_, i) => isoAddDays(mon, i));
};

export const addMonths = (date: string, n: number) => {
  const d = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1 + n, 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(Number(date.slice(8, 10)), last);
  return `${d.toISOString().slice(0, 8)}${String(day).padStart(2, "0")}`;
};

/** Six Monday-first weeks covering the month of `date` (always six rows so the grid never changes height). */
export const monthGrid = (date: string, months = 0) => {
  const first = `${addMonths(date, months).slice(0, 8)}01`;
  const start = isoMondayOf(first);
  return Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, i) => isoAddDays(start, w * 7 + i)));
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthName = (date: string) => MONTHS[Number(date.slice(5, 7)) - 1]!;
export const dayNum = (date: string) => String(Number(date.slice(8, 10)));

/** Sources of the spots still on, per date, for the dots. */
export function sourcesByDate(spots: CalendarSpot[]): Map<string, SpotSource[]> {
  const out = new Map<string, SpotSource[]>();
  for (const s of spots) {
    if (s.status === "cancelled" || s.happened === false) continue;
    const list = out.get(s.date) ?? [];
    if (!list.includes(s.source)) list.push(s.source);
    out.set(s.date, list);
  }
  return out;
}

/** Dot per kind: a ring for regulars, solid for the rest, told apart by colour (and by the key under the calendar). */
export const SOURCE_DOT: Record<SpotSource, string> = { ask: "bg-primary", adhoc: "bg-outline", group_offer: "bg-on-surface", regular: "border-[1.5px] border-primary" };
export const SOURCE_DOT_ON_FILL: Record<SpotSource, string> = { ask: "bg-on-primary", adhoc: "bg-on-primary/60", group_offer: "bg-on-primary", regular: "border-[1.5px] border-on-primary" };
export const SOURCE_ORDER: SpotSource[] = ["regular", "ask", "group_offer", "adhoc"];

const DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const dayLong = (date: string) => `${DAYS_LONG[new Date(`${date}T00:00:00Z`).getUTCDay()]!} ${dayNum(date)} ${monthName(date)}`;
/** "27 Oct – 2 Nov" (or "27 – 31 Oct" inside one month). */
export const weekRange = (date: string) => {
  const w = weekDates(date);
  const [a, b] = [w[0]!, w[6]!];
  const m = (d: string) => monthName(d).slice(0, 3);
  return a.slice(0, 7) === b.slice(0, 7) ? `${dayNum(a)} – ${dayNum(b)} ${m(b)}` : `${dayNum(a)} ${m(a)} – ${dayNum(b)} ${m(b)}`;
};
/** "9:30p", "7p", "10a": a time that fits under a day number. */
export const shortTime = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${(h ?? 0) % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${(h ?? 0) >= 12 ? "p" : "a"}`;
};

/** Spots still on, per date, earliest first, for the week columns. */
export function spotsByDate(spots: CalendarSpot[]): Map<string, CalendarSpot[]> {
  const out = new Map<string, CalendarSpot[]>();
  for (const s of spots) {
    if (s.status === "cancelled" || s.happened === false || s.skippedRegular) continue;
    out.set(s.date, [...(out.get(s.date) ?? []), s]);
  }
  for (const l of out.values()) l.sort((a, b) => (a.time ?? "99:99").localeCompare(b.time ?? "99:99"));
  return out;
}
