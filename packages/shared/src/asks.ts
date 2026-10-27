// Nothing BOT Comedy: asking rooms for spots. Pure rules on top of rooms.ts: which asks to make for a date range, who to ask, when the
// window opens and closes, the message, and what a push reminder should say. No UI, no worker.
// Dates are ISO "YYYY-MM-DD" and times "HH:MM" in the comic's own time zone, like the rest of the room model.
import {
  isoAddDays as addDays,
  askRuleFor,
  curatorFor,
  isFull,
  isPaused,
  limitsBlock,
  localDate,
  nextAskWindow,
  showDates,
  weekdayOf,
  type Ask,
  type AskStatus,
  type Curator,
  type LimitHit,
  type MySpot,
  type Room,
  type RoomShow,
} from "./rooms.ts";
import { renderTemplate } from "./template.ts";
import { formatDate, formatTime, DAY_NAMES } from "./week.ts";
import type { Weekday } from "./types.ts";

// ---------------------------------------------------------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------------------------------------------------------

/** What a comic's ask says until they change it (Asks > Message). */
export const DEFAULT_ASK_TEMPLATE = "Hey {{curator}}! Could I get a spot at {{show}} on {{day}} {{date}}? Thanks 🙏";

export const ASK_VARIABLES = [
  { key: "curator", label: "Curator's first name", sample: "Aditya" },
  { key: "show", label: "Room and show", sample: "Bloom Indiranagar" },
  { key: "room", label: "Room", sample: "Bloom Indiranagar" },
  { key: "day", label: "Day", sample: "Thursday" },
  { key: "date", label: "Date", sample: "29 Oct" },
  { key: "time", label: "Start time", sample: "8:00 PM" },
] as const;

const GENERIC_SHOW = new Set(["mic", "show", "open mic", "mic and show", "both"]);

/** "Bloom Indiranagar" for a room with one plain "Mic"; "Glen's Bakehouse Late show" when the show name tells shows apart. */
export function askShowLabel(room: Pick<Room, "name" | "shows">, show: Pick<RoomShow, "name">): string {
  const n = show.name.trim();
  if (!n || (GENERIC_SHOW.has(n.toLowerCase()) && room.shows.length <= 1)) return room.name;
  return n.toLowerCase().includes(room.name.toLowerCase()) ? n : `${room.name} ${n}`;
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

export interface AskFacts {
  curatorName?: string;
  roomName: string;
  /** Room and show, as it reads in the message. */
  show: string;
  showDate: string;
  time?: string;
}

/** The template's variables for one ask. */
export function askVars(f: AskFacts): Record<string, string> {
  return {
    curator: firstName(f.curatorName ?? "") || "there",
    show: f.show,
    room: f.roomName,
    day: DAY_NAMES[weekdayOf(f.showDate)],
    date: formatDate(f.showDate),
    time: f.time ? formatTime(f.time) : "",
  };
}

/** The ask as it would go out. A blank template falls back to the default. */
export function renderAsk(template: string | undefined, f: AskFacts): string {
  return renderTemplate(template?.trim() ? template : DEFAULT_ASK_TEMPLATE, askVars(f));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------------------------------------------------------

const HOUR_MS = 3_600_000;

/** Offset of `tz` from UTC at a moment, in ms (local minus UTC). */
function tzOffsetMs(at: number, tz: string): number {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(at / 1000) * 1000;
}

/** The instant (ms) a wall-clock date and time happens in `tz`. */
export function zonedMs(date: string, time: string, tz: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, h!, mi || 0);
  const first = guess - tzOffsetMs(guess, tz);
  const second = guess - tzOffsetMs(first, tz);
  return second;
}

// ---------------------------------------------------------------------------------------------------------------------------
// What to ask
// ---------------------------------------------------------------------------------------------------------------------------

/** Asks go out from this time on the ping day (nobody wants a DM at midnight). */
export const ASK_SEND_FROM = "09:00";
/** Reminder before the window closes. */
export const CLOSING_SOON_MS = 2 * HOUR_MS;

/** One ask to make: a show on a date. `doc` is the saved draft, when there is one. */
export interface PlannedAsk {
  /** The document id: one per show date. */
  id: string;
  roomId: string;
  roomName: string;
  showId: string;
  showName: string;
  /** How the room and show read in a message. */
  label: string;
  showDate: string;
  weekday: Weekday;
  /** The one start time, when the show has one that day. */
  time?: string;
  /** The day to ping. */
  askOn: string;
  /** "Ping Monday morning". */
  ruleLabel: string;
  /** open: the ping day has come. upcoming: it hasn't. */
  state: "open" | "upcoming";
  /** today: the ping day is today. overdue: it has gone and the show hasn't. later: still to come. */
  due: "today" | "overdue" | "later";
  /** Earliest moment the ask should go out (ms): 9 AM on the ping day, or earlier when the show is early. */
  sendFrom: number;
  /** When the window closes (ms): the show starts. */
  closesAt: number;
  curatorId?: string;
  curatorName?: string;
  curatorPhone?: string;
  standIn: boolean;
  /** There is someone to message: a curator with a number. */
  canSend: boolean;
  /** The ask would take me over a limit I set for this room. */
  blocked: boolean;
  hits: LimitHit[];
  mode: "auto" | "review";
  doc?: Ask;
}

export const askId = (roomId: string, showId: string, showDate: string) => `${showDate}_${roomId}_${showId}`;

/** An ask is done with: a reply (or a miss) settled it, or the comic skipped it. A draft (planned) is not. */
export const askHandled = (a: Pick<Ask, "status" | "skipped">) => Boolean(a.skipped) || (["sent", "got_it", "declined", "no_reply"] as AskStatus[]).includes(a.status);

export interface PlanContext {
  asks?: Ask[];
  mySpots?: MySpot[];
}

const openAsksOnly = (a: PlannedAsk) => a.state === "open";

/**
 * The asks to make for show dates in [range.from, range.to]: a show date with a ping rule, a curator to message (or at least a
 * room to ask), not full or paused, not already asked, skipped or booked. My own shows (I curate it) and "they'll reach out"
 * days are left out. Ordered by show date. Window state is read against `now`.
 */
export function planAsks(rooms: Room[], curators: Curator[], range: { from: string; to: string }, now: Date, tz: string, ctx: PlanContext = {}): PlannedAsk[] {
  const out: PlannedAsk[] = [];
  const today = localDate(now, tz);
  const asks = new Map((ctx.asks ?? []).map((a) => [a.id, a]));
  const spots = (ctx.mySpots ?? []).filter((s) => s.status !== "cancelled" && s.happened !== false);
  for (const room of rooms) {
    for (const show of room.shows) {
      if (show.myRole === "curator") continue;
      for (const showDate of showDates(show, range.from, range.to)) {
        if (showDate < today || isFull(show, showDate) || isPaused(room, show, showDate)) continue;
        const weekday = weekdayOf(showDate);
        const plan = show.days.find((d) => d.weekday === weekday);
        if (plan?.theyReachOut) continue;
        const window = nextAskWindow(askRuleFor(show, weekday), showDate, now, tz);
        if (window.kind !== "ask" || !window.date || (window.state !== "open" && window.state !== "upcoming")) continue;
        const id = askId(room.id, show.id, showDate);
        const doc = asks.get(id);
        if (doc && askHandled(doc)) continue;
        if (spots.some((s) => s.roomId === room.id && s.date === showDate && (s.showId === show.id || (s.source === "regular" && !s.showId)))) continue;
        const c = curatorFor(show, weekday, curators, showDate);
        const times = plan?.times?.length ? plan.times : show.times;
        const time = times.length === 1 ? times[0] : undefined;
        const closesAt = zonedMs(showDate, [...times].sort().at(-1) ?? "23:59", tz);
        const dayStart = zonedMs(window.date, "00:00", tz);
        const sendFrom = Math.max(dayStart, Math.min(zonedMs(window.date, ASK_SEND_FROM, tz), closesAt - 3 * HOUR_MS));
        const limit = limitsBlock(room, ctx.mySpots ?? [], { date: showDate, showId: show.id, source: "ask" });
        const phone = c.primary?.phone?.trim();
        out.push({
          id,
          roomId: room.id,
          roomName: room.name,
          showId: show.id,
          showName: show.name,
          label: askShowLabel(room, show),
          showDate,
          weekday,
          time,
          askOn: window.date,
          ruleLabel: window.label,
          state: window.state,
          due: window.date === today ? "today" : window.date < today ? "overdue" : "later",
          sendFrom,
          closesAt,
          curatorId: c.primary?.id,
          curatorName: c.primary?.name,
          curatorPhone: phone || undefined,
          standIn: c.standInActive,
          canSend: Boolean(c.primary && phone),
          blocked: limit.blocked,
          hits: limit.hits,
          mode: room.askMode === "auto" ? "auto" : "review",
          doc,
        });
      }
    }
  }
  return out.sort((a, b) => a.showDate.localeCompare(b.showDate) || a.label.localeCompare(b.label));
}

/** "Over your limit: 2 a week" for the first limit an ask would break. */
export function limitsText(hits: LimitHit[]): string {
  const h = hits[0];
  if (!h) return "";
  const per = h.per === "day" ? "a day" : h.per === "week" ? "a week" : "a month";
  return `Over your limit: ${h.max} ${per}${h.limit.scope === "show" ? " at this show" : ""}`;
}

/** Asks open now, soonest to close first. */
export const openNow = (plan: PlannedAsk[]) => plan.filter(openAsksOnly).sort((a, b) => a.closesAt - b.closesAt || a.label.localeCompare(b.label));

export interface UpcomingGroup {
  /** The day these open. */
  date: string;
  asks: PlannedAsk[];
}

/** Asks that haven't opened yet, grouped by the day they open, in date order. Only the next `days` days. */
export function upcomingGroups(plan: PlannedAsk[], today: string, days = 7): UpcomingGroup[] {
  const last = addDays(today, days);
  const map = new Map<string, PlannedAsk[]>();
  for (const a of plan) {
    if (a.state !== "upcoming" || a.askOn > last) continue;
    map.set(a.askOn, [...(map.get(a.askOn) ?? []), a]);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, asks]) => ({ date, asks }));
}

/** "Tomorrow", "Thursday", "Thu 29 Oct" for a day relative to today. */
export function askDayLabel(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  if (date === addDays(today, -1)) return "Yesterday";
  const diff = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  const name = DAY_NAMES[weekdayOf(date)];
  return diff > 0 && diff < 7 ? name : `${name.slice(0, 3)} ${formatDate(date)}`;
}

/** "45 min", "6 h", "2 days": a span of time in plain words. */
export function spanLabel(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/** "Closes in 6 h", or "Closed" once the show has started. */
export const closesLabel = (closesAt: number, now: number) => (closesAt <= now ? "Closed" : `Closes in ${spanLabel(closesAt - now)}`);

/** "Opens tomorrow at 9 AM". */
export function opensLabel(a: Pick<PlannedAsk, "askOn" | "sendFrom">, today: string, tz: string): string {
  const time = new Intl.DateTimeFormat("en-IN", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(a.sendFrom)).replace(/\s?(am|pm)/i, (_, ap: string) => ` ${ap.toUpperCase()}`);
  const day = askDayLabel(a.askOn, today);
  return `Opens ${day === "Today" ? "today" : day === "Tomorrow" ? "tomorrow" : day} at ${time.replace(":00", "")}`;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Reminders and auto-send (the worker's decisions, kept pure so they are tested)
// ---------------------------------------------------------------------------------------------------------------------------

export type AskDue = "send" | "remind_open" | "remind_closing" | null;

/**
 * What to do about an open ask right now.
 * - auto room: send once the window is open and it is past `sendFrom` (never a blocked or numberless one; never twice).
 * - review room: one reminder when it opens, one about two hours before it closes (only when the window was open for longer than
 *   that, so the two never land together).
 */
export function askDue(a: Pick<PlannedAsk, "state" | "mode" | "canSend" | "blocked" | "sendFrom" | "closesAt" | "doc">, nowMs: number): AskDue {
  if (a.state !== "open" || nowMs >= a.closesAt || nowMs < a.sendFrom) return null;
  if (a.doc && a.doc.status !== "planned") return null;
  if (a.mode === "auto") return a.canSend && !a.blocked && !a.doc?.error && !a.doc?.sentAt ? "send" : null;
  if (!a.doc?.remindedOpenAt) return "remind_open";
  const closing = a.closesAt - CLOSING_SOON_MS;
  if (!a.doc.remindedCloseAt && nowMs >= closing && closing - a.doc.remindedOpenAt >= CLOSING_SOON_MS / 2) return "remind_closing";
  return null;
}

/** Push text for a reminder. */
export function reminderText(a: Pick<PlannedAsk, "label" | "showDate" | "curatorName" | "closesAt">, kind: "open" | "closing", today: string, nowMs: number): string {
  const when = `${askDayLabel(a.showDate, today)}${a.showDate === today ? "" : ` ${formatDate(a.showDate)}`}`.replace(/^Today/, "tonight");
  const who = a.curatorName ? ` Ask ${firstName(a.curatorName)}.` : "";
  return kind === "open" ? `Time to ask for a spot at ${a.label} ${when}.${who}` : `${a.label} ${when}: the ask closes in ${spanLabel(a.closesAt - nowMs)}.${who}`;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------------------------------------------------------

const YES_EMOJI = /^[\s👍👌✅🙌🤝🔥🙏💯😊😄😁🤙❤️💪👏🎤]+$/u;
const NO_EMOJI = /^[\s👎❌🚫😔😞🙅]+$/u;

/** A reply that is only an emoji: yes-ish or no-ish. Both are "unsure" (shown for the comic to confirm). */
export function emojiReply(text: string): "got_it" | "declined" | null {
  const t = text.trim();
  if (!t) return null;
  if (YES_EMOJI.test(t)) return "got_it";
  if (NO_EMOJI.test(t)) return "declined";
  return null;
}

/** Asks that are waiting on a reply and should still be read: sent, show not yet over by more than a day. */
export const awaitingReply = (a: Pick<Ask, "status" | "showDate">, today: string) => a.status === "sent" && a.showDate >= addDays(today, -1);

/** Past its show date with no reply read: it drops off as "no reply". */
export const missedReply = (a: Pick<Ask, "status" | "showDate" | "lastReply">, today: string) => a.status === "sent" && a.showDate < today && !a.lastReply;

/** Planned drafts for show dates that have gone by: they just expire. */
export const draftExpired = (a: Pick<Ask, "status" | "showDate">, today: string) => a.status === "planned" && a.showDate < today;

// ---------------------------------------------------------------------------------------------------------------------------
// From an ask to a spot
// ---------------------------------------------------------------------------------------------------------------------------

/** The My spot that a confirmed ask becomes. The id is the ask's, so confirming twice never makes two. */
export function spotFromAsk(ask: Ask, room: Pick<Room, "name"> | undefined, time: string | undefined, now: number): MySpot {
  return {
    id: `ask_${ask.id}`,
    date: ask.showDate,
    ...(time || ask.time ? { time: time ?? ask.time } : {}),
    roomId: ask.roomId,
    showId: ask.showId,
    roomName: room?.name ?? ask.roomName ?? "",
    source: "ask",
    askId: ask.id,
    happened: null,
    status: "booked",
    createdAt: now,
  };
}
