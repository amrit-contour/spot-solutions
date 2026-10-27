// Nothing BOT Comedy: the comic's rooms (venues), shows, curators, asks and spots, plus the pure rules on them.
// Data model and rules only: no UI, no worker. See docs/plans/comic-app.md ("Data model (built)").
// Dates are ISO "YYYY-MM-DD", times "HH:MM" (24h), both in the comic's own time zone. Weekday 0 = Sunday.
import { DAY_NAMES } from "./week.ts";
import type { Weekday } from "./types.ts";

// ---------------------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------------------

/** Tags to tap, plus any custom string. They are pills, never rules. */
export const SUGGESTED_TAGS = ["english-only", "new-comics", "experienced-only", "bringer", "paid-entry", "walk-in", "check-bms"] as const;
export type SuggestedTag = (typeof SUGGESTED_TAGS)[number];
export type RoomTag = SuggestedTag | (string & {});

/** In a roster a comic can mark "I'm a regular at this show" or "I curate this one". Private. */
export type MyRole = "regular" | "curator";

/**
 * When to ask for a show date. Only same_day..start_of_month produce a date to ping; they_reach_out waits for the curator;
 * fcfs / walk_in / website / instagram are notes (never an action in the app).
 */
export type AskRule = (
  | { kind: "same_day"; morning?: boolean }
  | { kind: "day_before"; morning?: boolean }
  /** The latest `day` on or before the show ("ping Mondays"). */
  | { kind: "weekday"; day: Weekday; morning?: boolean }
  /** `day` of the Monday-to-Sunday week the show is in; Sunday (0) means the Sunday before that week. Default Monday. */
  | { kind: "start_of_week"; day?: Weekday }
  | { kind: "start_of_month" }
  | { kind: "they_reach_out" }
  | { kind: "fcfs" }
  | { kind: "walk_in" }
  | { kind: "website" }
  | { kind: "instagram" }
) & { note?: string };
export type AskRuleKind = AskRule["kind"];

/** Anything that isn't a WhatsApp DM: a note on the room, never an action. */
export interface RoomNote {
  kind: "instagram" | "website" | "walk_in" | "check_bms" | "fcfs" | "other";
  /** instagram: handle without the @. */
  handle?: string;
  /** website: address. */
  url?: string;
  /** Free text (a password hint, "registration starts at 5 PM"). */
  text?: string;
}

/** Only the rule that is set is enforced; none means no limit. `unlimited` says so explicitly (and exempts the scope). */
export interface Limit {
  scope: "room" | "show";
  /** scope "show": which show. */
  showId?: string;
  perDay?: number;
  perWeek?: number;
  perMonth?: number;
  unlimited?: boolean;
}

export interface Pin {
  lat: number;
  lng: number;
  mapsUrl?: string;
  /** The place name the pin was found with. */
  label?: string;
}

/** A show is full for a period: from a group message ("Spots full Square Sunday") or by hand. */
export interface Closure {
  /** Default: from now. */
  from?: string;
  /** Last date it is full (inclusive). */
  until: string;
  source: "group_message" | "manual";
  note?: string;
  at?: number;
  groupId?: string;
  messageId?: string;
}

/** One weekday of a show. Curators in order: the first is the one to ask, the rest are co-curators. */
export interface DayPlan {
  weekday: Weekday;
  /** Overrides the show's times for this day ("weekends 5:30 PM"). */
  times?: string[];
  curatorIds: string[];
  /** "Tarun himself will reach out": nothing to ask, wait for them. */
  theyReachOut?: boolean;
  /** A stand-in while the curator is away. Private (it is temporary). */
  standIn?: { curatorId: string; until: string };
  /** Overrides the show's ask rule for this day. */
  askRule?: AskRule;
  note?: string;
}

/** The shareable part of a show. */
export interface ShowShared {
  id: string;
  /** "Mic", "Show", "Late show"... */
  name: string;
  type: "mic" | "show" | "both";
  cadence: "daily" | "weekly" | "monthly";
  /** Monthly shows: which occurrences of the weekday (1..5; -1 = the last). Empty: any. */
  monthlyWeeks?: number[];
  /** Default time slots; a day can override. */
  times: string[];
  days: DayPlan[];
  askRule?: AskRule;
  tags?: RoomTag[];
  note?: string;
}

export interface RoomShow extends ShowShared {
  myRole?: MyRole;
  closures?: Closure[];
  /** Seasonal break. */
  pausedUntil?: string;
  myNotes?: string;
}

/** The shareable part of a room (a venue). Two locations of one brand are two rooms with the same `brand`. */
export interface RoomShared {
  id: string;
  name: string;
  /** Shared by the locations of one chain ("Comedy Theatre", "Bloom"). */
  brand?: string;
  area: string;
  city: string;
  pin?: Pin;
  aliases: string[];
  tags: RoomTag[];
  notes: RoomNote[];
  limits: Limit[];
  shows: ShowShared[];
}

export interface Room extends Omit<RoomShared, "shows"> {
  shows: RoomShow[];
  myNotes?: string;
  pausedUntil?: string;
  /** Private. When an ask window opens: send the ask by itself ("auto") or leave it as a draft to review ("review", the default). */
  askMode?: "auto" | "review";
}

export interface Curator {
  id: string;
  name: string;
  phone?: string;
  instagram?: string;
  /** Private. */
  notes?: string;
  /** Same person as a Comics entry when the number matches. Private. */
  comicId?: string;
}
export type CuratorShared = Pick<Curator, "id" | "name" | "phone" | "instagram">;

/** A personal roster: the rooms and curators the comic keeps (users/{uid}/rooms and /curators). */
export interface Roster {
  rooms: Room[];
  curators: Curator[];
}
export interface SharedRoster {
  rooms: RoomShared[];
  curators: CuratorShared[];
}

export type AskStatus = "planned" | "sent" | "got_it" | "declined" | "no_reply" | "expired";

/** What the curator's reply to an ask was read as. `unclear` waits for the comic to decide. */
export interface AskReply {
  text: string;
  at: number;
  messageId?: string;
  decision: "got_it" | "declined" | "unclear";
  /** The reply was only an emoji or a one-word yes, so it is worth a second look. */
  unsure?: boolean;
  /** A time the curator named (HH:MM), when the ask didn't have one. */
  time?: string;
}

export interface Ask {
  id: string;
  roomId: string;
  showId: string;
  /** The show date being asked for. */
  showDate: string;
  /** Time slot, when one was asked for. */
  time?: string;
  curatorId?: string;
  /** The day the ask is due to go out. */
  askOn?: string;
  status: AskStatus;
  message?: string;
  sentAt?: number;
  /** The curator's reply that settled it. */
  evidence?: { text: string; at: number; messageId?: string };
  createdAt: number;
  /** Denormalised so an ask outlives its room and reads well in a list. */
  roomName?: string;
  showName?: string;
  curatorName?: string;
  /** How it was meant to go out: the worker sent it by itself ("auto") or the comic reviewed it ("review"). */
  mode?: "auto" | "review";
  /** Write it in the comic's own voice when it is sent (only does anything when "Your voice" is on). Default on. */
  voice?: boolean;
  /** The comic chose to skip this one: it is not offered again. */
  skipped?: boolean;
  /** WhatsApp ids from the send, so replies are read from the right chat after the send. */
  messageId?: string;
  chatId?: string;
  /** Why the last send failed. */
  error?: string;
  /** The worker is sending it right now (guards against a double send). */
  sendingAt?: number;
  /** The window closes at this time (ms): the show's start. */
  closesAt?: number;
  /** When the "window is open" and "closing soon" reminders went out (ms). */
  remindedOpenAt?: number;
  remindedCloseAt?: number;
  /** The latest reply read, kept while the comic still has to confirm it. */
  lastReply?: AskReply;
  /** The worker looked for replies up to this time (ms). */
  readAt?: number;
}

export type SpotSource = "ask" | "adhoc" | "group_offer" | "regular";
export interface SpotNotes {
  room?: string;
  crowd?: string;
  /** 1 to 5. */
  rating?: number;
  whatWorked?: string;
  whatDidnt?: string;
  setList?: string;
}
export interface MySpot {
  id: string;
  date: string;
  time?: string;
  roomId?: string;
  showId?: string;
  /** Denormalised so a spot outlives its room. */
  roomName?: string;
  source: SpotSource;
  askId?: string;
  alertId?: string;
  /** null until the post-show check. */
  happened?: boolean | null;
  status?: "booked" | "cancelled";
  notes?: SpotNotes;
  /** Reserved for later (audio upload / recording with cloud transcription). Nothing writes it yet. */
  audio?: { storagePath?: string; durationSec?: number; transcript?: string } | null;
  createdAt: number;
}

/** A spot offer read from a watched group (users/{uid}/spotAlerts/{id}, written by the worker, cleared by the comic). */
export interface SpotAlert {
  id: string;
  groupId: string;
  groupName?: string;
  messageId: string;
  poster: { id: string; name?: string };
  /** A short quote of the message (never the whole chat). */
  text?: string;
  roomId?: string;
  /** The room as the comic knows it, or as the poster wrote it when it isn't one of theirs. */
  roomName?: string;
  showId?: string;
  date: string;
  times: string[];
  /** HH:MM: reach them by then. */
  reachBy?: string;
  /** Who to DM: the sender, or the person mentioned/tagged. */
  contact: { id: string; name?: string; kind: "sender" | "mentioned" };
  /** Busking and long spots are flagged, never filtered. */
  busking?: boolean;
  long?: boolean;
  /** Every offered time clashes with a spot already booked: no push was sent, the card says so. */
  clash?: { with: string; times: string[] };
  /** 0-100: how sure the rules were that this is a spot offer, and what each signal added (+) or took off (-). */
  score?: number;
  scoreParts?: Record<string, number>;
  expiresAt: number;
  status: "new" | "asked" | "dismissed" | "expired" | "closed";
  receivedAt: number;
  closedAt?: number;
  askedAt?: number;
  /** What the comic sent. */
  askText?: string;
}

export interface WatchedGroup {
  /** WhatsApp group id. */
  id: string;
  name: string;
  /** Apply roster changes read from this group (off: they become Updates items). */
  autoApply?: boolean;
  addedAt: number;
}

/** A published roster (publishedRosters/{id}): rooms only, shareable fields only, readable by signed-in allowed users. */
export interface PublishedRoster extends SharedRoster {
  id: string;
  title: string;
  city: string;
  ownerUid: string;
  ownerName?: string;
  coMaintainers: string[];
  /** Bumps on every push or approved suggestion. */
  version: number;
  updatedAt: number;
}

/** What a follower remembers about a published roster (users/{uid}/rosterFollows/{rosterId}). */
export interface RosterFollow {
  rosterId: string;
  /** The version last merged or dismissed: "update available" when the roster's is higher. */
  seenVersion: number;
  followedAt: number;
}

export interface RosterSuggestion {
  id: string;
  byUid: string;
  byName?: string;
  /** What it is about: a room, a show in it, a field of either (see RosterChange.field). */
  target: { roomId: string; showId?: string; field?: string };
  kind: "add" | "change" | "remove";
  before?: unknown;
  after?: unknown;
  note?: string;
  /** The roster version the suggester was looking at. */
  baseVersion: number;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  decidedBy?: string;
  decidedAt?: number;
}

/** publishers/{uid}: admin-edited. The admin can publish without being listed. */
export interface Publisher {
  uid: string;
  email?: string;
  name?: string;
  addedBy: string;
  addedAt: number;
}
export type PublisherList = Publisher[];

export const canPublish = (uid: string, list: PublisherList, isAdmin: boolean) => isAdmin || list.some((p) => p.uid === uid);
export const canMaintain = (roster: Pick<PublishedRoster, "ownerUid" | "coMaintainers">, uid: string) =>
  roster.ownerUid === uid || roster.coMaintainers.includes(uid);

// ---------------------------------------------------------------------------------------------------------------------------
// Ids and keys
// ---------------------------------------------------------------------------------------------------------------------------

export const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** An id for a new room: the name, plus the area unless the name already has it. */
export const newRoomId = (name: string, area: string) => {
  const n = slug(name);
  const a = slug(area);
  return !a || n.includes(a) ? n : `${n}-${a}`;
};

/** How rooms/shows/curators are matched across rosters when their ids differ. */
export const roomKey = (r: Pick<RoomShared, "name" | "area">) => `${slug(r.name)}|${slug(r.area)}`;
export const showKey = (s: Pick<ShowShared, "name" | "type">) => slug(s.name) || s.type;
export const curatorKey = (c: Pick<Curator, "name">) => slug(c.name);

// ---------------------------------------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const toMs = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
};
const addDays = (iso: string, n: number) => new Date(toMs(iso) + n * DAY_MS).toISOString().slice(0, 10);
export const weekdayOf = (iso: string) => new Date(toMs(iso)).getUTCDay() as Weekday;
const mondayOf = (iso: string) => addDays(iso, -((weekdayOf(iso) + 6) % 7));
/** The same date helpers, for the rest of the comic rules (asks, spots). */
export const isoAddDays = addDays;
export const isoMondayOf = mondayOf;
const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + (m || 0);
};
/** Today's calendar date in `tz`. */
export const localDate = (at: Date, tz: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);



/** Occurrence of this weekday within its month: 1..5 (and -1 when it is the last one). */
const occurrences = (iso: string): number[] => {
  const n = Math.ceil(Number(iso.slice(8, 10)) / 7);
  return addDays(iso, 7).slice(0, 7) !== iso.slice(0, 7) ? [n, -1] : [n];
};

/** Dates in [from, to] (inclusive) the show runs on. Monthly shows honour `monthlyWeeks`. */
export function showDates(show: Pick<ShowShared, "days" | "cadence" | "monthlyWeeks">, from: string, to: string): string[] {
  const out: string[] = [];
  const days = new Set(show.days.map((d) => d.weekday));
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!days.has(weekdayOf(d))) continue;
    if (show.cadence === "monthly" && show.monthlyWeeks?.length && !occurrences(d).some((o) => show.monthlyWeeks!.includes(o))) continue;
    out.push(d);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// When to ask
// ---------------------------------------------------------------------------------------------------------------------------

export const ASK_ACTION_KINDS: AskRuleKind[] = ["same_day", "day_before", "weekday", "start_of_week", "start_of_month"];
export const ASK_NOTE_KINDS: AskRuleKind[] = ["fcfs", "walk_in", "website", "instagram"];

export interface AskWindow {
  /** ask: ping on `date`. wait: they reach out. note: not a DM (walk-in, website...). none: no rule set. */
  kind: "ask" | "wait" | "note" | "none";
  /** The day the ask should go out (null unless kind is "ask"). */
  date: string | null;
  /** Best sent in the morning. */
  morning: boolean;
  /** "Ping Monday morning". */
  label: string;
  /** Relative to `now`: before the ping day, from the ping day until the show, or after the show. */
  state: "upcoming" | "open" | "passed" | "none";
}

export function askRuleLabel(rule: AskRule | undefined): string {
  if (!rule) return "No ask rule";
  const am = "morning" in rule && rule.morning ? " morning" : "";
  switch (rule.kind) {
    case "same_day": return `Ping same day${am}`;
    case "day_before": return `Ping previous day${am}`;
    case "weekday": return `Ping ${DAY_NAMES[rule.day]}${am}`;
    case "start_of_week": return rule.day === undefined || rule.day === 1 ? "Ping at the start of the week" : `Ping ${DAY_NAMES[rule.day]}, the start of the week`;
    case "start_of_month": return "Ping at the start of the month";
    case "they_reach_out": return "They'll reach out";
    case "fcfs": return "First come, first served";
    case "walk_in": return "Walk in";
    case "website": return "Register on the website";
    case "instagram": return "Ask on Instagram";
  }
}

/** The ping date for a show date, or null for rules that aren't a ping. */
export function askDate(rule: AskRule | undefined, showDate: string): string | null {
  if (!rule) return null;
  let d: string | null = null;
  switch (rule.kind) {
    case "same_day": d = showDate; break;
    case "day_before": d = addDays(showDate, -1); break;
    case "weekday": d = addDays(showDate, -((weekdayOf(showDate) - rule.day + 7) % 7)); break;
    case "start_of_week": {
      const day = rule.day ?? 1;
      const mon = mondayOf(showDate);
      d = day === 0 ? addDays(mon, -1) : addDays(mon, day - 1);
      break;
    }
    case "start_of_month": d = `${showDate.slice(0, 7)}-01`; break;
    default: return null;
  }
  return d > showDate ? showDate : d;
}

/**
 * When to ask for the show on `showDate`, and where `now` (in `tz`) stands against it. The window is "open" from the ping day
 * until the show is over, so a missed ping still shows up (as overdue in `asksOpen`).
 */
export function nextAskWindow(rule: AskRule | undefined, showDate: string, now: Date, tz: string): AskWindow {
  const label = askRuleLabel(rule);
  if (!rule) return { kind: "none", date: null, morning: false, label, state: "none" };
  if (rule.kind === "they_reach_out") return { kind: "wait", date: null, morning: false, label, state: "none" };
  const date = askDate(rule, showDate);
  if (!date) return { kind: "note", date: null, morning: false, label, state: "none" };
  const today = localDate(now, tz);
  const state = today > showDate ? "passed" : today < date ? "upcoming" : "open";
  return { kind: "ask", date, morning: "morning" in rule && Boolean(rule.morning), label, state };
}

/** The ask rule for one weekday of a show: the day's own, else the show's. */
export const askRuleFor = (show: Pick<ShowShared, "days" | "askRule">, weekday: Weekday): AskRule | undefined =>
  show.days.find((d) => d.weekday === weekday)?.askRule ?? show.askRule;

export interface OpenAsk {
  roomId: string;
  showId: string;
  showDate: string;
  weekday: Weekday;
  window: AskWindow;
  /** today: the ping day is today. overdue: the ping day has gone but the show hasn't. */
  due: "today" | "overdue";
  curatorIds: string[];
  /** The planned ask would be over a limit (only informational: the app decides what to do). */
  blocked: boolean;
}

/** Existing asks that mean "already handled": the same show date is not offered again. */
const HANDLED: AskStatus[] = ["planned", "sent", "got_it", "declined", "no_reply"];

/**
 * The morning list: asks to send now, for show dates in [range.from, range.to]. Skips shows that are full, paused, have no ping
 * rule, or were already asked for that date.
 */
export function asksOpen(
  rooms: Room[],
  range: { from: string; to: string },
  now: Date,
  tz: string,
  ctx: { asks?: Pick<Ask, "roomId" | "showId" | "showDate" | "status">[]; mySpots?: MySpot[] } = {},
): OpenAsk[] {
  const out: OpenAsk[] = [];
  const today = localDate(now, tz);
  for (const room of rooms) {
    for (const show of room.shows) {
      for (const showDate of showDates(show, range.from, range.to)) {
        if (showDate < today || isFull(show, showDate) || isPaused(room, show, showDate)) continue;
        const weekday = weekdayOf(showDate);
        const plan = show.days.find((d) => d.weekday === weekday);
        const window = nextAskWindow(askRuleFor(show, weekday), showDate, now, tz);
        if (window.kind !== "ask" || window.state !== "open") continue;
        if (ctx.asks?.some((a) => a.roomId === room.id && a.showId === show.id && a.showDate === showDate && HANDLED.includes(a.status))) continue;
        out.push({
          roomId: room.id,
          showId: show.id,
          showDate,
          weekday,
          window,
          due: window.date === today ? "today" : "overdue",
          curatorIds: plan?.curatorIds ?? [],
          blocked: limitsBlock(room, ctx.mySpots ?? [], { date: showDate, showId: show.id, source: "ask" }).blocked,
        });
      }
    }
  }
  return out.sort((a, b) => a.showDate.localeCompare(b.showDate) || a.roomId.localeCompare(b.roomId) || a.showId.localeCompare(b.showId));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------------------------------------

export interface LimitHit {
  limit: Limit;
  per: "day" | "week" | "month";
  max: number;
  /** Spots already counted in that period (this one would be count + 1). */
  count: number;
}
export interface LimitResult {
  blocked: boolean;
  hits: LimitHit[];
}

/** Spots that came from an ask or a regular slot count against a room's limits; ad hoc and group-offer spots do not. */
const countsForLimits = (s: MySpot) => (s.source === "ask" || s.source === "regular") && s.status !== "cancelled" && s.happened !== false;

/**
 * Would one more spot on `candidate.date` break the room's (or show's) limits? Only limits that are set are enforced. A group
 * offer or ad hoc spot is never blocked: the comic decides.
 */
export function limitsBlock(
  room: Pick<Room, "id" | "limits">,
  mySpots: MySpot[],
  candidate: { date: string; showId?: string; source?: SpotSource },
): LimitResult {
  if (candidate.source === "adhoc" || candidate.source === "group_offer") return { blocked: false, hits: [] };
  const applicable = room.limits.filter((l) => l.scope === "room" || (l.showId !== undefined && l.showId === candidate.showId));
  if (!applicable.length || applicable.some((l) => l.unlimited)) return { blocked: false, hits: [] };
  const spots = mySpots.filter((s) => s.roomId === room.id && countsForLimits(s));
  const week = mondayOf(candidate.date);
  const month = candidate.date.slice(0, 7);
  const hits: LimitHit[] = [];
  for (const limit of applicable) {
    const mine = limit.scope === "show" ? spots.filter((s) => s.showId === limit.showId) : spots;
    const check = (per: LimitHit["per"], max: number | undefined, inPeriod: (s: MySpot) => boolean) => {
      if (max === undefined) return;
      const count = mine.filter(inPeriod).length;
      if (count >= max) hits.push({ limit, per, max, count });
    };
    check("day", limit.perDay, (s) => s.date === candidate.date);
    check("week", limit.perWeek, (s) => mondayOf(s.date) === week);
    check("month", limit.perMonth, (s) => s.date.slice(0, 7) === month);
  }
  return { blocked: hits.length > 0, hits };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Clashes
// ---------------------------------------------------------------------------------------------------------------------------

/** Minutes between the start of two spots that count as a clash (travel, the set itself). */
export const DEFAULT_CLASH_BUFFER_MIN = 90;

const absMinutes = (date: string, time: string) => (toMs(date) / 60_000) + minutes(time);

/**
 * My booked spots that clash in time with a candidate: closer than `bufferMin` minutes apart. The only filter for spot alerts.
 * A spot or candidate with no time can't be placed, so it never clashes. Cancelled spots and ones that didn't happen are ignored.
 */
export function clashes(mySpots: MySpot[], candidate: { date: string; time?: string }, bufferMin = DEFAULT_CLASH_BUFFER_MIN): MySpot[] {
  if (!candidate.time) return [];
  const at = absMinutes(candidate.date, candidate.time);
  return mySpots.filter((s) => s.time && s.status !== "cancelled" && s.happened !== false && Math.abs(absMinutes(s.date, s.time) - at) < bufferMin);
}

/** An alert with several times: it clashes only if every time does. */
export function alertClash(alert: Pick<SpotAlert, "date" | "times">, mySpots: MySpot[], bufferMin = DEFAULT_CLASH_BUFFER_MIN) {
  const clashing = alert.times.filter((time) => clashes(mySpots, { date: alert.date, time }, bufferMin).length > 0);
  const free = alert.times.filter((t) => !clashing.includes(t));
  return { clash: alert.times.length > 0 && free.length === 0, clashing, free };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Curators, closures, pauses
// ---------------------------------------------------------------------------------------------------------------------------

export interface CuratorForResult {
  /** Who to ask first (the stand-in while one is on). */
  primary: Curator | null;
  /** Co-curators, then (when a stand-in is on) the usual curator. */
  others: Curator[];
  theyReachOut: boolean;
  standInActive: boolean;
}

/** Who curates this show on `weekday`. `onDate` (default: no stand-in) decides whether a stand-in is still on. */
export function curatorFor(show: Pick<ShowShared, "days">, weekday: Weekday, curators: Curator[], onDate?: string): CuratorForResult {
  const plan = show.days.find((d) => d.weekday === weekday);
  const byId = (id: string) => curators.find((c) => c.id === id) ?? null;
  const usual = (plan?.curatorIds ?? []).map(byId).filter((c): c is Curator => c !== null);
  const standIn = plan?.standIn && onDate && onDate <= plan.standIn.until ? byId(plan.standIn.curatorId) : null;
  if (standIn) return { primary: standIn, others: usual, theyReachOut: Boolean(plan?.theyReachOut), standInActive: true };
  return { primary: usual[0] ?? null, others: usual.slice(1), theyReachOut: Boolean(plan?.theyReachOut), standInActive: false };
}

/** The closure that makes this show full on `date`, if any. */
export const fullClosure = (show: Pick<RoomShow, "closures">, date: string): Closure | null =>
  (show.closures ?? []).find((c) => (c.from ?? "0000-00-00") <= date && date <= c.until) ?? null;
export const isFull = (show: Pick<RoomShow, "closures">, date: string) => fullClosure(show, date) !== null;

/** A seasonal break on the room or the show. */
export const isPaused = (room: Pick<Room, "pausedUntil">, show: Pick<RoomShow, "pausedUntil">, date: string) =>
  Boolean((room.pausedUntil && date <= room.pausedUntil) || (show.pausedUntil && date <= show.pausedUntil));

/** Drop closures that are over. */
export const pruneClosures = (show: RoomShow, today: string): RoomShow => {
  const closures = (show.closures ?? []).filter((c) => c.until >= today);
  const { closures: _old, ...rest } = show;
  return closures.length ? { ...rest, closures } : rest;
};

// ---------------------------------------------------------------------------------------------------------------------------
// Shareable (what publishing and exporting keep)
// ---------------------------------------------------------------------------------------------------------------------------

const clean = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) {
    const v = o[k] as unknown;
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0 && k !== "curatorIds")) delete o[k];
  }
  return o;
};

const cloneRule = (r: AskRule): AskRule => ({ ...r });

export function shareableDay(d: DayPlan): DayPlan {
  return clean({
    weekday: d.weekday,
    times: d.times ? [...d.times] : undefined,
    curatorIds: [...d.curatorIds],
    theyReachOut: d.theyReachOut || undefined,
    askRule: d.askRule ? cloneRule(d.askRule) : undefined,
    note: d.note,
  });
}

/** Whitelist, so a private field added later never leaks: no role, closures, pause, notes, stand-ins. */
export function shareableShow(s: RoomShow | ShowShared): ShowShared {
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    cadence: s.cadence,
    times: [...s.times],
    days: s.days.map(shareableDay),
    ...clean({
      monthlyWeeks: s.monthlyWeeks ? [...s.monthlyWeeks] : undefined,
      askRule: s.askRule ? cloneRule(s.askRule) : undefined,
      tags: s.tags ? [...s.tags] : undefined,
      note: s.note,
    }),
  };
}

/** What a room shares: where, when, who to ask and how, the limits as rules. Not my notes, role, closures, pauses, asks or spots, nor limit usage. */
export function shareable(room: Room | RoomShared): RoomShared {
  return {
    id: room.id,
    name: room.name,
    ...clean({
      brand: room.brand,
      area: room.area,
      city: room.city,
      pin: room.pin ? clean({ ...room.pin }) : undefined,
    }),
    aliases: [...room.aliases],
    tags: [...room.tags],
    notes: room.notes.map((n) => clean({ ...n })),
    limits: room.limits.map((l) => clean({ ...l })),
    shows: room.shows.map(shareableShow),
  } as RoomShared;
}

export const shareableCurator = (c: Curator | CuratorShared): CuratorShared => clean({ id: c.id, name: c.name, phone: c.phone, instagram: c.instagram });

/** The shareable part of a roster; only the curators the rooms refer to. */
export function shareableRoster(roster: Roster | SharedRoster): SharedRoster {
  const rooms = roster.rooms.map(shareable);
  const used = new Set(rooms.flatMap((r) => r.shows.flatMap((s) => s.days.flatMap((d) => d.curatorIds))));
  return { rooms, curators: roster.curators.filter((c) => used.has(c.id)).map(shareableCurator) };
}
