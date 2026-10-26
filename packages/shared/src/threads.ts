// Messages page: pure rules for turning WhatsApp chats and messages into what the app shows. No I/O, so the worker
// (which reads WhatsApp live) and the demo (which fakes it from demo data) share them, and they are tested without WhatsApp.
// Nothing here is ever stored: a chat list or a thread only exists in a short-lived command result.
import { comicIdForPhone } from "./people.ts";
import type { Comic } from "./types.ts";

export const SNIPPET_MAX = 80;
export const THREAD_PAGE = 50;
export const THREAD_FETCH_MAX = 500;

/** The fields of a whatsapp-web.js Message we use. `timestamp` is in seconds, like WhatsApp's. */
export interface WaMessageLike {
  id: string;
  type: string;
  body?: string;
  fromMe: boolean;
  timestamp: number;
  hasMedia?: boolean;
  pollName?: string;
  pollOptions?: string[];
  allowMultipleAnswers?: boolean;
  location?: { latitude?: number | string; longitude?: number | string; name?: string; address?: string; description?: string } | null;
}

/** The fields of a whatsapp-web.js Chat we use. */
export interface WaChatLike {
  id: string;
  isGroup: boolean;
  /** Seconds. */
  timestamp: number;
  unreadCount: number;
  lastMessage?: WaMessageLike | null;
}

export type ThreadMessageKind = "text" | "poll" | "location" | "media" | "deleted" | "other";

export interface ThreadMessage {
  id: string;
  /** Epoch ms. */
  at: number;
  fromMe: boolean;
  kind: ThreadMessageKind;
  /** Text as typed (with WhatsApp formatting), or a short label like "[photo]" for anything else. */
  text: string;
  poll?: { question: string; options: string[]; multi: boolean };
  pin?: { name: string; detail?: string };
}

export interface ThreadItem {
  comicId: string;
  chatId: string;
  name: string;
  /** Epoch ms of the newest message. */
  at: number;
  snippet: string;
  fromMe: boolean;
  unread: number;
  /** Their message is the newest and you haven't answered it. */
  awaitingYou: boolean;
}

const MEDIA_LABEL: Record<string, string> = {
  image: "[photo]",
  video: "[video]",
  audio: "[audio]",
  ptt: "[voice note]",
  document: "[document]",
  sticker: "[sticker]",
  vcard: "[contact]",
  multi_vcard: "[contacts]",
  album: "[photos]",
  groups_v4_invite: "[group invite]",
};

/** System rows WhatsApp stores in a chat that are not messages anyone wrote. */
const NOT_A_MESSAGE = new Set(["e2e_notification", "notification", "notification_template", "gp2", "group_notification", "protocol", "reaction", "call_log", "ciphertext", "debug", "broadcast_notification"]);

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

/** One message as the thread shows it, or null for rows that aren't messages. */
export function toThreadMessage(m: WaMessageLike): ThreadMessage | null {
  if (NOT_A_MESSAGE.has(m.type)) return null;
  const base = { id: m.id, at: m.timestamp * 1000, fromMe: m.fromMe };
  if (m.type === "chat") return m.body?.trim() ? { ...base, kind: "text", text: m.body } : null;
  if (m.type === "revoked") return { ...base, kind: "deleted", text: "[deleted message]" };
  if (m.type === "poll_creation") {
    const options = (m.pollOptions ?? []).map(String);
    return { ...base, kind: "poll", text: `Poll: ${m.pollName ?? ""}`.trim(), poll: { question: m.pollName ?? "", options, multi: Boolean(m.allowMultipleAnswers) } };
  }
  if (m.type === "location") {
    const name = m.location?.name || m.location?.description || "Location pin";
    return { ...base, kind: "location", text: `Location: ${name}`, pin: { name, ...(m.location?.address ? { detail: m.location.address } : {}) } };
  }
  const label = MEDIA_LABEL[m.type] ?? (m.hasMedia ? "[attachment]" : "[message]");
  // A caption on a photo or document is the text worth showing.
  const caption = m.body?.trim();
  return { ...base, kind: MEDIA_LABEL[m.type] || m.hasMedia ? "media" : "other", text: caption ? `${label} ${caption}` : label };
}

/** The one-line preview in the thread list: 80 characters at most, one line, "[photo]" for media. */
export function snippetOf(m: WaMessageLike | null | undefined): string {
  const t = m ? toThreadMessage(m) : null;
  if (!t) return "";
  const line = (t.kind === "poll" && t.poll ? `Poll: ${t.poll.question}` : t.text).replace(/\s+/g, " ").trim();
  return clip(line, SNIPPET_MAX);
}

/** Every id WhatsApp might use for this comic. Current WhatsApp mixes phone ids and @lid, so match on all we know. */
export function comicChatKeys(c: Pick<Comic, "id" | "chatId" | "phone">): string[] {
  const phone = (c.phone ?? "").replace(/\D/g, "");
  return [...new Set([c.id, c.chatId, phone ? comicIdForPhone(phone) : undefined].filter((x): x is string => Boolean(x)))];
}

/**
 * The thread list: only chats that belong to someone in the roster (no groups, no personal chats), newest first.
 * A comic who has two chats (phone id and @lid) is listed once, with the newer one.
 */
export function matchThreads(chats: WaChatLike[], comics: Pick<Comic, "id" | "chatId" | "phone" | "name">[]): ThreadItem[] {
  const byKey = new Map<string, Pick<Comic, "id" | "chatId" | "phone" | "name">>();
  for (const c of comics) for (const k of comicChatKeys(c)) byKey.set(k, c);
  const best = new Map<string, ThreadItem>();
  for (const chat of chats) {
    if (chat.isGroup) continue;
    const comic = byKey.get(chat.id);
    if (!comic) continue;
    const last = chat.lastMessage ?? null;
    const lastRow = last ? toThreadMessage(last) : null;
    const at = (lastRow?.at ?? chat.timestamp * 1000) || 0;
    // A chat with nothing in it yet is not a thread worth listing.
    if (!lastRow && !at) continue;
    const fromMe = Boolean(last?.fromMe);
    const item: ThreadItem = {
      comicId: comic.id,
      chatId: chat.id,
      name: comic.name,
      at,
      snippet: snippetOf(last),
      fromMe,
      unread: Math.max(0, chat.unreadCount || 0),
      awaitingYou: Boolean(lastRow) && !fromMe,
    };
    const prev = best.get(comic.id);
    if (!prev || item.at > prev.at) best.set(comic.id, { ...item, unread: (prev?.unread ?? 0) + item.unread });
    else prev.unread += item.unread;
  }
  return [...best.values()].sort((a, b) => b.at - a.at);
}

/** Free-text search over the list: name, the number inside the chat id, or the preview. */
export function filterThreads<T extends Pick<ThreadItem, "name" | "chatId" | "comicId" | "snippet">>(items: T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return items;
  const digits = needle.replace(/\D/g, "");
  return items.filter(
    (t) => t.name.toLowerCase().includes(needle) || t.snippet.toLowerCase().includes(needle) || (digits.length >= 3 && (t.comicId.split("@")[0].includes(digits) || t.chatId.split("@")[0].includes(digits))),
  );
}

/**
 * One page of a chat. WhatsApp can't fetch "before X", so the worker fetches the newest `limit` messages and this keeps the
 * `size` just before `before` (epoch ms), oldest first. `hasMore` is true when something older is known to exist.
 */
export function pageMessages(all: WaMessageLike[], before: number | null | undefined, size = THREAD_PAGE, fetchedLimit = THREAD_FETCH_MAX): { messages: ThreadMessage[]; hasMore: boolean } {
  const rows = all
    .map(toThreadMessage)
    .filter((m): m is ThreadMessage => m !== null)
    .filter((m) => before == null || m.at < before)
    .sort((a, b) => a.at - b.at);
  const messages = rows.slice(-size);
  return { messages, hasMore: rows.length > size || (all.length >= fetchedLimit && rows.length >= 1) };
}

/** Day heading for a separator: Today, Yesterday, or "Mon 27 Oct". `now` and `timezone` come from the curator's settings. */
export function dayLabel(at: number, now: number, timezone: string): string {
  const key = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
  const k = key(at);
  if (k === key(now)) return "Today";
  if (k === key(now - 86_400_000)) return "Yesterday";
  const sameYear = k.slice(0, 4) === key(now).slice(0, 4);
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }).format(new Date(at));
}

/** Messages with a separator before the first one of each day. */
export type ThreadRow = { row: "day"; key: string; label: string } | { row: "msg"; m: ThreadMessage };
export function groupByDay(messages: ThreadMessage[], now: number, timezone: string): ThreadRow[] {
  const out: ThreadRow[] = [];
  let last = "";
  for (const m of messages) {
    const label = dayLabel(m.at, now, timezone);
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(m.at));
    if (day !== last) {
      last = day;
      out.push({ row: "day", key: `d${day}`, label });
    }
    out.push({ row: "msg", m });
  }
  return out;
}

// ---- Results of the three commands (short-lived command result documents) ----

export interface ListThreadsResult {
  threads: ThreadItem[];
  at: number;
}

export interface GetThreadResult {
  comicId: string;
  chatId: string;
  messages: ThreadMessage[];
  hasMore: boolean;
  at: number;
}

export type ThreadActionKind = "place" | "close_request" | "none";

export interface ThreadAction {
  kind: ThreadActionKind;
  /** place: one of this week's show ids. */
  showId?: string | null;
  /** An exact quote from the thread that backs the action. Actions without a real quote are dropped. */
  evidence: string;
  /** place: the quote is the curator's own message, so they were already told (place them as told, send nothing). */
  told?: boolean;
}

export interface SummarizeThreadResult {
  summary: string;
  /** Text only. It is a suggestion: it goes nowhere until the curator edits and sends it. */
  suggestedReply: string;
  actions: ThreadAction[];
  model: string;
  at: number;
}
