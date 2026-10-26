// Scheduled posts in a show's WhatsApp group: the lineup, the venue pin, a reminder, or anything the curator writes, sent
// at a set time on the show day or a few days before. Pure rules (no I/O), shared by the worker that sends them and the app
// that previews them.
import { DAY_NAMES, formatDate, formatTime } from "./week.ts";
import { messageRich, normalizeMessage, renderRich, type MessageKey, type MessageOverride, type RichMessage } from "./messages.ts";
import type { Settings, Show, Venue } from "./types.ts";

/** The message types written for a show's group. */
export const GROUP_POST_KEYS = ["groupLineup", "groupVenue", "groupReminder"] as const satisfies readonly MessageKey[];
export type GroupPostKey = (typeof GROUP_POST_KEYS)[number];

export interface GroupPost {
  id: string;
  /** Which group message it sends, or "custom" for one written just for this post (in `message`). */
  template: GroupPostKey | "custom";
  /** 0 = the show day, 1 = the day before, up to 6. */
  daysBefore: number;
  /** Local time, "HH:MM". */
  time: string;
  enabled: boolean;
  /** This post's own wording. Missing: the template as set in Settings → Messages. */
  message?: MessageOverride | null;
  /** Reword the text in the curator's voice when it goes out (facts are checked; the written text goes if one changes). */
  voice?: boolean;
}

export const GROUP_POST_MAX_DAYS = 6;

/** What a new post looks like for each template: a sensible time for it. */
export function newGroupPost(template: GroupPost["template"], show: Pick<Show, "startTime">): GroupPost {
  const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const twoHoursBefore = shiftTime(show.startTime, -120);
  if (template === "groupLineup") return { id, template, daysBefore: 0, time: shiftTime(show.startTime, -180), enabled: true };
  if (template === "groupVenue") return { id, template, daysBefore: 0, time: twoHoursBefore, enabled: true };
  if (template === "groupReminder") return { id, template, daysBefore: 1, time: "18:00", enabled: true };
  return { id, template, daysBefore: 0, time: twoHoursBefore, enabled: true, message: "" };
}

/** "20:00" moved by `minutes`, kept inside the same day. */
export function shiftTime(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const t = Math.min(23 * 60 + 59, Math.max(0, (h || 0) * 60 + (m || 0) + minutes));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

export const addDays = (isoDate: string, days: number) => {
  const dt = new Date(`${isoDate}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
};

const weekdayOf = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`).getUTCDay();

/** The next date (today included) this show runs on. */
export function nextShowDate(show: Pick<Show, "weekday">, today: string): string {
  return addDays(today, (show.weekday - weekdayOf(today) + 7) % 7);
}

/** "Show day", "Day before", "3 days before". */
export const whenLabel = (daysBefore: number) => (daysBefore === 0 ? "Show day" : daysBefore === 1 ? "Day before" : `${daysBefore} days before`);

/** The message a post sends, before variables are filled in. */
export function groupPostMessage(settings: Pick<Settings, "messages">, post: GroupPost): RichMessage {
  const base = post.template === "custom" ? { kind: "text" as const, body: "" } : messageRich(settings, post.template);
  return post.message == null || post.message === "" ? base : normalizeMessage(post.message, base);
}

/** Does this message need the running order? Then it waits for a confirmed lineup. */
export const needsLineup = (m: RichMessage) => /\{\{\s*[#^]?\s*(lineup|count)\s*\}\}/.test([m.body, m.poll?.question, ...(m.poll?.options ?? [])].join(" "));

/** Variables a group message can use. `names` is the running order; missing means the lineup isn't out yet. */
export function groupPostVars(show: Pick<Show, "name" | "startTime">, venue: Pick<Venue, "name" | "mapsLink"> | undefined, showDate: string, names?: string[] | null) {
  return {
    show: show.name,
    venue: venue?.name,
    mapsLink: venue?.mapsLink,
    day: DAY_NAMES[weekdayOf(showDate)],
    date: formatDate(showDate),
    time: formatTime(show.startTime),
    lineup: names?.length ? names.map((n, i) => `${i + 1}. ${n}`).join("\n") : null,
    count: names?.length ? names.length : null,
  };
}

/** Render a post for one show date. */
export const renderGroupPost = (settings: Pick<Settings, "messages">, post: GroupPost, vars: ReturnType<typeof groupPostVars>) => renderRich(groupPostMessage(settings, post), vars);

export interface DuePost {
  post: GroupPost;
  /** The show this post is for (YYYY-MM-DD). */
  showDate: string;
}

/**
 * Posts that should go out now: their day is today, their time has come, and they haven't gone out for that show date.
 * A post missed while the server was off still goes out later the same day, never on a later day.
 */
export function duePosts(show: Pick<Show, "weekday" | "groupPosts" | "groupPostsSent">, now: { date: string; time: string }): DuePost[] {
  const out: DuePost[] = [];
  for (const post of show.groupPosts ?? []) {
    if (!post.enabled) continue;
    const days = Math.max(0, Math.min(GROUP_POST_MAX_DAYS, Math.round(post.daysBefore) || 0));
    const showDate = addDays(now.date, days);
    if (weekdayOf(showDate) !== show.weekday) continue;
    if (now.time < post.time) continue;
    if (show.groupPostsSent?.[post.id] === showDate) continue;
    out.push({ post, showDate });
  }
  return out;
}

/** When a post next goes out, for the schedule list. */
export function nextRun(show: Pick<Show, "weekday" | "groupPostsSent">, post: GroupPost, today: string): { date: string; time: string } {
  let showDate = nextShowDate(show, today);
  for (let i = 0; i < 3; i++) {
    const sendOn = addDays(showDate, -post.daysBefore);
    if (sendOn > today || (sendOn === today && show.groupPostsSent?.[post.id] !== showDate)) return { date: sendOn, time: post.time };
    showDate = addDays(showDate, 7);
  }
  return { date: addDays(showDate, -post.daysBefore), time: post.time };
}
