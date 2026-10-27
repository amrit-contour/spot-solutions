// Nothing BOT Comedy: asking rooms for spots, on the comic's own server.
//  - send_ask (a command): send one drafted ask from the comic's own WhatsApp, in their voice when asked.
//  - tickAsks (every two minutes, for accounts that have rooms): send the asks of "auto" rooms when the window opens, push a
//    reminder for "review" rooms when it opens and again about 2 h before it closes, read curators' replies to asks already sent,
//    and tidy: a draft whose show has passed expires, a sent ask nobody answered drops to "no reply".
// The app computes the same list with planAsks (packages/shared/src/asks.ts), so what the app shows and what the worker does agree.
import type WAWebJS from "whatsapp-web.js";
import {
  askDue,
  askVars,
  awaitingReply,
  draftExpired,
  isoAddDays,
  localDate,
  missedReply,
  normalizePhone,
  openNow,
  planAsks,
  reminderText,
  renderAsk,
  spotFromAsk,
  type Ask,
  type AskReply,
  type Curator,
  type MySpot,
  type PlannedAsk,
  type Room,
} from "@spot/shared";
import { col, db, userRef } from "./firebase.ts";
import { AiPolicyError } from "./aiRouting.ts";
import { generateJson } from "./llm.ts";
import { notify } from "./notify.ts";
import { sessions } from "./sessions.ts";
import { deliverableId } from "./sendQueue.ts";
import { sendRich } from "./sendRich.ts";
import { inVoice } from "./voice.ts";
import { watchUser } from "./userData.ts";
import { ASK_REPLY_SCHEMA, NOT_TEXT, readAskReply, type ReplyMessage } from "./askReplyPrompt.ts";

const PLAN_DAYS = 7;
const READ_EVERY_MS = 10 * 60_000;
const COMIC_RECHECK_MS = 30 * 60_000;
const SENDING_STALE_MS = 5 * 60_000;
const REPLY_TYPES = new Set(["chat", "ptt", "audio"]);

const withId = <T,>(d: FirebaseFirestore.QueryDocumentSnapshot) => ({ ...(d.data() as T), id: d.id }) as T & { id: string };

/** The comic's data the worker needs, read fresh each round (a few small collections). */
async function loadComic(uid: string) {
  const [rooms, curators, asks, spots, user] = await Promise.all([
    col(uid, "rooms").get(),
    col(uid, "curators").get(),
    col(uid, "asks").where("showDate", ">=", isoAddDays(localDate(new Date(), watchUser(uid).settings.timezone), -30)).get(),
    col(uid, "mySpots").where("date", ">=", isoAddDays(localDate(new Date(), watchUser(uid).settings.timezone), -45)).get(),
    userRef(uid).get(),
  ]);
  return {
    rooms: rooms.docs.map((d) => withId<Room>(d)),
    curators: curators.docs.map((d) => withId<Curator>(d)),
    asks: asks.docs.map((d) => withId<Ask>(d)),
    spots: spots.docs.map((d) => withId<MySpot>(d)),
    template: (user.data()?.comic?.askTemplate as string | undefined) ?? undefined,
  };
}

const firstName = (s?: string) => (s ?? "").trim().split(/\s+/)[0] ?? "";

/** The ask as a draft document, with the message already filled in from the template. */
function draftOf(a: PlannedAsk, template: string | undefined, mode: Ask["mode"], now: number): Ask {
  return {
    id: a.id,
    roomId: a.roomId,
    showId: a.showId,
    showDate: a.showDate,
    ...(a.time ? { time: a.time } : {}),
    ...(a.curatorId ? { curatorId: a.curatorId } : {}),
    askOn: a.askOn,
    status: "planned",
    message: renderAsk(template, { curatorName: a.curatorName, roomName: a.roomName, show: a.label, showDate: a.showDate, time: a.time }),
    createdAt: now,
    roomName: a.roomName,
    showName: a.showName,
    ...(a.curatorName ? { curatorName: a.curatorName } : {}),
    mode,
    voice: true,
    closesAt: a.closesAt,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * send_ask: send the drafted text of users/{uid}/asks/{askId} to its curator from the comic's own WhatsApp (through the usual queue
 * and pacing). With "in my voice" on, the text is rewritten first (checked against the draft: it can only change the wording).
 * Records the message id, the chat and when it went. A second send of the same ask is a no-op.
 */
export async function sendAsk(uid: string, askIdValue: string) {
  const client = sessions.require(uid);
  const ref = col(uid, "asks").doc(askIdValue);
  const claimed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const a = snap.data() as Ask | undefined;
    if (!a) throw new Error("That ask isn't there any more.");
    if (a.status !== "planned") return null;
    if (a.sendingAt && Date.now() - a.sendingAt < SENDING_STALE_MS) return null;
    tx.update(ref, { sendingAt: Date.now() });
    return a;
  });
  if (!claimed) return { already: true };
  const ask = claimed;

  try {
    const curatorSnap = ask.curatorId ? await col(uid, "curators").doc(ask.curatorId).get() : null;
    const curator = curatorSnap?.exists ? (curatorSnap.data() as Curator) : undefined;
    const digits = normalizePhone(curator?.phone ?? "");
    if (!digits) throw new Error(`${curator?.name ?? "The curator"} has no WhatsApp number yet. Add it in Rooms > Curators.`);
    const draft = ask.message?.trim();
    if (!draft) throw new Error("The message is empty.");

    let text = draft;
    if (ask.voice !== false) {
      const v = askVars({ curatorName: curator?.name ?? ask.curatorName, roomName: ask.roomName ?? "", show: ask.roomName ?? "", showDate: ask.showDate, time: ask.time });
      text = await inVoice(uid, "spotAsk", draft, { name: v.curator, show: ask.roomName, day: v.day, date: v.date, ...(ask.time ? { time: v.time } : {}) });
    }
    const to = await deliverableId(client, `${digits}@c.us`);
    const sent = await sendRich(client, to, { kind: "text", body: text }, {}, null, { prerendered: true });
    await ref.update({
      status: "sent",
      sentAt: Date.now(),
      message: text,
      messageId: sent?.id?._serialized ?? null,
      chatId: (sent as { to?: string } | undefined)?.to ?? to,
      sendingAt: null,
      error: null,
    });
    return { sent: true, body: text };
  } catch (e) {
    await ref.update({ sendingAt: null, error: (e as Error).message }).catch(() => undefined);
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------------------------------------------------------

const isComic = new Map<string, boolean>();
const nextComicCheck = new Map<string, number>();
const lastRead = new Map<string, number>();
const running = new Set<string>();

/** Only accounts that keep rooms are worth the reads; re-checked every half hour so a new comic is picked up. */
async function hasRooms(uid: string) {
  if (isComic.get(uid)) return true;
  if (Date.now() < (nextComicCheck.get(uid) ?? 0)) return false;
  nextComicCheck.set(uid, Date.now() + COMIC_RECHECK_MS);
  const yes = !(await col(uid, "rooms").limit(1).get()).empty;
  isComic.set(uid, yes);
  return yes;
}

/** Called from the scheduler for every linked account. Cheap for curators who have no rooms. */
export async function maybeTickAsks(uid: string, client: WAWebJS.Client) {
  if (running.has(uid) || !(await hasRooms(uid))) return;
  running.add(uid);
  try {
    await tickAsks(uid, client);
  } finally {
    running.delete(uid);
  }
}

export async function tickAsks(uid: string, client: WAWebJS.Client) {
  const { settings } = watchUser(uid);
  const tz = settings.timezone;
  const nowDate = new Date();
  const nowMs = nowDate.getTime();
  const today = localDate(nowDate, tz);
  const data = await loadComic(uid);
  const plan = planAsks(data.rooms, data.curators, { from: today, to: isoAddDays(today, PLAN_DAYS) }, nowDate, tz, { asks: data.asks, mySpots: data.spots });

  for (const a of openNow(plan)) {
    const due = askDue(a, nowMs);
    if (!due) continue;
    const ref = col(uid, "asks").doc(a.id);
    try {
      if (due === "send") {
        // create() fails when the comic already has a draft: send that one.
        await ref.create(draftOf(a, data.template, "auto", nowMs)).catch((e: { code?: number }) => {
          if (e.code !== 6) throw e;
        });
        await sendAsk(uid, a.id);
        console.log(`[asks] ${uid} sent ${a.label} ${a.showDate}`);
      } else {
        const kind = due === "remind_open" ? "open" : "closing";
        const stamp = kind === "open" ? { remindedOpenAt: nowMs } : { remindedCloseAt: nowMs };
        if (a.doc) await ref.update(stamp);
        else await ref.create({ ...draftOf(a, data.template, "review", nowMs), ...stamp });
        await notify(uid, kind === "open" ? "ask_open" : "ask_closing", reminderText(a, kind, today, nowMs));
      }
    } catch (e) {
      console.error(`[asks] ${uid} ${a.id} ${due} failed`, e);
      if (due === "send") await notify(uid, "ask_open", `Couldn't send your ask for ${a.label} ${a.showDate}: ${(e as Error).message} Send it from the Asks page.`);
    }
  }

  // Tidy.
  for (const a of data.asks) {
    if (draftExpired(a, today)) await col(uid, "asks").doc(a.id).update({ status: "expired" }).catch(() => undefined);
    else if (missedReply(a, today)) await col(uid, "asks").doc(a.id).update({ status: "no_reply" }).catch(() => undefined);
  }

  if (nowMs - (lastRead.get(uid) ?? 0) >= READ_EVERY_MS) {
    lastRead.set(uid, nowMs);
    await readReplies(uid, client, data, today).catch((e) => {
      if (!(e instanceof AiPolicyError)) console.error(`[asks] ${uid} reading replies failed`, e);
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------------------------------------------------------

/** The curator's messages in this chat since the ask went out, oldest first. Voice notes come through as a placeholder. */
async function curatorMessages(client: WAWebJS.Client, chatId: string, since: number): Promise<ReplyMessage[]> {
  const chat = await client.getChatById(chatId);
  const msgs = await chat.fetchMessages({ limit: 40 });
  return msgs
    .filter((m) => !m.fromMe && REPLY_TYPES.has(m.type) && m.timestamp * 1000 > since)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-10)
    .map((m) => ({ text: m.type === "chat" ? (m.body ?? "").slice(0, 1000) : NOT_TEXT, at: m.timestamp * 1000, id: m.id?._serialized }));
}

export async function readReplies(uid: string, client: WAWebJS.Client, data: { rooms: Room[]; curators: Curator[]; asks: Ask[] }, today: string) {
  const { settings } = watchUser(uid);
  const waiting = data.asks.filter((a) => awaitingReply(a, today) && !a.skipped && a.sentAt);
  for (const ask of waiting) {
    const curator = data.curators.find((c) => c.id === ask.curatorId);
    let chatId = ask.chatId;
    if (!chatId) {
      const digits = normalizePhone(curator?.phone ?? "");
      if (!digits) continue;
      chatId = await deliverableId(client, `${digits}@c.us`);
    }
    let messages: ReplyMessage[];
    try {
      messages = await curatorMessages(client, chatId, ask.sentAt!);
    } catch {
      continue; // chat not loadable right now: next round
    }
    const newest = messages.length ? messages[messages.length - 1]!.at : 0;
    if (!newest || newest <= (ask.readAt ?? 0)) continue;

    const room = data.rooms.find((r) => r.id === ask.roomId);
    const label = ask.roomName ?? room?.name ?? "the room";
    const reply = await readAskReply(
      { curatorName: curator?.name ?? ask.curatorName, roomName: label, show: label, showDate: ask.showDate, time: ask.time, asked: ask.message ?? "" },
      messages,
      async (prompt) => (await generateJson(uid, settings.ai, prompt, ASK_REPLY_SCHEMA)).text,
    );
    if (!reply) continue;
    await applyReply(uid, ask, room, curator, label, reply, newest);
  }
}

async function applyReply(uid: string, ask: Ask, room: Room | undefined, curator: Curator | undefined, label: string, reply: AskReply, readAt: number) {
  const ref = col(uid, "asks").doc(ask.id);
  const who = firstName(curator?.name ?? ask.curatorName) || "The curator";
  const v = askVars({ roomName: label, show: label, showDate: ask.showDate });
  const when = `${v.day} ${v.date}`;
  const evidence = { text: reply.text, at: reply.at, ...(reply.messageId ? { messageId: reply.messageId } : {}) };
  if (reply.decision === "got_it") {
    const spot = spotFromAsk(ask, room, reply.time, Date.now());
    await col(uid, "mySpots").doc(spot.id).set(spot);
    await ref.update({ status: "got_it", evidence, lastReply: reply, readAt });
    await notify(uid, "ask_reply", `${who} said yes: ${label}, ${when}.${reply.unsure ? ` They only replied "${reply.text}", so check it.` : " It's in My spots."}`);
  } else if (reply.decision === "declined") {
    await ref.update({ status: "declined", evidence, lastReply: reply, readAt });
    await notify(uid, "ask_reply", `${who} can't fit you in at ${label}, ${when}.`);
  } else {
    await ref.update({ lastReply: reply, readAt });
    await notify(uid, "ask_reply", `${who} replied about ${label}, ${when}: "${reply.text.slice(0, 80)}". Open Asks to decide.`);
  }
  console.log(`[asks] ${uid} ${ask.id}: reply read as ${reply.decision}`);
}
