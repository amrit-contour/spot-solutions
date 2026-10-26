// The Messages page, server side. Chats are read live from the curator's own WhatsApp when asked and returned as a command
// result; nothing is kept. Only comics in the roster and groups linked to a show are ever listed or opened (no personal chats or other groups),
// and nothing here sends.
import type WAWebJS from "whatsapp-web.js";
import {
  THREAD_FETCH_MAX,
  THREAD_PAGE,
  authorNames,
  comicChatKeys,
  matchGroupThreads,
  matchThreads,
  pageMessages,
  toThreadMessage,
  type Comic,
  type GetThreadResult,
  type ListThreadsResult,
  type Show,
  type SpotRequest,
  type SummarizeThreadResult,
  type WaChatLike,
  type WaMessageLike,
} from "@spot/shared";
import { col } from "./firebase.ts";
import { generateJson } from "./llm.ts";
import { sessions } from "./sessions.ts";
import { watchUser } from "./userData.ts";
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
  pollName: (m as { pollName?: string }).pollName,
  pollOptions: (m as { pollOptions?: unknown[] }).pollOptions?.map((o) => (typeof o === "string" ? o : String((o as { name?: string }).name ?? ""))),
  allowMultipleAnswers: (m as { allowMultipleAnswers?: boolean }).allowMultipleAnswers,
  location: m.location ?? null,
  author: m.author,
  authorName: (m as { _data?: { notifyName?: string } })._data?.notifyName,
});

async function rosterComics(uid: string) {
  return (await col(uid, "comics").get()).docs.map((d) => ({ ...(d.data() as Comic), id: d.id }));
}

/** list_threads: the roster's chats and your show groups, newest first. Read from WhatsApp now, returned, not stored. */
export async function listThreads(uid: string): Promise<ListThreadsResult> {
  const client = sessions.require(uid);
  const [comics, chats] = await Promise.all([rosterComics(uid), client.getChats()]);
  const like: WaChatLike[] = chats.map((c) => ({
    id: c.id._serialized,
    isGroup: c.isGroup,
    name: c.name,
    timestamp: c.timestamp,
    unreadCount: c.unreadCount,
    lastMessage: c.lastMessage ? asMessageLike(c.lastMessage) : null,
  }));
  return { threads: matchThreads(like, comics), groups: matchGroupThreads(like, watchUser(uid).shows, comics), at: Date.now() };
}

/** The WhatsApp chat of someone in the roster. Throws for anyone else, so this can never open a personal chat. */
async function chatOf(uid: string, comicId: unknown) {
  const client = sessions.require(uid);
  const snap = await col(uid, "comics").doc(String(comicId ?? "")).get();
  if (!snap.exists) throw new Error("That person isn't in your Comics list, so their chat can't be opened here.");
  const comic = { ...(snap.data() as Comic), id: snap.id };
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
  return sessions.require(uid).getChatById(id);
}

/** get_thread: the newest ~50 messages, or the 50 before `before` (epoch ms). A comic's chat, or (groupId) a show's group. */
export async function getThread(uid: string, payload: Record<string, unknown>): Promise<GetThreadResult> {
  const before = typeof payload.before === "number" && Number.isFinite(payload.before) ? payload.before : null;
  // WhatsApp can't fetch "before a time", so older pages re-read more of the chat and keep the right slice.
  const limit = before ? THREAD_FETCH_MAX : THREAD_PAGE * 2;
  if (payload.groupId) {
    const [chat, comics] = await Promise.all([groupOf(uid, payload.groupId), rosterComics(uid)]);
    const raw = await chat.fetchMessages({ limit });
    const { messages, hasMore } = pageMessages(raw.map(asMessageLike), before, THREAD_PAGE, limit, authorNames(comics));
    return { comicId: chat.id._serialized, groupId: chat.id._serialized, chatId: chat.id._serialized, messages, hasMore, at: Date.now() };
  }
  const { comic, chat } = await chatOf(uid, payload.comicId);
  const raw = await chat.fetchMessages({ limit });
  const { messages, hasMore } = pageMessages(raw.map(asMessageLike), before, THREAD_PAGE, limit);
  return { comicId: comic.id, chatId: chat.id._serialized, messages, hasMore, at: Date.now() };
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
