// Plain words for roster changes: the import review, the update/push review and the suggestion queue all show a before and an
// after, and none of them should show raw values like ["21:00"]. One formatter, used everywhere. Pure.
import { askRuleLabel, type AskRule, type Limit, type RoomNote } from "./rooms.ts";
import type { RosterChange } from "./rosterMerge.ts";
import { DAY_NAMES, DAY_SHORT, formatTime } from "./week.ts";

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** "9 PM", "8:30 PM": no ":00". */
export const clockLabel = (hhmm: string) => formatTime(hhmm).replace(":00 ", " ");

/** "9 PM", "7 PM, 9 PM", "12 PM to 10 PM, 6 slots". */
export function timesText(times: string[]): string {
  const t = [...times].sort().map(clockLabel);
  if (t.length > 3) return `${t[0]} to ${t[t.length - 1]}, ${t.length} slots`;
  return t.join(", ");
}

/** "Mon, Tue" for weekday numbers (Sunday = 0), in the order given. */
export const weekdaysText = (days: number[]) => days.map((d) => DAY_SHORT[d] ?? "?").join(", ");

/** "+ Tue 9 PM, - Wed": what a list gained and lost. Empty when nothing differs. */
export function listDiff(before: string[], after: string[]): string {
  const added = after.filter((x) => !before.includes(x));
  const removed = before.filter((x) => !after.includes(x));
  return [...added.map((x) => `+ ${x}`), ...removed.map((x) => `− ${x}`)].join(", ");
}

function noteText(n: RoomNote) {
  const label = { instagram: "Instagram", website: "Website", walk_in: "Walk in", check_bms: "Check BookMyShow", fcfs: "First come, first served", other: "Note" }[n.kind];
  const detail = n.kind === "instagram" ? (n.handle ? `@${n.handle}` : "") : n.kind === "website" ? (n.url ?? "") : "";
  return [label, detail, n.text].filter(Boolean).join(" ");
}

/** "2 a week", "1 a day, 4 a month", "No limit". A show's limit starts with "Show:" so two limits can be told apart. */
export function limitText(l: Limit, showName?: string): string {
  const parts = l.unlimited ? ["no limit"] : [l.perDay && `${l.perDay} a day`, l.perWeek && `${l.perWeek} a week`, l.perMonth && `${l.perMonth} a month`].filter(Boolean);
  const text = parts.join(", ") || "no limit";
  return l.scope === "show" ? `${showName ?? "Show"}: ${text}` : text.charAt(0).toUpperCase() + text.slice(1);
}

/** A day as a diff or suggestion carries it: curators as names (or {name}), or "they'll reach out". */
interface DayLike {
  times?: string[];
  curators?: ({ name: string } | string)[];
  theyReachOut?: boolean;
  askRule?: AskRule;
  note?: string;
}
function dayText(p: DayLike) {
  const names = (p.curators ?? []).map((c) => (typeof c === "string" ? c : c.name));
  const who = p.theyReachOut ? "they'll reach out" : names.join(" and ") || "no curator";
  return [who, p.times?.length ? timesText(p.times) : "", p.askRule ? askRuleLabel(p.askRule) : "", p.note ?? ""].filter(Boolean).join(", ");
}

const TYPE: Record<string, string> = { mic: "Mic", show: "Show", both: "Mic and show" };
const CADENCE: Record<string, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };

function plain(v: unknown): string {
  if (isEmpty(v)) return "nothing";
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(plain).join(", ");
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).filter(([, x]) => !isEmpty(x)).map(([k, x]) => `${k}: ${plain(x)}`).join("; ");
  return String(v);
}

/** A value as a sentence fragment a comic can read ("nothing" for empty). `field` says what it is: times, tags, askRule, days.3... */
export function formatValue(field: string | undefined, v: unknown): string {
  if (isEmpty(v)) return "nothing";
  if (field?.startsWith("days.")) return dayText(v as DayLike);
  switch (field) {
    case "times": return timesText(v as string[]);
    case "askRule": return askRuleLabel(v as AskRule);
    case "tags":
    case "aliases": return (v as string[]).join(", ");
    case "notes": return (v as RoomNote[]).map(noteText).join("; ");
    case "limits": return (v as Limit[]).map((l) => limitText(l)).join("; ");
    case "monthlyWeeks": return (v as number[]).map((w) => (w === -1 ? "last" : String(w))).join(", ");
    case "type": return TYPE[String(v)] ?? String(v);
    case "cadence": return CADENCE[String(v)] ?? String(v);
    default: return plain(v);
  }
}

const FIELD_WORD: Record<string, string> = {
  name: "name", brand: "chain", area: "area", city: "city", pin: "map pin", aliases: "other names", tags: "tags", notes: "other ways to ask",
  limits: "limits", type: "what it is", cadence: "how often", monthlyWeeks: "which weeks", times: "start times", askRule: "when to ask", note: "note",
  phone: "number", instagram: "Instagram",
};

/** Fields whose change reads best as what was added and what was dropped. */
const LIST_FIELDS = new Set(["tags", "aliases"]);

export interface ChangeText {
  /** Where: "Comedy Square · Mic", "Dhruv", or the room. */
  where: string;
  /** What: "Start times", "Monday", "New show: Mic", "Removed". */
  what: string;
  /** For a change: how it was and how it will be, in words. */
  from?: string;
  to?: string;
  /** Lists (tags, other names): "+ new-comics, - paid-entry". */
  diff?: string;
  /** Whole rooms and shows: what is in them. */
  summary?: string;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function pinText(v: unknown) {
  const p = v as { label?: string; lat?: number; lng?: number } | undefined;
  return p ? p.label || (p.lat !== undefined ? `${p.lat.toFixed(4)}, ${p.lng?.toFixed(4)}` : "a pin") : "nothing";
}

/** What a whole added or removed room or show holds: "Mon, Tue 9 PM". */
function holds(v: unknown): string | undefined {
  const o = v as { shows?: { name: string }[]; days?: { weekday: number; times?: string[] }[]; times?: string[]; area?: string } | undefined;
  if (!o) return undefined;
  if (o.shows) return [o.area, o.shows.map((s) => s.name).join(", ")].filter(Boolean).join(" · ") || undefined;
  const days = o.days?.length ? weekdaysText([...o.days].map((d) => d.weekday)) : "";
  return [days, o.times?.length ? timesText(o.times) : ""].filter(Boolean).join(" ") || undefined;
}

/** One change from diffRosters in plain words. */
export function describeChange(c: RosterChange): ChangeText {
  const parts = c.label.split(" · ");
  const field = c.field;
  if (!field) {
    const noun = c.level === "room" ? "room" : "show";
    const what = c.op === "added" ? `New ${noun}` : c.op === "removed" ? `Removed ${noun}` : cap(noun);
    return { where: c.level === "show" ? parts.slice(0, 2).join(" · ") : parts[0]!, what, summary: holds(c.op === "removed" ? c.before : c.after) };
  }
  if (c.level === "curator") return { where: parts[0]!, what: cap(FIELD_WORD[field] ?? field), from: formatValue(undefined, c.before), to: formatValue(undefined, c.after) };
  const where = c.level === "show" ? parts.slice(0, 2).join(" · ") : parts[0]!;
  if (field.startsWith("days.")) {
    const day = DAY_NAMES[Number(field.slice(5))] ?? "a day";
    if (c.op === "added") return { where, what: `Add ${day}`, to: formatValue(field, c.after) };
    if (c.op === "removed") return { where, what: `Stop on ${day}`, from: formatValue(field, c.before) };
    return { where, what: day, from: formatValue(field, c.before), to: formatValue(field, c.after) };
  }
  const what = cap(FIELD_WORD[field] ?? field);
  if (field === "pin") return { where, what, from: pinText(c.before), to: pinText(c.after) };
  if (LIST_FIELDS.has(field)) {
    const b = (c.before as string[] | undefined) ?? [];
    const a = (c.after as string[] | undefined) ?? [];
    return { where, what, diff: listDiff(b, a) || undefined };
  }
  return { where, what, from: formatValue(field, c.before), to: formatValue(field, c.after) };
}

/** The line a review list shows for a change, without the room (the list is grouped by room): "Mic: Start times". */
export function changeTitle(c: RosterChange): string {
  const parts = c.label.split(" · ");
  const t = describeChange(c);
  if (c.level === "curator") return `${parts[0]}: ${t.what.toLowerCase()}`;
  if (c.level === "room") return c.field ? t.what : "The whole room";
  return c.field ? `${parts[1] ?? "Show"}: ${t.what}` : (parts[1] ?? "The whole show");
}
