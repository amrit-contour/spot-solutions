// Plain-language summaries of rooms for the comic app's Rooms page: "Mic · Mon–Thu 9:30 PM", "Ping Monday morning", who curates today.
// Pure, so it is testable without a UI.
import { askRuleFor, askRuleLabel, curatorFor, fullClosure, isPaused, showDates, weekdayOf, type Curator, type Room, type RoomShow, type ShowShared } from "./rooms.ts";
import type { Weekday } from "./types.ts";
import { DAY_SHORT, formatTime } from "./week.ts";

/** Monday first, the way a comic's week reads. */
export const WEEK_ORDER: Weekday[] = [1, 2, 3, 4, 5, 6, 0];

/** "Mon–Thu", "Sat, Sun", "Mon, Wed, Fri", "Daily". Runs of three or more days become a range. */
export function daysLabel(days: Weekday[]): string {
  const set = new Set(days);
  if (set.size === 0) return "No days";
  if (set.size === 7) return "Daily";
  const order = WEEK_ORDER.filter((d) => set.has(d));
  const parts: string[] = [];
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && WEEK_ORDER.indexOf(order[j + 1]!) === WEEK_ORDER.indexOf(order[j]!) + 1) j++;
    const run = order.slice(i, j + 1);
    if (run.length >= 3) parts.push(`${DAY_SHORT[run[0]!]}–${DAY_SHORT[run[run.length - 1]!]}`);
    else for (const d of run) parts.push(DAY_SHORT[d]);
    i = j + 1;
  }
  return parts.join(", ");
}

export const SHOW_TYPE_LABEL: Record<ShowShared["type"], string> = { mic: "Mic", show: "Show", both: "Mic and show" };

/** "9:30 PM", "7 PM and 9 PM", "7 PM, 9 PM and 10 PM"; four or more: "12 PM to 10 PM, 6 slots". */
export function timesLabel(times: string[]): string {
  const t = [...times].sort().map(formatTime);
  if (t.length <= 1) return t[0] ?? "";
  // A slot every two hours is a run, not a list.
  if (t.length > 3) return `${t[0]} to ${t[t.length - 1]}, ${t.length} slots`;
  return `${t.slice(0, -1).join(", ")} and ${t[t.length - 1]}`;
}

const ORDINAL: Record<number, string> = { 1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 5: "5th", [-1]: "last" };

/** "Mic · Mon–Thu 9:30 PM". Monthly shows say which weeks. */
export function showSummary(show: Pick<ShowShared, "name" | "type" | "cadence" | "monthlyWeeks" | "times" | "days">): string {
  const name = show.name.trim() || SHOW_TYPE_LABEL[show.type];
  const days = daysLabel(show.days.map((d) => d.weekday));
  const weeks = show.cadence === "monthly" && show.monthlyWeeks?.length ? `${show.monthlyWeeks.map((w) => ORDINAL[w] ?? String(w)).join(", ")} ` : "";
  const when = [`${weeks}${days}`.trim(), timesLabel(show.times)].filter(Boolean).join(" ");
  return `${name} · ${when}`;
}

/** Distinct ask hints across a room's shows ("Ping Monday morning"), skipping shows with no rule. */
export function askHints(room: Pick<Room, "shows">): string[] {
  const out: string[] = [];
  for (const show of room.shows) {
    const rules = show.days.length ? show.days.map((d) => askRuleFor(show, d.weekday)) : [show.askRule];
    for (const r of rules) {
      if (!r) continue;
      const label = askRuleLabel(r);
      if (!out.includes(label)) out.push(label);
    }
  }
  return out;
}

export interface TodayEntry {
  show: RoomShow;
  /** Who to ask (the stand-in while one is on). */
  names: string[];
  theyReachOut: boolean;
}

/** Shows running on `date` (not paused) with who curates them. */
export function todayAt(room: Room, curators: Curator[], date: string): TodayEntry[] {
  const out: TodayEntry[] = [];
  for (const show of room.shows) {
    if (showDates(show, date, date).length === 0 || isPaused(room, show, date)) continue;
    const c = curatorFor(show, weekdayOf(date), curators, date);
    out.push({ show, names: [c.primary, ...c.others].filter((x): x is Curator => Boolean(x)).map((x) => x.name), theyReachOut: c.theyReachOut });
  }
  return out;
}

export const roomPaused = (room: Pick<Room, "pausedUntil">, date: string) => Boolean(room.pausedUntil && date <= room.pausedUntil);
/** Some show running today is marked full. */
export const roomFullToday = (room: Room, date: string) => room.shows.some((s) => showDates(s, date, date).length > 0 && fullClosure(s, date) !== null);

export interface CuratorUse {
  roomId: string;
  roomName: string;
  showId: string;
  showName: string;
  weekdays: Weekday[];
  /** Position in the day's list: 0 is who to ask first. */
  primary: boolean;
}

/** Where each curator works: which rooms, shows and days. */
export function curatorUsage(rooms: Room[]): Map<string, CuratorUse[]> {
  const out = new Map<string, CuratorUse[]>();
  for (const room of rooms) {
    for (const show of room.shows) {
      const per = new Map<string, { days: Weekday[]; primary: boolean }>();
      for (const day of show.days) {
        day.curatorIds.forEach((id, i) => {
          const e = per.get(id) ?? { days: [], primary: false };
          e.days.push(day.weekday);
          if (i === 0) e.primary = true;
          per.set(id, e);
        });
      }
      for (const [id, e] of per) {
        const list = out.get(id) ?? [];
        list.push({ roomId: room.id, roomName: room.name, showId: show.id, showName: show.name, weekdays: e.days, primary: e.primary });
        out.set(id, list);
      }
    }
  }
  return out;
}

/** Case-insensitive match on name, area, brand, aliases, tags and curator names. */
export function roomMatches(room: Room, curators: Curator[], q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const names = room.shows.flatMap((s) => s.days.flatMap((d) => d.curatorIds)).map((id) => curators.find((c) => c.id === id)?.name ?? "");
  return [room.name, room.area, room.brand ?? "", ...room.aliases, ...room.tags, ...names].some((s) => s.toLowerCase().includes(needle));
}

/** Rooms by area, then name; areas A to Z, rooms with no area last. */
export function groupByArea(rooms: Room[]): { area: string; rooms: Room[] }[] {
  const map = new Map<string, Room[]>();
  for (const r of rooms) {
    const a = r.area.trim();
    map.set(a, [...(map.get(a) ?? []), r]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map(([area, rs]) => ({ area, rooms: rs.sort((x, y) => x.name.localeCompare(y.name)) }));
}
