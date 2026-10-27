// The Messages page, server side. Chats are read live from the curator's own WhatsApp when asked and returned as a command
// result; nothing is kept. Only comics in the roster and groups linked to a show are ever listed or opened (no personal chats or other groups),
// and nothing here sends.
import type WAWebJS from "whatsapp-web.js";
import {
  THREAD_FETCH_MAX,
  THREAD_PAGE,
  STICKER_MAX_BYTES,
  authorNames,
  comicChatKeys,
  matchGroupThreads,
  matchThreads,
  pageMessages,
  toThreadMessage,
  type Comic,
  type GetThreadResult,
  type GroupMember,
  type ListThreadsResult,
  type Show,
  type SpotRequest,
  type SummarizeThreadResult,
  type ThreadMediaResult,
  type ThreadMember,
  type WaChatLike,
  type WaMessageLike,
  type WaReactionLike,
} from "@spot/shared";
import { lidToPhoneIds, resolveNames } from "./chatNames.ts";
import { col } from "./firebase.ts";
import { generateJson } from "./llm.ts";
import { sessions } from "./sessions.ts";
import { watchUser } from "./userData.ts";
import { isNeverRead, neverReadFor } from "./neverRead.ts";
import { THREAD_ASSIST_SCHEMA, buildThreadPrompt, parseThreadAssist, showLines } from "./threadAssist.ts";

/** Messages the model reads. Enough for a back-and-forth about one spot, small enough for a local model. */
const ASSIST_MESSAGES = 30;

export const asMessageLike = (m: WAWebJS.Message): WaMessageLike => ({
  id: m.id._serialized,
  type: m.type,
  body: m.body,
  fromMe: m.fromMe,
  timestamp: m.timestamp,
  hasMedia: m.hasMedia,
  hasReaction: Boolean((m as { hasReaction?: boolean }).hasReaction),
  mentionedIds: ((m as { mentionedIds?: unknown[] }).mentionedIds ?? []).map((x) => (typeof x === "string" ? x : String((x as { _serialized?: string })?._serialized ?? ""))).filter(Boolean),
  pollName: (m as { pollName?: string }).pollName,
  pollOptions: (m as { pollOptions?: unknown[] }).pollOptions?.map((o) => (typeof o === "string" ? o : String((o as { name?: string }).name ?? ""))),
  allowMultipleAnswers: (m as { allowMultipleAnswers?: boolean }).allowMultipleAnswers,
  location: m.location ?? null,
  author: m.author,
  authorName: (m as { _data?: { notifyName?: string } })._data?.notifyName,
});

/** How many chats get a closer look for "needs reply", and how far back in each. Reactions can only be read message by message. */
const AWAITING_CHECK_CHATS = 20;
const AWAITING_CHECK_MESSAGES = 8;
const REACTION_LOOKUPS = 40;
const AT_ONCE = 5;

async function inParallel<T>(items: T[], fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(AT_ONCE, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

/** The emoji on a message, one entry per emoji with how many used it and whether one is you. Nothing for a message without. */
async function reactionsOf(m: WAWebJS.Message): Promise<WaReactionLike[] | undefined> {
  if (!(m as { hasReaction?: boolean }).hasReaction) return undefined;
  try {
    const list = await m.getReactions();
    const out = (list ?? []).filter((r) => r.aggregateEmoji).map((r) => ({ emoji: r.aggregateEmoji, byMe: Boolean(r.hasReactionByMe), count: r.senders?.length || 1 }));
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Messages as the page reads them, with reactions on the newest ones that have any (bounded, so a busy group stays quick). */
async function withReactions(raw: WAWebJS.Message[]): Promise<WaMessageLike[]> {
  const like = raw.map(asMessageLike);
  const want = like.map((m, i) => ({ m, i })).filter(({ m }) => m.hasReaction).sort((a, b) => b.m.timestamp - a.m.timestamp).slice(0, REACTION_LOOKUPS);
  await inParallel(want, async ({ m, i }) => void (m.reactions = await reactionsOf(raw[i])));
  return like;
}

async function rosterComics(uid: string) {
  return (await col(uid, "comics").get()).docs.map((d) => ({ ...(d.data() as Comic), id: d.id }));
}

/** list_threads: the roster's chats and your show groups, newest first. Read from WhatsApp now, returned, not stored. */
export async function listThreads(uid: string): Promise<ListThreadsResult> {
  const client = sessions.require(uid);
  const [comics, allChats] = await Promise.all([rosterComics(uid), client.getChats()]);
  // Never read chats: no preview, no unread count, no message of theirs is looked at. Only their names are handed back.
  const skip = new Set<string>();
  if ((await neverReadFor(uid)).size) for (const c of allChats) if (await isNeverRead(uid, client, c.id._serialized)) skip.add(c.id._serialized);
  const chats = allChats.filter((c) => !skip.has(c.id._serialized));
  const hiddenNames = allChats.filter((c) => skip.has(c.id._serialized)).map((c) => ({ id: c.id._serialized, name: c.name || `+${c.id.user}`, isGroup: c.isGroup }));
  const like: WaChatLike[] = chats.map((c) => ({
    id: c.id._serialized,
    isGroup: c.isGroup,
    name: c.name,
    timestamp: c.timestamp,
    unreadCount: c.unreadCount,
    lastMessage: c.lastMessage ? asMessageLike(c.lastMessage) : null,
  }));

  // "Needs reply": their newest message is only unanswered if you haven't sent anything since or reacted to it. Reactions aren't
  // in the chat list, so look at the last few messages of the (newest) chats that end with something from them.
  const mine = new Set(comics.flatMap((c) => comicChatKeys(c)));
  const byId = new Map(chats.map((c) => [c.id._serialized, c]));
  const check = like
    .filter((c) => !c.isGroup && mine.has(c.id) && c.lastMessage && !c.lastMessage.fromMe && toThreadMessage(c.lastMessage))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, AWAITING_CHECK_CHATS);
  await inParallel(check, async (c) => {
    try {
      const recent = await byId.get(c.id)!.fetchMessages({ limit: AWAITING_CHECK_MESSAGES });
      const lastMine = recent.reduce((t, m) => (m.fromMe ? Math.max(t, m.timestamp) : t), 0);
      const open = recent.filter((m) => !m.fromMe && m.timestamp >= lastMine);
      const like = recent.map(asMessageLike);
      await Promise.all(open.map(async (m) => void (like[recent.indexOf(m)].reactions = await reactionsOf(m))));
      c.recent = like;
    } catch {
      /* unreadable: it stays "needs reply" like before */
    }
  });

  // Group previews name their writer: resolve the (few) newest writers' @lid ids.
  const linked = new Set(watchUser(uid).shows.map((s) => s.groupId).filter(Boolean));
  const writers = like.filter((c) => c.isGroup && linked.has(c.id) && c.lastMessage && !c.lastMessage.fromMe);
  const ids = writers.flatMap((c) => [c.lastMessage!.author ?? "", ...(c.lastMessage!.mentionedIds ?? [])]);
  const names = ids.some(Boolean) ? await resolveNames(uid, client, ids, comics, groupCache(uid)).catch(() => new Map<string, string>()) : new Map<string, string>();
  return { threads: matchThreads(like, comics), groups: matchGroupThreads(like, watchUser(uid).shows, comics, names), ...(hiddenNames.length && { neverRead: hiddenNames }), at: Date.now() };
}

/** Who the worker last read in the linked groups (names for people who aren't in Comics). */
function groupCache(uid: string): GroupMember[] {
  return watchUser(uid).shows.flatMap((s) => s.groupMembers?.members ?? []);
}

/** The WhatsApp chat of someone in the roster. Throws for anyone else, so this can never open a personal chat. */
async function chatOf(uid: string, comicId: unknown) {
  const client = sessions.require(uid);
  const snap = await col(uid, "comics").doc(String(comicId ?? "")).get();
  if (!snap.exists) throw new Error("That person isn't in your Comics list, so their chat can't be opened here.");
  const comic = { ...(snap.data() as Comic), id: snap.id };
  if (await isNeverRead(uid, client, comic.id, comic.chatId, comic.phone)) throw new Error(`${comic.name} is on your Never read list, so their chat isn't opened.`);
  let last: unknown;
  for (const key of [comic.chatId, ...comicChatKeys(comic)].filter((k): k is string => Boolean(k))) {
    try {
      return { comic, chat: await client.getChatById(key) };
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`Couldn't open the chat with ${comic.name}${last ? ` (${(last as Error).message})` : ""}`);
}

/** A show's group. Throws for any group not linked to one of your shows, so this can never open another group. */
export async function groupOf(uid: string, groupId: unknown) {
  const id = String(groupId ?? "");
  if (!id.endsWith("@g.us") || !watchUser(uid).shows.some((s) => s.groupId === id)) throw new Error("That group isn't linked to any of your shows, so it can't be opened here.");
  if (await isNeverRead(uid, sessions.get(uid), id)) throw new Error("That group is on your Never read list, so it isn't opened.");
  return sessions.require(uid).getChatById(id);
}

/** get_thread: the newest ~50 messages, or the 50 before `before` (epoch ms). A comic's chat, or (groupId) a show's group. */
export async function getThread(uid: string, payload: Record<string, unknown>): Promise<GetThreadResult> {
  const before = typeof payload.before === "number" && Number.isFinite(payload.before) ? payload.before : null;
  // WhatsApp can't fetch "before a time", so older pages re-read more of the chat and keep the right slice.
  const limit = before ? THREAD_FETCH_MAX : THREAD_PAGE * 2;
  if (payload.groupId) {
    const [chat, comics] = await Promise.all([groupOf(uid, payload.groupId), rosterComics(uid)]);
    const client = sessions.require(uid);
    const raw = await chat.fetchMessages({ limit });
    const all = await withReactions(raw);
    const cached = groupCache(uid);
    const names = await resolveNames(uid, client, all.flatMap((m) => [m.author ?? "", ...(m.mentionedIds ?? [])]), comics, cached);
    const { messages, hasMore } = pageMessages(all, before, THREAD_PAGE, limit, names);
    // The @ picker: everyone in the group but you. Names come from Comics, the member cache and writers seen above, not a lookup each.
    const members = before ? undefined : await groupMembersOf(client, chat as WAWebJS.GroupChat, comics, cached, names);
    return { comicId: chat.id._serialized, groupId: chat.id._serialized, chatId: chat.id._serialized, messages, hasMore, ...(members && { members }), at: Date.now() };
  }
  const { comic, chat } = await chatOf(uid, payload.comicId);
  const raw = await chat.fetchMessages({ limit });
  const { messages, hasMore } = pageMessages(await withReactions(raw), before, THREAD_PAGE, limit);
  return { comicId: comic.id, chatId: chat.id._serialized, messages, hasMore, at: Date.now() };
}

/** Everyone in a group except you, as the ids a tag is sent to. */
async function groupMembersOf(client: WAWebJS.Client, group: WAWebJS.GroupChat, comics: Comic[], cached: GroupMember[], seen: Map<string, string>): Promise<ThreadMember[]> {
  const self = client.info.wid.user;
  const people = (group.participants ?? []).map((p) => p.id._serialized);
  const lids = await lidToPhoneIds(client, people);
  const roster = authorNames(comics);
  const known = new Map(cached.map((m) => [m.id, m.name]));
  const out = new Map<string, ThreadMember>();
  for (const raw of people) {
    const phoneId = raw.endsWith("@c.us") ? raw : lids.get(raw);
    const id = phoneId ?? raw;
    if (id.split("@")[0] === self || out.has(id)) continue;
    const name = roster.get(id) ?? roster.get(raw) ?? known.get(id) ?? seen.get(raw) ?? seen.get(id) ?? (phoneId ? `+${phoneId.split("@")[0]}` : "");
    if (name) out.set(id, { id, name });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * get_media: one sticker, fetched from WhatsApp for this request and returned as a data URL (never stored; the result is a
 * short-lived command result like the chat text). Only stickers, only from a chat that can be opened here, and nothing over
 * STICKER_MAX_BYTES.
 */
export async function getMedia(uid: string, payload: Record<string, unknown>): Promise<ThreadMediaResult> {
  const chat = payload.groupId ? await groupOf(uid, payload.groupId) : (await chatOf(uid, payload.comicId)).chat;
  const id = String(payload.messageId ?? "");
  if (!id) throw new Error("Which message?");
  const client = sessions.require(uid);
  let msg: WAWebJS.Message | undefined = await client.getMessageById(id).catch(() => undefined);
  // The message must belong to the chat that was asked for; otherwise look for it in that chat.
  if (!msg || (msg.id.remote !== chat.id._serialized && msg.from !== chat.id._serialized && msg.to !== chat.id._serialized)) {
    msg = (await chat.fetchMessages({ limit: 100 })).find((m) => m.id._serialized === id);
  }
  if (!msg || msg.type !== "sticker") return { dataUrl: null, reason: "unavailable" };
  const media = await msg.downloadMedia().catch(() => undefined);
  if (!media?.data || !media.mimetype.startsWith("image/")) return { dataUrl: null, reason: "unavailable" };
  if ((media.data.length * 3) / 4 > STICKER_MAX_BYTES) return { dataUrl: null, reason: "too_big" };
  return { dataUrl: `data:${media.mimetype};base64,${media.data}` };
}

/** summarize_thread: a sentence, a suggested reply, and actions backed by quotes. Suggests only; sends and changes nothing. */
export async function summarizeThread(uid: string, payload: Record<string, unknown>): Promise<SummarizeThreadResult> {
  const { comic, chat } = await chatOf(uid, payload.comicId);
  const { settings, venues } = watchUser(uid);
  const week = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.weekOf ?? "")) ? String(payload.weekOf) : null;
  const shows = (await col(uid, "shows").get()).docs.map((d) => ({ ...(d.data() as Show), id: d.id })).filter((s) => s.active);
  const req = week ? ((await col(uid, "requests").doc(`${week}_${comic.id}`).get()).data() as SpotRequest | undefined) : undefined;
  const open = req && ["new", "acked"].includes(req.status) ? req : null;

  const { messages } = pageMessages((await chat.fetchMessages({ limit: ASSIST_MESSAGES * 2 })).map(asMessageLike), null, ASSIST_MESSAGES);
  if (!messages.length) throw new Error("There's nothing in this chat to summarise yet.");
  const first = comic.name.split(/\s+/)[0] || comic.name;
  const prompt = buildThreadPrompt({
    name: first,
    messages,
    shows,
    venues,
    request: open ? { status: open.status, preferredDays: open.intent.preferredDays, note: open.intent.note } : null,
  });
  const { text, model } = await generateJson(uid, settings.ai, prompt, THREAD_ASSIST_SCHEMA, { temperature: 0.2 });
  const out = parseThreadAssist(text, messages, shows.map((s) => s.id), showLines(shows, venues).join(" "));
  if (!out.summary) throw new Error("The model didn't give a usable summary. Try again.");
  return { ...out, model, at: Date.now() };
}

export { toThreadMessage };
