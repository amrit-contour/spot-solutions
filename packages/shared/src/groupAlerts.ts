// Nothing BOT Comedy: reading a watched WhatsApp group for spot offers, closures, opening notices and curator schedules.
// Everything here is pure (no worker, no UI): the worker asks a model what a message is, then `interpret` turns that into
// structured, validated fields (times, dates, room, contact) using the rules below, which are also what the tests cover.
// Dates are ISO "YYYY-MM-DD", times "HH:MM" (24h), both in the comic's time zone. Weekday 0 = Sunday.
import {
  curatorKey,
  slug,
  weekdayOf,
  type Closure,
  type Curator,
  type DayPlan,
  type MySpot,
  type Room,
  type RoomShow,
  type SpotAlert,
  alertClash,
  clashes,
  showDates,
} from "./rooms.ts";
import type { Weekday } from "./types.ts";
import { DAY_NAMES, DAY_SHORT, formatTime } from "./week.ts";

// ---------------------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------------------

export type GroupReadKind = "spot_offer" | "closure" | "opening_notice" | "schedule_update" | "other";

/** What the model says about one message. Only classification and names: dates, times and flags are read by the rules below. */
export interface AiRead {
  kind: GroupReadKind;
  /** The room or venue as written ("TAG", "comedy theatre", "church street"), or "". */
  room?: string;
  /** "mic", "show", "late show" when named. */
  show?: string;
  /** Who to DM: the sender ("DM me"), a tagged person, or someone named in the text. */
  contactKind?: "sender" | "mentioned" | "named";
  contactName?: string;
}

export interface Person {
  id: string;
  name?: string;
}

/** One group message, as the worker hands it over (mentions already shown as @Name). */
export interface GroupMsg {
  id: string;
  groupId: string;
  groupName?: string;
  text: string;
  /** ms */
  at: number;
  sender: Person;
  /** People tagged in the message, in order. */
  mentioned: Person[];
  /** The message this one replies to ("Closed" as a reply to the offer). */
  quotedMessageId?: string;
}

/** What the comic chose when a name fitted two locations: remembered per group and poster, so the next "Comedy Theatre" from them is settled. */
export interface RoomPick {
  groupId: string;
  posterId: string;
  roomId: string;
  at: number;
}
/** What the worker knows about this group from before: used to settle a name that fits several locations. */
export interface RoomHistory {
  /** Earlier alerts (any group): where each was. */
  alerts?: { groupId: string; roomId?: string }[];
  picks?: RoomPick[];
}

export interface ReadCtx {
  rooms: Room[];
  curators: Curator[];
  /** People the comic can name: their Comics, group members. Used for "DM Dhruv". */
  directory?: Person[];
  /** The comic's own WhatsApp id: never the contact. */
  selfId?: string;
  tz: string;
  /** ms */
  now: number;
  history?: RoomHistory;
}

export interface ParsedOffer {
  roomId?: string;
  roomName?: string;
  showId?: string;
  date: string;
  times: string[];
  reachBy?: string;
  contact: SpotAlert["contact"];
  busking: boolean;
  long: boolean;
  /** Several rooms fit the name: the poster didn't say which. */
  ambiguousRooms?: string[];
  /** The same rooms with ids, for the "Which Comedy Theatre?" chips. */
  roomCandidates?: { id: string; name: string; area: string }[];
  /** How a name that fitted several rooms was settled: "the time fits", "you picked it before"... */
  roomWhy?: string;
}

export interface DateRange {
  from: string;
  until: string;
}

export interface ParsedClosure {
  roomId?: string;
  roomName?: string;
  /** "none": no days named ("Closed", "Over, thanks"): it closes the poster's latest alert and nothing else. */
  scope: "none" | "today" | "days" | "week" | "next_week";
  days: Weekday[];
  ranges: DateRange[];
}

export interface ParsedOpening {
  roomId?: string;
  roomName?: string;
  /** HH:MM, "spots open by 3:15". */
  openAt?: string;
  /** "website is open now". */
  website: boolean;
  summary: string;
}

export interface ScheduleEntry {
  days: Weekday[];
  /** First is the one to ask; the rest co-curate. */
  people: string[];
}
export interface ParsedSchedule {
  roomId?: string;
  roomName?: string;
  entries: ScheduleEntry[];
}

export type Reading =
  | { kind: "spot_offer"; offer: ParsedOffer }
  | { kind: "closure"; closure: ParsedClosure }
  | { kind: "opening_notice"; opening: ParsedOpening }
  | { kind: "schedule_update"; schedule: ParsedSchedule }
  | { kind: "other" };

/** users/{uid}/groupUpdates/{id}: a closure, curator schedule or opening notice for the comic to review (or that was applied). */
export interface GroupUpdate {
  id: string;
  kind: "closure" | "schedule" | "opening";
  groupId: string;
  groupName?: string;
  messageId: string;
  poster: Person;
  roomId?: string;
  roomName?: string;
  /** One line for the list: "Comedy Square full Wed to Sat". */
  summary: string;
  /** A short quote. */
  text?: string;
  closure?: { ranges: DateRange[]; showId?: string };
  schedule?: { entries: ScheduleEntry[] };
  opening?: { openAt?: string; website: boolean };
  /** pending: waiting for the comic. applied: done (see `auto`). dismissed: cleared. info: nothing to apply, just a heads-up. */
  status: "pending" | "applied" | "dismissed" | "info";
  auto?: boolean;
  receivedAt: number;
  appliedAt?: number;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------------------------------------

const norm = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const tokens = (s: string) => norm(s).split(" ").filter(Boolean);
const hasPhrase = (hay: string[], needle: string[]) => {
  if (!needle.length || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((w, j) => hay[i + j] === w)) return true;
  return false;
};

/** "@919876543210" in a message body becomes "@Dhruv", so the model reads names instead of digits. */
export function mentionsAsNames(body: string, mentioned: { id: string; name?: string }[]): string {
  let out = body;
  for (const m of mentioned) {
    const digits = m.id.split("@")[0];
    if (!digits || !m.name) continue;
    out = out.split(`@${digits}`).join(`@${m.name}`);
  }
  return out;
}

/** The same person across @c.us and @lid forms of an id (the digits before the @). */
export const samePerson = (a: string | undefined, b: string | undefined) => Boolean(a && b && a.split("@")[0] === b.split("@")[0]);

/** A short quote for storing: the first words of the message, never the whole chat. */
export const shortQuote = (text: string, max = 160) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// ---------------------------------------------------------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------------------------------------------------------

const MER = "(a\\.?m\\.?|p\\.?m\\.?)";
const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const merOf = (s: string | undefined): "am" | "pm" | undefined => (s ? (s.toLowerCase().startsWith("a") ? "am" : "pm") : undefined);

/** A clock reading to minutes since midnight. `mer` undefined: a 24h number, else "evening" for 1 to 11 (mics are at night). */
function clock(h: number, m: number, mer: "am" | "pm" | undefined): number | null {
  if (h > 23 || m > 59) return null;
  if (mer === "am") return h > 12 ? null : (h % 12) * 60 + m;
  if (mer === "pm") return h > 12 ? null : ((h % 12) + 12) * 60 + m;
  if (h === 0 || h >= 13) return h * 60 + m;
  if (h === 12) return 12 * 60 + m;
  return (h + 12) * 60 + m;
}
const fromMin = (min: number) => hhmm(Math.floor(min / 60) % 24, min % 60);

const RANGE = new RegExp(`(?<![\\d:.])(\\d{1,2})(?:[:.](\\d{2}))?\\s*${MER}?\\s*(?:-|–|—|to)\\s*(\\d{1,2})(?:[:.](\\d{2}))?\\s*${MER}(?![a-z\\d])`, "gi");
const TOKEN = new RegExp(`(?<![\\d:./-])(\\d{1,2})(?:[:.](\\d{2}))?(?:\\s*${MER}(?![a-z]))?(?![\\d]|[:.]\\d)`, "gi");
const UNIT_AFTER = /^\s*(?:mins?\b|minutes?\b|hours?\b|hrs?\b|people\b|persons?\b|spots?\b|slots?\b|comics?\b|st\b|nd\b|rd\b|th\b|%|k\b|km\b|x\b)/i;
const AT_BEFORE = /\b(?:at|by|from|after|around|before|@)\s*$/i;
const JOINER = /^\s*(?:,|&|\+|\/|and|or)\s*$/i;

interface Tok {
  index: number;
  end: number;
  h: number;
  m: number;
  mer?: "am" | "pm";
  bare: boolean;
  min?: number;
}

/** Start times in `text`: "9:30 and 11 pm", "6pm", "7 and 9pm", "at 10.30", "3-5pm 5-7pm" (starts of ranges). Sorted, no duplicates. */
export function parseTimes(text: string): string[] {
  const found: number[] = [];
  let rest = text;
  // Ranges first, so "3-5pm" gives 3 PM and the "5" isn't read twice.
  rest = rest.replace(RANGE, (whole, h1, m1, mer1, h2, m2, mer2) => {
    const endMer = merOf(mer2);
    const own = merOf(mer1);
    const end = clock(Number(h2), Number(m2 ?? 0), endMer);
    let start = clock(Number(h1), Number(m1 ?? 0), own ?? endMer);
    if (start !== null && end !== null && !own && start > end) start = clock(Number(h1), Number(m1 ?? 0), endMer === "pm" ? "am" : "pm");
    if (start !== null) found.push(start);
    return " ".repeat(whole.length);
  });

  const toks: Tok[] = [];
  for (const mt of rest.matchAll(TOKEN)) {
    const index = mt.index ?? 0;
    const end = index + mt[0].length;
    if (UNIT_AFTER.test(rest.slice(end))) continue;
    const h = Number(mt[1]);
    const m = Number(mt[2] ?? 0);
    if (h > 23 || m > 59) continue;
    toks.push({ index, end, h, m, mer: merOf(mt[3]), bare: mt[2] === undefined && mt[3] === undefined });
  }
  // A bare number counts as a time after "at / by / from ..." or when it continues a list of times ("7 and 9").
  const accepted: Tok[] = [];
  for (const t of toks) {
    const prev = accepted[accepted.length - 1];
    const joined = prev && JOINER.test(rest.slice(prev.end, t.index));
    if (!t.bare || joined || AT_BEFORE.test(rest.slice(Math.max(0, t.index - 12), t.index))) accepted.push(t);
  }
  // "9:30 and 11 pm": numbers without am/pm borrow it from the next time in their list when that keeps the list in order.
  for (let i = 0; i < accepted.length; i++) {
    const t = accepted[i]!;
    let min = clock(t.h, t.m, t.mer);
    if (!t.mer && t.h <= 12 && t.h >= 1) {
      for (let j = i + 1; j < accepted.length; j++) {
        const nx = accepted[j]!;
        if (!JOINER.test(rest.slice(accepted[j - 1]!.end, nx.index))) break;
        if (nx.mer) {
          const borrowed = clock(t.h, t.m, nx.mer);
          const nxMin = clock(nx.h, nx.m, nx.mer);
          if (borrowed !== null && nxMin !== null && borrowed <= nxMin) min = borrowed;
          break;
        }
      }
    }
    t.min = min ?? undefined;
    if (min !== null) found.push(min);
  }
  return [...new Set(found)].sort((a, b) => a - b).map(fromMin);
}

const REACH_ABS = new RegExp(
  `\\b(?:reach(?:ing)?|get there|be there|be here|come|arrive|make it|there)\\b[^.!?\\n]{0,25}?\\b(?:by|before|at)\\s+(\\d{1,2})(?:[:.](\\d{2}))?\\s*${MER}?`,
  "i",
);
const REACH_REL = /\bin\s+(\d{1,3})\s*(?:mins?|minutes?)\b(?:\s*max)?/i;

/** "reach by 5.40pm" or "make it in 20 mins" (from `nowHHMM`). The text with that clause cut out comes back as `rest`. */
export function parseReachBy(text: string, nowHHMM: string): { reachBy?: string; rest: string } {
  const abs = text.match(REACH_ABS);
  if (abs) {
    const min = clock(Number(abs[1]), Number(abs[2] ?? 0), merOf(abs[3]));
    return { reachBy: min === null ? undefined : fromMin(min), rest: text.replace(abs[0], " ") };
  }
  const rel = text.match(REACH_REL);
  if (rel) return { reachBy: fromMin(toMin(nowHHMM) + Number(rel[1])), rest: text.replace(rel[0], " ") };
  return { rest: text };
}

/** Times and reach-by out of one message. */
export function parseOfferTimes(text: string, nowHHMM: string): { times: string[]; reachBy?: string } {
  const { reachBy, rest } = parseReachBy(text, nowHHMM);
  return { times: parseTimes(rest), reachBy };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Dates and days
// ---------------------------------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const toMs = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
};
const addDays = (iso: string, n: number) => new Date(toMs(iso) + n * DAY_MS).toISOString().slice(0, 10);

const DAY = "(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)";
const DAY_RE = new RegExp(`\\b${DAY}\\b`, "gi");
const DAY_RANGE_RE = new RegExp(`\\b${DAY}\\s*(?:to|-|–|—|till|until|through|thru)\\s*${DAY}\\b`, "gi");
const dayIndex = (s: string) => ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(s.slice(0, 3).toLowerCase()) as Weekday;

/** Weekdays named in a text, ranges expanded ("Wed to Sat", "Mon-Thu"), in the order they fall in the week (Monday first). */
export function parseWeekdays(text: string): Weekday[] {
  const out = new Set<Weekday>();
  let rest = text;
  rest = rest.replace(DAY_RANGE_RE, (whole, a, b) => {
    let d = dayIndex(a);
    const end = dayIndex(b);
    for (let i = 0; i < 7; i++) {
      out.add(d);
      if (d === end) break;
      d = ((d + 1) % 7) as Weekday;
    }
    return " ".repeat(whole.length);
  });
  for (const mt of rest.matchAll(DAY_RE)) out.add(dayIndex(mt[1]!));
  return [...out].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
}

/** The next date (today included) that falls on `weekday`. */
export const nextWeekday = (weekday: Weekday, today: string) => addDays(today, (weekday - weekdayOf(today) + 7) % 7);
const sundayOf = (iso: string) => addDays(iso, (7 - weekdayOf(iso)) % 7);

/** Which day an offer is for: today (the default), tomorrow, or the next named weekday. */
export function parseDayHint(text: string, today: string): string {
  const t = text.toLowerCase();
  if (/\b(tomorrow|tmrw|tmr|tom)\b/.test(t)) return addDays(today, 1);
  if (/\b(today|tonight|tonite|2day|2nite|now)\b/.test(t)) return today;
  const days = parseWeekdays(text);
  if (days.length) return days.map((d) => nextWeekday(d, today)).sort()[0]!;
  return today;
}

/** Accepts what a model or a person writes for a day: "today", "tomorrow", "friday", or an ISO date. */
export function resolveDate(hint: string | undefined, today: string): string {
  const h = (hint ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(h)) return h;
  return parseDayHint(h, today);
}

export const alertDayLabel = (date: string, today: string) =>
  date === today ? "today" : date === addDays(today, 1) ? "tomorrow" : `${DAY_SHORT[weekdayOf(date)]} ${Number(date.slice(8, 10))} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(date.slice(5, 7)) - 1]}`;

// ---------------------------------------------------------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------------------------------------------------------

function offsetMin(at: number, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(at))
      .map((x) => [x.type, x.value]),
  );
  return (Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(at / 1000) * 1000) / 60_000;
}

/** The moment (ms) a wall-clock `date` + `time` is in `tz`. */
export function zonedToMs(date: string, time: string, tz: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const guess = Date.UTC(y!, mo! - 1, d!, Number(time.slice(0, 2)), Number(time.slice(3, 5)));
  const first = guess - offsetMin(guess, tz) * 60_000;
  return guess - offsetMin(first, tz) * 60_000;
}

/** Wall-clock date and time of a moment in `tz`. */
export function localParts(ms: number, tz: string): { date: string; time: string; weekday: Weekday } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, time: `${p.hour}:${p.minute}`, weekday: weekdayOf(date) };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------------------------------------------------------

export type RoomLike = Pick<Room, "id" | "name" | "area" | "aliases"> & Partial<Pick<Room, "brand" | "notes">>;

const GENERIC = new Set(["the", "of", "at", "in", "comedy", "club", "cafe", "bar", "mic", "open", "house", "and", "a", "an", "for", "store"]);
const distinctive = (ts: string[]) => ts.filter((t) => !GENERIC.has(t));

const hostOf = (url: string | undefined) => {
  try {
    return new URL(/^https?:/i.test(url ?? "") ? url! : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

/** How well a name hint (or a whole message) points at a room: 0 for no, up to 100 for exactly that room. */
function roomScore(room: RoomLike, hintNorm: string, hintTokens: string[]): number {
  if (!hintTokens.length) return 0;
  let best = 0;
  const names = [room.name, ...room.aliases, ...(room.brand ? [room.brand] : [])];
  const withArea = [`${room.name} ${room.area}`, ...(room.brand ? [`${room.brand} ${room.area}`] : []), ...room.aliases.map((a) => `${a} ${room.area}`)];
  for (const n of [...names, ...withArea]) {
    const nt = tokens(n);
    if (!nt.length || n.trim().length < 2) continue;
    if (norm(n) === hintNorm) best = Math.max(best, 100);
    else if (hasPhrase(hintTokens, nt) && (nt.length > 1 || !GENERIC.has(nt[0]!))) best = Math.max(best, 80 + Math.min(nt.length, 10));
  }
  for (const note of room.notes ?? []) {
    const host = note.kind === "website" ? hostOf(note.url) : "";
    if (host && hintNorm.replace(/ /g, "").includes(host.replace(/[^a-z0-9]/g, ""))) best = Math.max(best, 95);
  }
  // "Square" for Comedy Square, "ministry" for Ministry of Comedy: every distinctive word of the name is in the hint.
  const dn = distinctive(tokens(room.name));
  if (dn.length && dn.every((t) => hintTokens.includes(t))) best = Math.max(best, 70 + Math.min(dn.length, 5));
  // "church street": the hint is the area (or part of the name) and nothing generic.
  const at = tokens(room.area);
  if (distinctive(at).length && hasPhrase(hintTokens, at)) best = Math.max(best, 60);
  const all = new Set([...tokens(room.name), ...tokens(room.area), ...(room.brand ? tokens(room.brand) : []), ...room.aliases.flatMap(tokens)]);
  const hd = distinctive(hintTokens);
  if (hd.length && hd.every((t) => all.has(t)) && hintTokens.length <= 4) best = Math.max(best, 50 + hd.length);
  return best;
}

export interface RoomMatch<R extends RoomLike> {
  room: R | null;
  /** Rooms tied for the best match when the name didn't settle it (two Comedy Theatres). */
  candidates: R[];
}

/** The comic's room a name or a whole message points at, by name, alias, brand, area or website. Ties are not guessed. */
export function resolveRoom<R extends RoomLike>(rooms: R[], hint: string | undefined): RoomMatch<R> {
  const hn = norm(hint ?? "");
  const ht = hn.split(" ").filter(Boolean);
  if (!ht.length) return { room: null, candidates: [] };
  const scored = rooms.map((r) => ({ r, s: roomScore(r, hn, ht) })).filter((x) => x.s >= 50);
  if (!scored.length) return { room: null, candidates: [] };
  const top = Math.max(...scored.map((x) => x.s));
  const best = scored.filter((x) => x.s === top).map((x) => x.r);
  return best.length === 1 ? { room: best[0]!, candidates: best } : { room: null, candidates: best };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Two locations under one name (Comedy Theatre has several rooms)
// ---------------------------------------------------------------------------------------------------------------------------

export interface RoomSignals {
  text: string;
  /** HH:MM offered. */
  times?: string[];
  date?: string;
  groupId: string;
  sender: Person;
  curators: Curator[];
  history?: RoomHistory;
}

export interface RoomPickResult {
  room: Room | null;
  candidates: Room[];
  /** Why this one: "you picked it for this group before", "the time fits only this one"... */
  why?: string;
  scores: Record<string, number>;
}

/** Points per signal. A room is picked when it has at least PICK_MIN and leads the next one by PICK_LEAD. */
export const ROOM_SIGNAL = { picked: 100, area: 60, curator: 40, usual: 40, usualSome: 20, time: 25, timeUnsure: 15, timeMiss: -15 } as const;
const PICK_MIN = 25;
const PICK_LEAD = 25;

function phrasesOf(r: Room): string[] {
  const label = r.pin?.label ? r.pin.label.split(",").map((x) => x.trim()) : [];
  return [r.area, ...r.aliases, ...label].filter((x) => x && x.trim().length > 2);
}

function timesOn(room: Room, date: string | undefined): string[] {
  const wd = date ? weekdayOf(date) : undefined;
  const out: string[] = [];
  for (const sh of room.shows) {
    const day = wd === undefined ? undefined : sh.days.find((d) => d.weekday === wd);
    if (wd !== undefined && sh.days.length && !day) continue; // the show doesn't run that day
    out.push(...(day?.times?.length ? day.times : sh.times));
  }
  return out;
}

/**
 * One name, several rooms: use what the message and the history say. In order of weight: the comic picked one for this group and
 * poster before; the text has an area or landmark word of one; the poster curates only one; the group's usual room; the offered
 * time is one of that room's show times (and not the others'). Nothing is guessed: a pick needs a clear lead, else the candidates
 * come back for the comic to choose.
 */
export function disambiguateRoom(candidates: Room[], s: RoomSignals): RoomPickResult {
  const scores: Record<string, number> = Object.fromEntries(candidates.map((r) => [r.id, 0]));
  const why: Record<string, string[]> = Object.fromEntries(candidates.map((r) => [r.id, []]));
  const add = (r: Room, pts: number, w: string) => {
    scores[r.id]! += pts;
    if (pts > 0) why[r.id]!.push(w);
  };
  if (candidates.length < 2) return { room: candidates[0] ?? null, candidates, scores };
  const ids = new Set(candidates.map((r) => r.id));
  const textTokens = tokens(s.text);

  // 1. What the comic picked for this group and poster.
  const pick = [...(s.history?.picks ?? [])].sort((a, b) => b.at - a.at).find((p) => p.groupId === s.groupId && samePerson(p.posterId, s.sender.id) && ids.has(p.roomId));
  if (pick) add(candidates.find((r) => r.id === pick.roomId)!, ROOM_SIGNAL.picked, "you picked it for this group before");

  // 2. An area or landmark word that belongs to one location only.
  const seen = new Map<string, number>();
  for (const r of candidates) for (const ph of new Set(phrasesOf(r).map(norm))) seen.set(ph, (seen.get(ph) ?? 0) + 1);
  for (const r of candidates) {
    const hit = phrasesOf(r).some((ph) => {
      const key = norm(ph);
      const d = distinctive(tokens(ph));
      return seen.get(key) === 1 && d.length > 0 && d.every((t) => textTokens.includes(t));
    });
    if (hit) add(r, ROOM_SIGNAL.area, "the message names its area");
  }

  // 3. The poster is a known curator of one location.
  const sameAsSender = (c: Curator) => {
    const digits = (c.phone ?? "").replace(/\D/g, "");
    const senderDigits = s.sender.id.split("@")[0]!.replace(/\D/g, "");
    return Boolean((digits.length >= 8 && senderDigits.endsWith(digits.slice(-10))) || sameName(c.name, s.sender.name));
  };
  const who = new Set(s.curators.filter(sameAsSender).map((c) => c.id));
  if (who.size) {
    const runs = candidates.map((r) => r.shows.some((sh) => sh.days.some((d) => d.curatorIds.some((id) => who.has(id)) || (d.standIn && who.has(d.standIn.curatorId)))));
    if (runs.some(Boolean) && !runs.every(Boolean)) candidates.forEach((r, i) => runs[i] && add(r, ROOM_SIGNAL.curator, "the poster curates there"));
  }

  // 4. The group's usual room.
  const past = (s.history?.alerts ?? []).filter((a) => a.groupId === s.groupId && a.roomId && ids.has(a.roomId));
  if (past.length) {
    const counts = candidates.map((r) => past.filter((a) => a.roomId === r.id).length);
    const top = Math.max(...counts);
    const lead = candidates[counts.indexOf(top)]!;
    if (counts.filter((c) => c === top).length === 1) add(lead, top >= 2 && top / past.length >= 0.75 ? ROOM_SIGNAL.usual : ROOM_SIGNAL.usualSome, "it's the usual room in this group");
  }

  // 5. The offered time fits one location's show times.
  if (s.times?.length) {
    const rows = candidates.map((r) => {
      const t = timesOn(r, s.date);
      return { r, known: t.length > 0, fits: t.some((x) => s.times!.includes(x)) };
    });
    if (rows.some((x) => x.fits) && !rows.every((x) => x.fits)) {
      // A room with no times listed can't be ruled out, so the match counts for less against it.
      const pts = rows.some((x) => !x.fits && !x.known) ? ROOM_SIGNAL.timeUnsure : ROOM_SIGNAL.time;
      for (const x of rows) {
        if (x.fits) add(x.r, pts, "the time matches its shows");
        else if (x.known) add(x.r, ROOM_SIGNAL.timeMiss, "");
      }
    }
  }

  const ranked = [...candidates].sort((a, b) => scores[b.id]! - scores[a.id]!);
  const [first, second] = ranked;
  if (first && scores[first.id]! >= PICK_MIN && scores[first.id]! - (second ? scores[second.id]! : 0) >= PICK_LEAD) {
    return { room: first, candidates: [first], why: why[first.id]!.join(", "), scores };
  }
  return { room: null, candidates, scores };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------------------------------------------------------

const NAME_SKIP = /^(me|us|you|him|her|them|now|asap|directly|for|if|the|on|to|and|at|in|is|am|pm|dm|here|your|my|only|first|early|soon|by|with)$/i;

/** "DM Dhruv" gives Dhruv; "DM me", "DM for spots" give nothing. */
export function namedContact(text: string): string | undefined {
  const m = text.match(/\b(?:dm|pm|ping|message|msg|contact|whatsapp|call|text|reach out to|talk to)\s+(?:to\s+)?@?([^\n.,;:!?()]{1,40})/i);
  if (!m) return undefined;
  const words: string[] = [];
  for (const w of m[1]!.trim().split(/\s+/)) {
    // A name is capitalised ("DM Dhruv"); "DM me", "DM for spots", "DM if you can" are not.
    if (!/^\p{Lu}/u.test(w) || NAME_SKIP.test(w) || words.length >= 2) break;
    words.push(w);
  }
  return words.length ? words.join(" ") : undefined;
}

const sameName = (a: string | undefined, b: string | undefined) => {
  const x = tokens(a ?? "");
  const y = tokens(b ?? "");
  if (!x.length || !y.length) return false;
  return x.join(" ") === y.join(" ") || (x[0] === y[0] && (x.length === 1 || y.length === 1));
};

/**
 * Who to DM. The sender when it says "DM me" (or nothing); a tagged person when the message tags one ("PM @x"); a person named
 * in the text ("DM Dhruv") when they're a tagged person or in the directory. The comic is never their own contact.
 */
export function resolveContact(args: {
  sender: Person;
  mentioned: Person[];
  text: string;
  kind?: AiRead["contactKind"];
  name?: string;
  directory?: Person[];
  selfId?: string;
}): SpotAlert["contact"] {
  const { sender, text, selfId } = args;
  const others = args.mentioned.filter((m) => !samePerson(m.id, selfId) && !samePerson(m.id, sender.id));
  const asSender = (): SpotAlert["contact"] => ({ id: sender.id, name: sender.name, kind: "sender" });
  const tagged = (p: Person): SpotAlert["contact"] => ({ id: p.id, name: p.name, kind: "mentioned" });
  const wantsSender = /\b(dm|pm|message|msg|ping)\s+me\b/i.test(text);
  const named = args.name?.trim() || namedContact(text);

  if (args.kind === "sender" && !named) return asSender();
  if (others.length && !wantsSender) {
    const byName = named ? others.find((o) => sameName(o.name, named)) : undefined;
    return tagged(byName ?? others[0]!);
  }
  if (named && !wantsSender) {
    const hit = [...(args.directory ?? [])].find((p) => !samePerson(p.id, selfId) && sameName(p.name, named));
    if (hit) return tagged(hit);
  }
  return asSender();
}

// ---------------------------------------------------------------------------------------------------------------------------
// Closures
// ---------------------------------------------------------------------------------------------------------------------------

/** Days a closure covers: "Wed to Sat this week", "Square Sunday", "Over, thanks!" (none). */
export function parseClosureScope(text: string): { scope: ParsedClosure["scope"]; days: Weekday[] } {
  const days = parseWeekdays(text);
  const t = text.toLowerCase();
  if (/\bnext week\b/.test(t)) return { scope: "next_week", days };
  if (/\b(this week|rest of the week|for the week|the week)\b/.test(t)) return { scope: "week", days };
  if (days.length) return { scope: "days", days };
  if (/\b(today|tonight|tonite|2day)\b/.test(t)) return { scope: "today", days };
  return { scope: "none", days };
}

/** Contiguous dates become one range ("Wed to Sat"); a gap makes another. */
function toRanges(dates: string[]): DateRange[] {
  const out: DateRange[] = [];
  for (const d of [...new Set(dates)].sort()) {
    const last = out[out.length - 1];
    if (last && addDays(last.until, 1) === d) last.until = d;
    else out.push({ from: d, until: d });
  }
  return out;
}

/**
 * The dates a closure covers. `week` is the Monday-to-Sunday week we're in, from today on (days already gone aren't closed);
 * `days` alone means the next time each of those days comes round. No scope: nothing (it only closes an alert).
 */
export function closureRanges(scope: ParsedClosure["scope"], days: Weekday[], today: string): DateRange[] {
  switch (scope) {
    case "none":
      return [];
    case "today":
      return [{ from: today, until: today }];
    case "days":
      return toRanges(days.map((d) => nextWeekday(d, today)));
    case "week": {
      const end = sundayOf(today);
      const dates: string[] = [];
      for (let d = today; d <= end; d = addDays(d, 1)) if (!days.length || days.includes(weekdayOf(d))) dates.push(d);
      return toRanges(dates);
    }
    case "next_week": {
      const mon = addDays(sundayOf(today), 1);
      const dates: string[] = [];
      for (let i = 0; i < 7; i++) if (!days.length || days.includes(weekdayOf(addDays(mon, i)))) dates.push(addDays(mon, i));
      return toRanges(dates);
    }
  }
}

const isLive = (a: Pick<SpotAlert, "status" | "expiresAt">, now: number) => (a.status === "new" || a.status === "asked") && a.expiresAt > now;

/**
 * The alert a "Closed" / "Over, thanks" means: the one it replies to, else the same poster's latest open alert in that group
 * (the one for the room it names, when it names one).
 */
export function alertToClose(
  alerts: SpotAlert[],
  q: { groupId: string; posterId: string; quotedMessageId?: string; roomId?: string; now: number },
): SpotAlert | null {
  const live = alerts.filter((a) => a.groupId === q.groupId && isLive(a, q.now));
  if (q.quotedMessageId) {
    const hit = live.find((a) => a.messageId === q.quotedMessageId);
    if (hit) return hit;
  }
  const mine = live.filter((a) => samePerson(a.poster.id, q.posterId)).sort((a, b) => b.receivedAt - a.receivedAt);
  if (q.roomId) return mine.find((a) => a.roomId === q.roomId) ?? mine.find((a) => !a.roomId) ?? null;
  return mine[0] ?? null;
}

/** Open alerts a room closure covers, from anyone: the room is full on those dates. */
export const alertsClosedByRanges = (alerts: SpotAlert[], roomId: string, ranges: DateRange[], now: number) =>
  alerts.filter((a) => a.roomId === roomId && isLive(a, now) && ranges.some((r) => r.from <= a.date && a.date <= r.until));

/** Adds the closure to the show(s) of a room that run on those dates (or the named show). Already closed for those dates: unchanged. */
export function applyClosureToRoom(
  room: Room,
  ranges: DateRange[],
  meta: { source?: Closure["source"]; groupId?: string; messageId?: string; showId?: string; at?: number; note?: string } = {},
): Room {
  if (!ranges.length) return room;
  const from = ranges[0]!.from;
  const to = ranges[ranges.length - 1]!.until;
  const runs = (s: RoomShow) => (meta.showId ? s.id === meta.showId : showDates(s, from, to).length > 0);
  let targets = room.shows.filter(runs);
  if (!targets.length) targets = meta.showId ? [] : room.shows;
  const ids = new Set(targets.map((s) => s.id));
  return {
    ...room,
    shows: room.shows.map((s) => {
      if (!ids.has(s.id)) return s;
      let closures = s.closures ?? [];
      for (const r of ranges) {
        if (closures.some((c) => (c.from ?? "0000-00-00") <= r.from && c.until >= r.until)) continue;
        closures = [...closures, { from: r.from, until: r.until, source: meta.source ?? "group_message", at: meta.at, groupId: meta.groupId, messageId: meta.messageId, note: meta.note }];
      }
      return { ...s, closures: closures.map((c) => stripUndefined({ ...c })) };
    }),
  };
}

function stripUndefined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Curator schedule ("Comedy Square – Curation Schedule: Monday: @Vishal, Tuesday: @Varun, Wednesday to Saturday: Akhil")
// ---------------------------------------------------------------------------------------------------------------------------

const SPEC = new RegExp(`${DAY}(?:\\s*(?:to|-|–|—|till|&|and|,|/)\\s*${DAY})*\\s*[:\\-–—]\\s*`, "gi");

/** "Vishal KG Comic BLR" is a name plus a tag line: drop the trailing words that aren't part of the name. */
export const cleanPersonName = (s: string) =>
  s
    .replace(/^[@\s]+/, "")
    .replace(/[\s,.;]+$/, "")
    .replace(/\b(comic|comedian|comedy|blr|bangalore|bengaluru)\b(?:\s+\b(comic|comedian|comedy|blr|bangalore|bengaluru)\b)*\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

/** The days and who curates them, read straight from the text. Empty when the text isn't a schedule. */
export function parseSchedule(text: string): ScheduleEntry[] {
  const specs = [...text.matchAll(SPEC)];
  const out: ScheduleEntry[] = [];
  specs.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < specs.length ? (specs[i + 1]!.index ?? text.length) : text.length;
    // The value runs to the next "Day:" or the end of the line.
    const value = text.slice(start, end).split("\n")[0]!;
    const people = value
      .split(/\s*(?:&|\/|\band\b|\+)\s*/i)
      .map(cleanPersonName)
      .filter((p) => p.length > 0 && !/^(off|closed|none|no mic|tbd|-)$/i.test(p));
    const days = parseWeekdays(m[0].replace(/[:\-–—]\s*$/, ""));
    if (days.length && people.length) out.push({ days, people });
  });
  return out;
}

/** The existing curator a written name means: the same name, or one that contains the other ("Akhil" is "Akhil Sharma") when that's unambiguous. */
export function matchCurator(curators: Curator[], name: string): Curator | null {
  const key = slug(cleanPersonName(name));
  if (!key) return null;
  const exact = curators.find((c) => curatorKey(c) === key);
  if (exact) return exact;
  const want = tokens(cleanPersonName(name));
  const within = curators.filter((c) => {
    const have = tokens(c.name);
    return have.length > 0 && have.every((t) => want.includes(t));
  });
  if (within.length) return within.sort((a, b) => tokens(b.name).length - tokens(a.name).length)[0]!;
  const first = curators.filter((c) => want.every((t) => tokens(c.name).includes(t)));
  return first.length === 1 ? first[0]! : null;
}

export interface ScheduleChange {
  weekday: Weekday;
  curatorName: string;
  /** Another show on the same room has no such day: nothing to change. */
  skipped?: string;
  created?: boolean;
}

/**
 * Sets who curates each named weekday of the room's show (the first person asked, the rest co-curate). Curators we don't know
 * are added without a number. A weekday the show doesn't run on is left alone and reported.
 */
export function applyScheduleToRoom(
  room: Room,
  curators: Curator[],
  entries: ScheduleEntry[],
  opts: { showId?: string } = {},
): { room: Room; curators: Curator[]; changes: ScheduleChange[] } {
  const nextCurators = [...curators];
  const changes: ScheduleChange[] = [];
  const idFor = (name: string) => {
    const hit = matchCurator(nextCurators, name);
    if (hit) return { id: hit.id, name: hit.name, created: false };
    const clean = cleanPersonName(name) || name.trim();
    let id = slug(clean) || "curator";
    for (let n = 2; nextCurators.some((c) => c.id === id); n++) id = `${slug(clean)}-${n}`;
    nextCurators.push({ id, name: clean, notes: "Added from a group message. Add their number." });
    return { id, name: clean, created: true };
  };
  // The named show, else the first one (mics before shows) that runs on any of those days, else the first.
  const pickShow = (weekdays: Weekday[]) => {
    if (opts.showId) return room.shows.find((s) => s.id === opts.showId);
    const ranked = [...room.shows].sort((a, b) => Number(a.type === "show") - Number(b.type === "show"));
    return ranked.find((s) => weekdays.some((w) => s.days.some((d) => d.weekday === w))) ?? room.shows[0];
  };
  let shows = room.shows;
  for (const e of entries) {
    const show = pickShow(e.days);
    if (!show) continue;
    const ids = e.people.map(idFor);
    shows = shows.map((s) =>
      s.id !== show.id
        ? s
        : {
            ...s,
            days: s.days.map((d): DayPlan => {
              if (!e.days.includes(d.weekday)) return d;
              const { standIn: _gone, ...rest } = d;
              return { ...rest, curatorIds: ids.map((x) => x.id), theyReachOut: undefined } as DayPlan;
            }),
          },
    );
    for (const w of e.days) {
      const has = show.days.some((d) => d.weekday === w);
      changes.push({ weekday: w, curatorName: ids[0]!.name, created: ids[0]!.created || undefined, skipped: has ? undefined : `${show.name} doesn't run on ${DAY_NAMES[w]}` });
    }
  }
  const clean = shows.map((s) => ({ ...s, days: s.days.map((d) => stripUndefined({ ...d })) }));
  return { room: { ...room, shows: clean }, curators: nextCurators, changes };
}

/** "Mon Vishal KG, Tue Varun Sachdev, Wed to Sat Akhil": the one line a schedule update gets. */
export function scheduleSummary(entries: ScheduleEntry[]): string {
  return entries.map((e) => `${daysShort(e.days)} ${e.people.join(" and ")}`).join(", ");
}
function daysShort(days: Weekday[]) {
  const order = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const contiguous = order.length >= 3 && order.every((d, i) => i === 0 || (d + 6) % 7 === ((order[i - 1]! + 6) % 7) + 1);
  return contiguous ? `${DAY_SHORT[order[0]!]} to ${DAY_SHORT[order[order.length - 1]!]}` : order.map((d) => DAY_SHORT[d]).join(", ");
}
export const rangeSummary = (ranges: DateRange[]) =>
  ranges.map((r) => (r.from === r.until ? shortDate(r.from) : `${shortDate(r.from)} to ${shortDate(r.until)}`)).join(", ");
const shortDate = (d: string) => `${DAY_SHORT[weekdayOf(d)]} ${Number(d.slice(8, 10))}`;

// ---------------------------------------------------------------------------------------------------------------------------
// What a message is, without the model (the fallback) and what is worth reading at all
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * Quick filter before anything is read by a model: a message with none of these words is chat, not a spot post. Cheap, and it
 * keeps unrelated conversation from ever reaching the model.
 */
export const worthReading = (text: string) => text.trim().length > 0 && text.length < 1500 && /\b(spots?|slots?|busk\w*|closed?|over|full|filled|open(?:s|ed|ing)?|available|avail|schedule|curat\w*|dm|website|mic)\b/i.test(text);

const OFFER_RE = /\b(spots?|slots?)\b[^.\n]*\b(available|avail|open|free|left|vacant)\b|\b(available|avail|free|open)\b[^.\n]*\b(spots?|slots?)\b|\bdm\b[^.\n]*\b(spots?|slots?)\b|\b(spots?|slots?)\b[^.\n]*\b(dm|pm me|message me)\b|\bbusk\w*\b[^.\n]*\b(available|avail|open|free)\b|\b(spots?|slots?)\s+(at|for)\b/i;
const OPENING_RE = /\b(will open|opens?\s+(?:at|by|in|from)|open by|opening (?:at|by)|website\b[^.\n]*\bopen|registrations?\b[^.\n]*\bopen)\b/i;
const CLOSURE_RE = /\b(closed?|over|full|filled|houseful|sold out|no more (?:spots?|slots?)|done|finished|booked)\b/i;

/** Who to DM, by the rules: a tagged person ("PM @x"), someone named ("DM Dhruv"), or the sender. */
export function contactHint(text: string, mentioned: Person[] = []): Pick<AiRead, "contactKind" | "contactName"> {
  const t = text.trim();
  const named = namedContact(t);
  return mentioned.length && /\b(dm|pm|ping|message|msg|contact|whatsapp|call|text)\s+@/i.test(t) ? { contactKind: "mentioned" } : named ? { contactKind: "named", contactName: named } : { contactKind: "sender" };
}

/**
 * The model's job done by rules: what kind of message it is, and the room or person it names. Used when no model answers
 * (too slow, offline, no key) so an urgent offer still gets through, and in tests.
 */
export function heuristicRead(text: string, mentioned: Person[] = []): AiRead {
  const t = text.trim();
  if (parseSchedule(t).length >= 2 && /\b(schedule|curat\w*|roster|lineup)\b/i.test(t)) return { kind: "schedule_update" };
  const contact = contactHint(t, mentioned);
  if (OPENING_RE.test(t) && /\b(spots?|slots?|website|registrations?|mics?)\b/i.test(t)) return { kind: "opening_notice" };
  const short = t.length <= 70;
  if (OFFER_RE.test(t) && !(short && /^\W*(closed?|over|full|done)\b/i.test(t))) return { kind: "spot_offer", ...contact };
  if (CLOSURE_RE.test(t) && (short || /\b(spots?|slots?)\b/i.test(t))) return { kind: "closure" };
  return { kind: "other" };
}

const SPOT_WORD = /\b(spots?|slots?|busk\w*|mics?|sets?)\b/i;

// ---------------------------------------------------------------------------------------------------------------------------
// Alert rules: how sure the rules are that a message is a spot offer (or a closure), 0-100. A small rule engine: every rule is
// data (phrases, a regex, or a built-in check), has a weight (negative lowers the score) and can be switched off. Each comic can
// edit the rules and the bar; the stored settings only hold what they changed, so updated defaults still reach them.
// ---------------------------------------------------------------------------------------------------------------------------

/** Checks that need code rather than words. */
export type BuiltinSignal = "time" | "contact" | "knownRoom" | "short" | "tiny" | "long" | "question" | "questionNoContact" | "scheduleShape" | "openingShape";

export interface AlertRule {
  /** Default rules have fixed ids; custom rules start with "c-". */
  id: string;
  label: string;
  kind: "phrase" | "regex" | "builtin";
  /** phrase: matched case-insensitively as whole words. */
  patterns?: string[];
  /** regex: matched case-insensitively. */
  regex?: string;
  builtin?: BuiltinSignal;
  /** -100..100: points added when the rule matches; negative lowers the score. */
  weight: number;
  enabled: boolean;
  /** Which score the rule counts towards: "is this a spot offer" or "is this a closure". */
  appliesTo: "offer" | "closure";
  custom?: boolean;
}

export const BUILTIN_LABELS: Record<BuiltinSignal, string> = {
  time: "a time or day (7 pm, today, tonight, reach by, in 30 mins)",
  contact: "someone to contact (DM / PM / ping me, a tag or a name)",
  knownRoom: "one of your rooms or its other names",
  short: "short (under 160 characters)",
  tiny: "very short (40 characters or fewer)",
  long: "very long (over 400 characters)",
  question: "has a question mark",
  questionNoContact: "has a question mark and nobody to DM",
  scheduleShape: "looks like a curator schedule",
  openingShape: "looks like an opening notice",
};

const OFFER_WORDING_SRC = `${OFFER_RE.source}|\\bbusk\\w*\\b|\\bneeds?\\s+(?:\\d+\\s+)?(?:comics?|comedians?|performers?)\\b|\\banyone\\s+(?:free|up for|available)\\b`;

const rule = (id: string, label: string, kind: AlertRule["kind"], weight: number, appliesTo: AlertRule["appliesTo"], rest: Partial<AlertRule>): AlertRule => ({ id, label, kind, weight, appliesTo, enabled: true, ...rest });

export const DEFAULT_ALERT_RULES: AlertRule[] = [
  rule("offer-wording", "Sounds like an offer (spots available, busking, need comics, anyone free)", "regex", 35, "offer", { regex: OFFER_WORDING_SRC }),
  rule("offer-spot-word", "Says spot, slot or busking", "phrase", 10, "offer", { patterns: ["spot", "spots", "slot", "slots", "busk", "busking", "busker"] }),
  rule("offer-time", "Names a time or day", "builtin", 30, "offer", { builtin: "time" }),
  rule("offer-contact", "Says who to contact", "builtin", 15, "offer", { builtin: "contact" }),
  rule("offer-room", "Names one of your rooms", "builtin", 5, "offer", { builtin: "knownRoom" }),
  rule("offer-short", "Short, like a real post", "builtin", 5, "offer", { builtin: "short" }),
  rule(
    "offer-request",
    "Asks for a spot instead of offering one",
    "phrase",
    -60,
    "offer",
    { patterns: ["any spot", "any spots", "any slot", "any slots", "can i get", "can i have", "could i get", "may i get", "looking for a spot", "looking for spot", "need a spot", "want a spot", "does anyone have", "is there a spot", "is there any spot", "spot pls", "spot plz", "spot please", "please give", "please add"] },
  ),
  rule("offer-closed", "Says closed, full or no more", "phrase", -50, "offer", { patterns: ["closed", "close", "over", "full", "filled", "houseful", "sold out", "no more", "no spots", "no spot", "no slots", "done", "finished", "booked", "taken", "gone", "cancelled", "canceled", "cancel"] }),
  rule("offer-question", "A question and nobody to DM", "builtin", -35, "offer", { builtin: "questionNoContact" }),
  rule("offer-long", "Very long message", "builtin", -40, "offer", { builtin: "long" }),
  rule("offer-schedule", "Looks like a curator schedule (never pushed as a spot)", "builtin", -80, "offer", { builtin: "scheduleShape" }),
  rule("offer-opening", "Looks like an opening notice (never pushed as a spot)", "builtin", -80, "offer", { builtin: "openingShape" }),

  rule("closure-lead", "Starts with closed, over or full", "regex", 45, "closure", { regex: "^\\W*(closed?|over|full|filled|houseful|sold out)\\b" }),
  rule("closure-wording", "Says closed, over, full or no more", "phrase", 30, "closure", { patterns: ["closed", "over", "full", "filled", "houseful", "sold out", "no more", "no spots", "no slots"] }),
  rule("closure-spot-word", "Mentions the spots", "phrase", 25, "closure", { patterns: ["spot", "spots", "slot", "slots"] }),
  rule("closure-short", "Short message", "builtin", 10, "closure", { builtin: "short" }),
  rule("closure-tiny", "Very short, like \"Closed, thanks\"", "builtin", 15, "closure", { builtin: "tiny" }),
  rule("closure-offer", "Also offers spots", "regex", -60, "closure", { regex: OFFER_WORDING_SRC }),
  rule("closure-time", "Names a time or day", "builtin", -40, "closure", { builtin: "time" }),
  rule("closure-question", "A question", "builtin", -40, "closure", { builtin: "question" }),
];

export const DEFAULT_ALERT_THRESHOLD = 60;
export const DEFAULT_CLOSURE_THRESHOLD = 60;
export const MAX_ALERT_RULES = 50;
const MAX_PATTERNS = 40;
const MAX_PATTERN_LEN = 60;
const MAX_REGEX_LEN = 500;
const MAX_LABEL_LEN = 80;
const MAX_INPUT = 1500;

/** What is stored: only what differs from the defaults (by id), plus the comic's own rules. */
export interface StoredAlertRule {
  id: string;
  label?: string;
  kind?: AlertRule["kind"];
  patterns?: string[];
  regex?: string;
  weight?: number;
  enabled?: boolean;
  appliesTo?: AlertRule["appliesTo"];
}
export interface StoredAlertRules {
  threshold?: number;
  closureThreshold?: number;
  rules?: StoredAlertRule[];
}
export type AlertRulesInput = StoredAlertRules | ResolvedAlertRules | null | undefined;

export interface ResolvedAlertRules {
  threshold: number;
  closureThreshold: number;
  rules: AlertRule[];
  /** rule id -> why it is skipped (a bad regex, a missing field). */
  problems: Record<string, string>;
}

const validPct = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
const validWeight = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= -100 && v <= 100;
const cleanPatterns = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((p): p is string => typeof p === "string").map((p) => p.trim().slice(0, MAX_PATTERN_LEN)).filter(Boolean).slice(0, MAX_PATTERNS) : undefined;

/** A regex is refused if it won't compile, is long, uses backreferences or has a quantified group holding a quantifier ((a+)+). */
export function regexProblem(src: string): string | null {
  if (!src.trim()) return "Empty pattern";
  if (src.length > MAX_REGEX_LEN) return `Longer than ${MAX_REGEX_LEN} characters`;
  if (/\\[1-9]/.test(src)) return "Backreferences aren't allowed";
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(src)) return "A repeat inside a repeat can hang the app";
  try {
    new RegExp(src, "i");
  } catch {
    return "Not a valid pattern";
  }
  return null;
}

/** Applies stored overrides and custom rules over the defaults. Anything invalid is dropped or falls back, never thrown. */
export function resolveAlertRules(raw: AlertRulesInput): ResolvedAlertRules {
  const problems: Record<string, string> = {};
  const rules: AlertRule[] = DEFAULT_ALERT_RULES.map((r) => ({ ...r, patterns: r.patterns ? [...r.patterns] : undefined }));
  const byId = new Map(rules.map((r) => [r.id, r]));
  const stored = Array.isArray(raw?.rules) ? (raw.rules as StoredAlertRule[]).slice(0, MAX_ALERT_RULES) : [];
  for (const s of stored) {
    if (!s || typeof s.id !== "string") continue;
    const base = byId.get(s.id);
    if (base && !base.custom) {
      if (typeof s.enabled === "boolean") base.enabled = s.enabled;
      if (validWeight(s.weight)) base.weight = Math.round(s.weight);
      if (base.kind === "phrase") {
        const p = cleanPatterns(s.patterns);
        if (p?.length) base.patterns = p;
      }
      if (base.kind === "regex" && typeof s.regex === "string" && s.regex.trim()) base.regex = s.regex;
      continue;
    }
    if (!s.id.startsWith("c-") || byId.has(s.id) || rules.length >= DEFAULT_ALERT_RULES.length + MAX_ALERT_RULES) continue;
    const kind = s.kind === "regex" ? "regex" : s.kind === "phrase" ? "phrase" : null;
    const label = typeof s.label === "string" && s.label.trim() ? s.label.trim().slice(0, MAX_LABEL_LEN) : "My rule";
    if (!kind || (s.appliesTo !== "offer" && s.appliesTo !== "closure") || !validWeight(s.weight)) continue;
    const r: AlertRule = { id: s.id, label, kind, weight: Math.round(s.weight), enabled: s.enabled !== false, appliesTo: s.appliesTo, custom: true };
    if (kind === "phrase") r.patterns = cleanPatterns(s.patterns) ?? [];
    else r.regex = typeof s.regex === "string" ? s.regex : "";
    rules.push(r);
    byId.set(r.id, r);
  }
  for (const r of rules) {
    if (r.kind === "regex") {
      const p = regexProblem(r.regex ?? "");
      if (p) problems[r.id] = p;
    } else if (r.kind === "phrase" && !r.patterns?.length) problems[r.id] = "No phrases";
  }
  const threshold = validPct(raw?.threshold) ? Math.round(raw.threshold) : DEFAULT_ALERT_THRESHOLD;
  const closureThreshold = validPct(raw?.closureThreshold) ? Math.round(raw.closureThreshold) : DEFAULT_CLOSURE_THRESHOLD;
  return { threshold, closureThreshold, rules, problems };
}

/** The smallest thing to store for these rules: changed fields of default rules (by id) and the comic's own rules in full. */
export function toStoredAlertRules(r: ResolvedAlertRules): StoredAlertRules {
  const out: StoredAlertRule[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const rule of r.rules) {
    const def = DEFAULT_ALERT_RULES.find((d) => d.id === rule.id);
    if (!def) {
      out.push({ id: rule.id, label: rule.label, kind: rule.kind, patterns: rule.patterns, regex: rule.regex, weight: rule.weight, enabled: rule.enabled, appliesTo: rule.appliesTo });
      continue;
    }
    const o: StoredAlertRule = { id: rule.id };
    if (rule.enabled !== def.enabled) o.enabled = rule.enabled;
    if (rule.weight !== def.weight) o.weight = rule.weight;
    if (!same(rule.patterns, def.patterns)) o.patterns = rule.patterns;
    if (rule.regex !== def.regex) o.regex = rule.regex;
    if (Object.keys(o).length > 1) out.push(o);
  }
  const stored: StoredAlertRules = {};
  if (r.threshold !== DEFAULT_ALERT_THRESHOLD) stored.threshold = r.threshold;
  if (r.closureThreshold !== DEFAULT_CLOSURE_THRESHOLD) stored.closureThreshold = r.closureThreshold;
  if (out.length) stored.rules = JSON.parse(JSON.stringify(out)) as StoredAlertRule[];
  return stored;
}

const CONTACT_SIGNAL = /\b(dm|ping|message|msg|whatsapp)\b|(?<![\d:.]\s*)\bpm\b|@\S/i;
const TIME_SIGNAL = /\b(today|tonight|now|tomorrow|tmrw|asap|immediately|this (?:evening|afternoon|morning)|reach by|in\s+\d{1,3}\s*(?:mins?|minutes?))\b/i;

function builtinHit(b: BuiltinSignal, t: string, rooms: RoomLike[] | undefined): boolean {
  switch (b) {
    case "time":
      return TIME_SIGNAL.test(t) || parseTimes(t).length > 0;
    case "contact":
      return CONTACT_SIGNAL.test(t) || Boolean(namedContact(t));
    case "knownRoom":
      return Boolean(rooms?.length && resolveRoom(rooms, t).room);
    case "short":
      return t.length > 0 && t.length < 160;
    case "tiny":
      return t.length > 0 && t.length <= 40;
    case "long":
      return t.length > 400;
    case "question":
      return t.includes("?");
    case "questionNoContact":
      return t.includes("?") && !CONTACT_SIGNAL.test(t) && !namedContact(t);
    case "scheduleShape":
      return parseSchedule(t).length >= 2 && /\b(schedule|curat\w*|roster|lineup)\b/i.test(t);
    case "openingShape":
      return OPENING_RE.test(t);
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function phraseRegex(patterns: string[]): RegExp | null {
  const alts = patterns.map((p) => escapeRe(p.trim()).replace(/\s+/g, "\\s+")).filter(Boolean);
  return alts.length ? new RegExp(`(?<![A-Za-z0-9_])(?:${alts.join("|")})(?![A-Za-z0-9_])`, "i") : null;
}

/** Does this rule match the text? A rule with a problem, or switched off, never does. */
export function ruleMatches(r: AlertRule, text: string, rooms?: RoomLike[]): boolean {
  if (!r.enabled) return false;
  try {
    if (r.kind === "builtin") return r.builtin ? builtinHit(r.builtin, text, rooms) : false;
    if (r.kind === "phrase") return phraseRegex(r.patterns ?? [])?.test(text) ?? false;
    if (regexProblem(r.regex ?? "")) return false;
    return new RegExp(r.regex ?? "", "i").test(text);
  } catch {
    return false;
  }
}

export interface RuleScore {
  score: number;
  /** rule id -> points it added or took off, only the rules that matched. */
  parts: Record<string, number>;
  matched: { id: string; label: string; points: number }[];
}

const sumRules = (rules: AlertRule[], t: string, rooms: RoomLike[] | undefined): RuleScore => {
  const parts: Record<string, number> = {};
  const matched: RuleScore["matched"] = [];
  let sum = 0;
  for (const r of rules) {
    if (!r.weight || !ruleMatches(r, t, rooms)) continue;
    parts[r.id] = r.weight;
    matched.push({ id: r.id, label: r.label, points: r.weight });
    sum += r.weight;
  }
  return { score: Math.max(0, Math.min(100, sum)), parts, matched };
};

export interface FastRead {
  kind: GroupReadKind;
  /** Act now, no model: the score of that kind reached its threshold. */
  confident: boolean;
  /** 0-100 for `kind` (the offer score unless it is a closure). */
  score: number;
  parts: Record<string, number>;
  matched: RuleScore["matched"];
  threshold: number;
  offer: RuleScore;
  closure: RuleScore;
}

/**
 * Score a message as a spot offer and as a closure with the comic's rules. Pure and deterministic. Schedules and opening notices
 * are never confident whatever the rules say: the model reads those.
 */
export function classifyFast(text: string, opts: { rooms?: RoomLike[]; rules?: AlertRulesInput } = {}): FastRead {
  const cfg = opts.rules && "problems" in opts.rules ? opts.rules : resolveAlertRules(opts.rules);
  const t = text.trim().replace(/\s+/g, " ").slice(0, MAX_INPUT);
  const offer = sumRules(cfg.rules.filter((r) => r.appliesTo === "offer"), t, opts.rooms);
  const closure = sumRules(cfg.rules.filter((r) => r.appliesTo === "closure"), t, opts.rooms);
  const done = (kind: GroupReadKind, confident: boolean): FastRead => {
    const s = kind === "closure" ? closure : offer;
    return { kind, confident, score: s.score, parts: s.parts, matched: s.matched, threshold: kind === "closure" ? cfg.closureThreshold : cfg.threshold, offer, closure };
  };
  if (!t) return done("other", false);
  if (builtinHit("scheduleShape", t, undefined)) return done("schedule_update", false);
  if (builtinHit("openingShape", t, undefined)) return done("opening_notice", false);
  if (closure.score > offer.score && closure.score >= cfg.closureThreshold) return done("closure", true);
  if (offer.score >= cfg.threshold && SPOT_WORD.test(t)) return done("spot_offer", true);
  return done(closure.score > offer.score && closure.score > 0 ? "closure" : offer.score > 0 && SPOT_WORD.test(t) ? "spot_offer" : "other", false);
}

/**
 * Turn the model's (or the rules') answer into validated fields. A kind the text can't back up becomes "other": a model that says
 * "spot offer" for a message with no mention of a spot is wrong, and no push goes out for it.
 */
export function interpret(ai: AiRead, msg: GroupMsg, ctx: ReadCtx): Reading {
  const text = msg.text;
  const now = localParts(ctx.now, ctx.tz);
  const today = now.date;
  const found = findRoom(ctx.rooms, ai.room, text);
  // A name that fits several locations is settled by what the message and the group's history say (times only for offers).
  const settle = (times?: string[], date?: string): { room: RoomMatch<Room>; why?: string } => {
    if (found.room || found.candidates.length < 2) return { room: found };
    const d = disambiguateRoom(found.candidates, { text, times, date, groupId: msg.groupId, sender: msg.sender, curators: ctx.curators, history: ctx.history });
    return d.room ? { room: { room: d.room, candidates: [d.room] }, why: d.why } : { room: found };
  };
  const fieldsOf = (room: RoomMatch<Room>) => ({ roomId: room.room?.id, roomName: room.room?.name ?? roomNameOf(room.candidates) ?? (ai.room?.trim() || undefined) });
  let room = found;
  let roomFields = fieldsOf(room);

  switch (ai.kind) {
    case "spot_offer": {
      if (!SPOT_WORD.test(text)) return { kind: "other" };
      const { times, reachBy } = parseOfferTimes(text, now.time);
      const date = parseDayHint(text, today);
      const settled = settle(times, date);
      room = settled.room;
      roomFields = fieldsOf(room);
      const showId = showFor(room.room, ai.show);
      return {
        kind: "spot_offer",
        offer: {
          ...roomFields,
          showId,
          date,
          times,
          reachBy,
          contact: resolveContact({ sender: msg.sender, mentioned: msg.mentioned, text, kind: ai.contactKind, name: ai.contactName, directory: ctx.directory, selfId: ctx.selfId }),
          busking: /\bbusk\w*/i.test(text),
          long: /\blong\b/i.test(text),
          ambiguousRooms: !room.room && room.candidates.length > 1 ? room.candidates.map((r) => `${r.name}, ${r.area}`) : undefined,
          roomCandidates: !room.room && room.candidates.length > 1 ? room.candidates.map((r) => ({ id: r.id, name: r.name, area: r.area })) : undefined,
          roomWhy: settled.why,
        },
      };
    }
    case "closure": {
      if (!CLOSURE_RE.test(text)) return { kind: "other" };
      roomFields = fieldsOf(settle().room);
      const { scope, days } = parseClosureScope(text);
      return { kind: "closure", closure: { ...roomFields, scope, days, ranges: closureRanges(scope, days, today) } };
    }
    case "opening_notice": {
      if (!/\bopen/i.test(text)) return { kind: "other" };
      roomFields = fieldsOf(settle().room);
      const openAt = parseTimes(text.replace(/\bwill open\b/gi, "open"))[0];
      const website = /\bwebsite|registration|\.(in|com|co)\b/i.test(text);
      const where = roomFields.roomName ?? "A room";
      return { kind: "opening_notice", opening: { ...roomFields, openAt, website, summary: openAt ? `${where}: spots open by ${formatTime(openAt)}` : website ? `${where}: the website is open for spots` : `${where}: spots are opening` } };
    }
    case "schedule_update": {
      const entries = parseSchedule(text);
      if (!entries.length) return { kind: "other" };
      roomFields = fieldsOf(settle().room);
      return { kind: "schedule_update", schedule: { ...roomFields, entries } };
    }
    default:
      return { kind: "other" };
  }
}

/** The model's room name first, then anything in the message that names a room. */
function findRoom(rooms: Room[], hint: string | undefined, text: string): RoomMatch<Room> {
  const byHint = resolveRoom(rooms, hint);
  if (byHint.room || byHint.candidates.length) return byHint;
  return resolveRoom(rooms, text);
}

/** Two rooms of one chain tied: "Comedy Theatre" is still the name to show. */
function roomNameOf(candidates: Room[]): string | undefined {
  const names = new Set(candidates.map((r) => r.name));
  return names.size === 1 ? candidates[0]?.name : undefined;
}

function showFor(room: Room | null, hint: string | undefined): string | undefined {
  if (!room) return undefined;
  if (hint?.trim()) {
    const want = slug(hint);
    const hit = room.shows.find((s) => slug(s.name) === want || s.type === want);
    if (hit) return hit.id;
  }
  return room.shows.length === 1 ? room.shows[0]!.id : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------------------------------------------------------

/** Until when an offer can still be taken: reach-by, else the start of the last time offered, else the end of the day. */
export function alertExpiry(a: { date: string; times: string[]; reachBy?: string }, tz: string, receivedAt: number): number {
  if (a.reachBy) {
    const t = zonedToMs(a.date, a.reachBy, tz);
    // "reach by 12:10" said at 11:55 PM means after midnight.
    return t < receivedAt - 60_000 ? t + DAY_MS : t;
  }
  if (a.times.length) return zonedToMs(a.date, a.times[a.times.length - 1]!, tz);
  return zonedToMs(a.date, "23:59", tz);
}

/** A stable, Firestore-safe document id for the alert a message makes. */
export const alertIdFor = (groupId: string, messageId: string) => `${groupId}__${messageId}`.replace(/[^A-Za-z0-9_.@-]/g, "_").slice(0, 200);

/** "9:30 / 11 PM", "6 PM", "5:40 PM": no ":00", AM/PM only where it changes. */
export function timesShort(times: string[]): string {
  const parts = times.map((t) => {
    const f = formatTime(t);
    const [clock, mer] = f.split(" ");
    return { clock: clock!.replace(/:00$/, ""), mer: mer! };
  });
  return parts.map((p, i) => (i === parts.length - 1 || parts[i + 1]!.mer !== p.mer ? `${p.clock} ${p.mer}` : p.clock)).join(" / ");
}

/** The first name, for "Hi Dhruv". */
export const givenName = (name: string | undefined) => (name ?? "").replace(/^@/, "").trim().split(/\s+/)[0] ?? "";

/** What the push says: "Spot at TAG today 9:30 / 11 PM", then "DM Dhruv · reach by 5:40 PM". Times that clash with a booked spot are left out. */
export function alertPush(alert: SpotAlert, mySpots: MySpot[], today: string): { title: string; body: string } {
  const { free } = alertClash(alert, mySpots);
  const times = free.length ? free : alert.times;
  const where = alert.roomName ?? "a room";
  const kind = alert.busking ? "Busking spot" : alert.long ? "Long spot" : "Spot";
  const when = [alertDayLabel(alert.date, today), times.length ? timesShort(times) : ""].filter(Boolean).join(" ");
  const who = alert.contact.name ? `DM ${givenName(alert.contact.name) || alert.contact.name}` : "DM them";
  return { title: `${kind} at ${where} ${when}`.trim(), body: [who, alert.reachBy ? `reach by ${formatTime(alert.reachBy)}` : ""].filter(Boolean).join(" · ") };
}

/** The message "Ask for it" starts with: the comic can edit it before it goes. */
export const ASK_TEMPLATE = "Hi {{name}}, I can do the {{time}} spot at {{room}} {{day}}!";
export function renderAlertAsk(v: { name?: string; time?: string; room?: string; day: string }): string {
  const when = v.time ? `the ${formatTime(v.time)} spot` : "a spot";
  return ASK_TEMPLATE.replace("{{name}}", givenName(v.name) || "there")
    .replace("the {{time}} spot", when)
    .replace("{{room}}", v.room || "your room")
    .replace("{{day}}", /^(today|tomorrow)$/.test(v.day) ? v.day : `on ${v.day}`)
    .replace(/ {2,}/g, " ");
}

export type AlertState = "open" | "asked" | "closed" | "expired" | "dismissed";
/** What an alert is right now: an unexpired one the worker hasn't swept yet still counts as expired. */
export function alertState(a: Pick<SpotAlert, "status" | "expiresAt">, now: number): AlertState {
  if (a.status === "closed" || a.status === "dismissed") return a.status;
  if (a.status === "expired" || a.expiresAt <= now) return "expired";
  return a.status === "asked" ? "asked" : "open";
}

/** "34 min left", "2 h left", "ended". */
export function timeLeft(expiresAt: number, now: number): string {
  const min = Math.ceil((expiresAt - now) / 60_000);
  if (min <= 0) return "ended";
  if (min < 60) return `${min} min left`;
  const h = Math.floor(min / 60);
  return min % 60 && h < 6 ? `${h} h ${min % 60} min left` : `${h} h left`;
}

/** Alerts the comic can still act on, soonest to end first. */
export const openAlerts = (alerts: SpotAlert[], now: number) =>
  alerts.filter((a) => ["open", "asked"].includes(alertState(a, now))).sort((a, b) => a.expiresAt - b.expiresAt);

/** The booked spot an alert clashes with, in words, or null. A clash only matters when every offered time clashes. */
export function clashNote(alert: Pick<SpotAlert, "date" | "times">, mySpots: MySpot[]): { with: string; times: string[] } | null {
  const r = alertClash(alert, mySpots);
  if (!r.clash) return null;
  const other = clashes(mySpots, { date: alert.date, time: r.clashing[0] })[0];
  return { with: [other?.roomName, other?.time ? formatTime(other.time) : ""].filter(Boolean).join(" ") || "a spot you have", times: r.clashing };
}
