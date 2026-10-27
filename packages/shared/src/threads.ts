// Messages page: pure rules for turning WhatsApp chats and messages into what the app shows. No I/O, so the worker
// (which reads WhatsApp live) and the demo (which fakes it from demo data) share them, and they are tested without WhatsApp.
// Nothing here is ever stored: a chat list or a thread only exists in a short-lived command result.
import { comicIdForPhone } from "./people.ts";
import type { Comic } from "./types.ts";
import { toPlain } from "./waFormat.ts";

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
  /** Groups: who wrote it (their id) and the name they go by on WhatsApp. */
  author?: string;
  authorName?: string;
  /** Everyone tagged in the text (their ids: @c.us or @lid). The text holds "@<digits of the id>" for each. */
  mentionedIds?: string[];
  hasReaction?: boolean;
  /** Reactions on this message, one entry per emoji. Only filled in where the worker asked WhatsApp for them. */
  reactions?: WaReactionLike[];
}

export interface WaReactionLike {
  emoji: string;
  /** You reacted with this emoji. */
  byMe: boolean;
  count?: number;
}

/** The fields of a whatsapp-web.js Chat we use. */
export interface WaChatLike {
  id: string;
  isGroup: boolean;
  /** Groups: the group's name. */
  name?: string;
  /** Seconds. */
  timestamp: number;
  unreadCount: number;
  lastMessage?: WaMessageLike | null;
  /**
   * A comic's chat whose newest message is theirs: its last few messages (any order), with reactions filled in on theirs.
   * Lets "needs reply" know you answered by reacting. Missing means only `lastMessage` is known.
   */
  recent?: WaMessageLike[];
}

/** What a media message carries, so the page can show a photo and label the rest ("Open on your phone"). */
export type ThreadMediaKind = "image" | "video" | "audio" | "document" | "other";

export type ThreadMessageKind = "text" | "poll" | "location" | "media" | "sticker" | "deleted" | "other";

/** An emoji under a bubble: how many people used it, and whether one of them is you. */
export interface ReactionChip {
  emoji: string;
  count: number;
  byMe: boolean;
}

/** A tag in a message's text: `token` is what the text holds ("@98870264598667"), `name` what to show instead. */
export interface ThreadMention {
  /** The raw WhatsApp id, kept so the tag can be sent again. */
  id: string;
  token: string;
  name: string;
}

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
  /** Groups: who wrote it, as you'd recognise them (your Comics name first). Missing for your own messages. */
  author?: string;
  reactions?: ReactionChip[];
  mentions?: ThreadMention[];
  /** kind "media": what it is. */
  media?: ThreadMediaKind;
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

const MEDIA_KIND: Record<string, ThreadMediaKind> = { image: "image", video: "video", audio: "audio", ptt: "audio", document: "document" };

/** A show's WhatsApp group in the chat list. Only groups linked to one of your shows are ever listed or opened. */
export interface GroupThreadItem {
  groupId: string;
  name: string;
  /** The shows that use this group. */
  showIds: string[];
  at: number;
  snippet: string;
  fromMe: boolean;
  /** Who wrote the newest message, when it wasn't you. */
  author?: string;
  unread: number;
}

/** System rows WhatsApp stores in a chat that are not messages anyone wrote. */
const NOT_A_MESSAGE = new Set(["e2e_notification", "notification", "notification_template", "gp2", "group_notification", "protocol", "reaction", "call_log", "ciphertext", "debug", "broadcast_notification"]);

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

/** Everyone tagged in a message, named from `names` (roster, group members, WhatsApp). Tags that aren't in the text are ignored. */
export function mentionsOf(m: Pick<WaMessageLike, "body" | "mentionedIds">, names: Map<string, string> = new Map()): ThreadMention[] {
  const out = new Map<string, ThreadMention>();
  for (const id of m.mentionedIds ?? []) {
    const user = id.split("@")[0];
    const token = `@${user}`;
    if (!user || out.has(token) || !(m.body ?? "").includes(token)) continue;
    out.set(token, { id, token, name: names.get(id) || (id.endsWith("@c.us") ? `+${user}` : "Someone") });
  }
  return [...out.values()];
}

/** The text with each tag written as "@Name", for places that show plain text (the chat list, the AI prompt). */
export function withMentionNames(text: string, mentions: ThreadMention[] | undefined): string {
  return (mentions ?? []).reduce((t, x) => t.split(x.token).join(`@${x.name}`), text);
}

const reactionChips = (m: WaMessageLike): ReactionChip[] | undefined => {
  const chips = (m.reactions ?? []).filter((r) => r.emoji).map((r) => ({ emoji: r.emoji, count: Math.max(1, r.count ?? 1), byMe: r.byMe }));
  return chips.length ? chips : undefined;
};

/** One message as the thread shows it, or null for rows that aren't messages. `names` resolves group writers and tags. */
export function toThreadMessage(m: WaMessageLike, names?: Map<string, string>): ThreadMessage | null {
  if (NOT_A_MESSAGE.has(m.type)) return null;
  const reactions = reactionChips(m);
  const mentions = m.mentionedIds?.length ? mentionsOf(m, names) : [];
  const base = {
    id: m.id,
    at: m.timestamp * 1000,
    fromMe: m.fromMe,
    ...(names && !m.fromMe && m.author && { author: authorOf(m, names) }),
    ...(reactions && { reactions }),
    ...(mentions.length && { mentions }),
  };
  if (m.type === "chat") return m.body?.trim() ? { ...base, kind: "text", text: m.body } : null;
  if (m.type === "revoked") return { ...base, kind: "deleted", text: "[deleted message]" };
  if (m.type === "sticker") return { ...base, kind: "sticker", text: "[sticker]" };
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
  const isMedia = Boolean(MEDIA_LABEL[m.type] || m.hasMedia);
  return { ...base, kind: isMedia ? "media" : "other", ...(isMedia && { media: MEDIA_KIND[m.type] ?? "other" }), text: caption ? `${label} ${caption}` : label };
}

/**
 * Is their newest message still waiting on you? No once you sent anything after it, or reacted to it (or to any of their
 * messages after your last one). `recent` is the chat's last few messages; without it only the newest is known.
 */
export function isAwaitingYou(last: WaMessageLike | null | undefined, recent?: WaMessageLike[]): boolean {
  if (!last || !toThreadMessage(last)) return false;
  const byId = new Map<string, WaMessageLike>();
  for (const m of [...(recent ?? []), last]) if (toThreadMessage(m)) byId.set(m.id, byId.get(m.id)?.reactions ? byId.get(m.id)! : m);
  const rows = [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
  let mine = -1;
  rows.forEach((m, i) => m.fromMe && (mine = i));
  const theirs = rows.slice(mine + 1);
  if (!theirs.length) return false;
  return !theirs.some((m) => m.reactions?.some((r) => r.byMe));
}

/** The one-line preview in the thread list: 80 characters at most, one line, "[photo]" for media. */
export function snippetOf(m: WaMessageLike | null | undefined, names?: Map<string, string>): string {
  const t = m ? toThreadMessage(m, names) : null;
  if (!t) return "";
  const line = (t.kind === "poll" && t.poll ? `Poll: ${t.poll.question}` : toPlain(t.text, t.mentions)).replace(/\s+/g, " ").trim();
  return clip(line, SNIPPET_MAX);
}

/** Every id WhatsApp might use for this comic. Current WhatsApp mixes phone ids and @lid, so match on all we know. */
export function comicChatKeys(c: Pick<Comic, "id" | "chatId" | "phone"> & { aliases?: string[] }): string[] {
  const phone = (c.phone ?? "").replace(/\D/g, "");
  return [...new Set([c.id, c.chatId, ...(c.aliases ?? []), phone ? comicIdForPhone(phone) : undefined].filter((x): x is string => Boolean(x)))];
}

/**
 * The thread list: only chats that belong to someone in the roster (no groups, no personal chats), newest first.
 * A comic who has two chats (phone id and @lid) is listed once, with the newer one.
 */
export function matchThreads(chats: WaChatLike[], comics: Pick<Comic, "id" | "chatId" | "phone" | "name">[], resolved?: Map<string, string>): ThreadItem[] {
  const names = new Map([...authorNames(comics), ...(resolved ?? [])]);
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
      snippet: snippetOf(last, names),
      fromMe,
      unread: Math.max(0, chat.unreadCount || 0),
      awaitingYou: Boolean(lastRow) && !fromMe && isAwaitingYou(last, chat.recent),
    };
    const prev = best.get(comic.id);
    if (!prev || item.at > prev.at) best.set(comic.id, { ...item, unread: (prev?.unread ?? 0) + item.unread });
    else prev.unread += item.unread;
  }
  return [...best.values()].sort((a, b) => b.at - a.at);
}

/** The show groups as chats: linked groups only, newest first. A group used by two shows is listed once. */
export function matchGroupThreads(chats: WaChatLike[], shows: { id: string; name: string; groupId?: string | null }[], comics: Pick<Comic, "id" | "chatId" | "phone" | "name">[] = [], resolved?: Map<string, string>): GroupThreadItem[] {
  const linked = new Map<string, string[]>();
  for (const s of shows) if (s.groupId) linked.set(s.groupId, [...(linked.get(s.groupId) ?? []), s.id]);
  // Names WhatsApp resolved (an @lid writer, say) win over the roster, which only knows the ids you saved.
  const names = new Map([...authorNames(comics), ...(resolved ?? [])]);
  const out: GroupThreadItem[] = [];
  for (const chat of chats) {
    const showIds = linked.get(chat.id);
    if (!chat.isGroup || !showIds) continue;
    const last = chat.lastMessage ?? null;
    const lastRow = last ? toThreadMessage(last) : null;
    out.push({
      groupId: chat.id,
      name: chat.name || shows.find((s) => s.id === showIds[0])?.name || "Show group",
      showIds,
      at: (lastRow?.at ?? chat.timestamp * 1000) || 0,
      snippet: snippetOf(last, names),
      fromMe: Boolean(last?.fromMe),
      ...(last && !last.fromMe && { author: authorOf(last, names) }),
      unread: Math.max(0, chat.unreadCount || 0),
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Roster names by every id WhatsApp might use for a person. */
export function authorNames(comics: Pick<Comic, "id" | "chatId" | "phone" | "name">[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of comics) for (const k of comicChatKeys(c)) m.set(k, c.name);
  return m;
}

/**
 * A group message's writer: your Comics name, else what the worker resolved for their id (an @lid is mapped to a phone, then
 * a saved or profile name), else the name on the message, else their number. `names` can hold both the @lid and the phone id.
 */
export function authorOf(m: Pick<WaMessageLike, "author" | "authorName">, names: Map<string, string>): string {
  const id = m.author ?? "";
  return names.get(id) || m.authorName?.trim() || (id.endsWith("@c.us") ? `+${id.split("@")[0]}` : "Someone");
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
export function pageMessages(all: WaMessageLike[], before: number | null | undefined, size = THREAD_PAGE, fetchedLimit = THREAD_FETCH_MAX, names?: Map<string, string>): { messages: ThreadMessage[]; hasMore: boolean } {
  const rows = all
    .map((m) => toThreadMessage(m, names))
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
  /** Your show groups. Missing from older servers. */
  groups?: GroupThreadItem[];
  /** Chats on your Never read list that were left out: names only, no previews. Missing from older servers. */
  neverRead?: { id: string; name: string; isGroup: boolean }[];
  at: number;
}

export interface GetThreadResult {
  /** A comic's chat: their id. A group: the group id. */
  comicId: string;
  groupId?: string;
  chatId: string;
  messages: ThreadMessage[];
  hasMore: boolean;
  /** A group: who is in it (you excluded), for the @ picker. `id` is what a tag is sent to. */
  members?: ThreadMember[];
  at: number;
}

export interface ThreadMember {
  id: string;
  name: string;
}

/** The biggest sticker the app fetches (bytes of the file). Anything larger shows as a label instead. */
export const STICKER_MAX_BYTES = 150_000;
/** The biggest photo the app fetches to show in a chat. It travels as a short-lived command result (Firestore documents hold 1 MB), so bigger ones show a label. */
export const PHOTO_MAX_BYTES = 600_000;

/** get_media: one sticker or photo as a data URL, read from WhatsApp for this one request and returned, never stored. */
export interface ThreadMediaResult {
  dataUrl: string | null;
  reason?: "too_big" | "unavailable";
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
