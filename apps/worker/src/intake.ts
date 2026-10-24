// Turns bursts of DMs into spot requests: debounce per chat, classify the whole burst with Gemma,
// upsert one request per comic per week, and auto-acknowledge once.
import type WAWebJS from "whatsapp-web.js";
import {
  INTENT_THRESHOLD,
  MAYBE_THRESHOLD,
  renderTemplate,
  weekOf,
  type Comic,
  type InboundMessage,
  type SpotRequest,
} from "@spot/shared";
import { col, db } from "./firebase.ts";
import { classify } from "./gemma.ts";
import { watchUser } from "./userData.ts";
import { sendQueued } from "./sendQueue.ts";

const MAX_CONTEXT = 12;

interface Pending {
  timer: NodeJS.Timeout;
  messages: InboundMessage[];
  contact: { id: string; name: string; phone: string };
}

const pending = new Map<string, Pending>();

export function isDirectHumanMessage(msg: WAWebJS.Message) {
  if (msg.fromMe || msg.isStatus || msg.broadcast) return false;
  if (msg.from.endsWith("@g.us") || msg.from === "status@broadcast") return false;
  if (msg.type !== "chat" || !msg.body?.trim()) return false;
  return true;
}

/** Resolve the stable phone-based id (`91xxxxxxxxxx@c.us`) for a sender, even when WhatsApp hands us an @lid. */
export async function resolveContact(msg: WAWebJS.Message) {
  const contact = await msg.getContact();
  const phone = contact.number || msg.from.split("@")[0];
  return {
    id: `${phone}@c.us`,
    name: contact.pushname || contact.name || contact.shortName || `+${phone}`,
    phone,
  };
}

export async function enqueue(uid: string, client: WAWebJS.Client, msg: WAWebJS.Message) {
  if (!isDirectHumanMessage(msg)) return;
  const contact = await resolveContact(msg);
  const key = `${uid}|${contact.id}`;
  const p = pending.get(key);
  const item: InboundMessage = { id: msg.id._serialized, body: msg.body.slice(0, 1000), at: msg.timestamp * 1000 };
  const { settings } = watchUser(uid);
  if (p) clearTimeout(p.timer);
  const next: Pending = p ?? { messages: [], contact, timer: undefined as never };
  if (!next.messages.some((m) => m.id === item.id)) next.messages.push(item);
  next.timer = setTimeout(() => {
    pending.delete(key);
    flush(uid, client, next).catch((e) => console.error(`[intake] ${uid} flush failed`, e));
  }, settings.debounceSeconds * 1000);
  pending.set(key, next);
}

async function flush(uid: string, client: WAWebJS.Client, p: Pending) {
  const { settings, shows } = watchUser(uid);
  const week = weekOf(new Date(), settings.timezone);
  const reqRef = col(uid, "requests").doc(`${week}_${p.contact.id}`);
  const existing = (await reqRef.get()).data() as SpotRequest | undefined;

  const seen = new Set(existing?.messages.map((m) => m.id));
  const messages = [...(existing?.messages ?? []), ...p.messages.filter((m) => !seen.has(m.id))]
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_CONTEXT);

  const activeShows = shows.filter((s) => s.active);
  const intent = await classify(messages.map((m) => m.body), activeShows, settings.model);
  console.log(`[intake] ${p.contact.name}: spot=${intent.isSpotRequest} conf=${intent.confidence} (${intent.model}) — ${intent.note}`);

  // Privacy: chats that aren't spot requests are never stored.
  if (!existing && intent.confidence < MAYBE_THRESHOLD) return;

  const now = Date.now();
  const locked = existing && ["confirmed", "dismissed", "assigned", "rejected"].includes(existing.status);
  const request: SpotRequest = {
    id: reqRef.id,
    comicId: p.contact.id,
    comicName: existing?.comicName ?? p.contact.name,
    weekOf: week,
    messages,
    // A follow-up like "thanks" shouldn't downgrade an earlier clear request.
    intent: existing && existing.intent.confidence > intent.confidence ? { ...existing.intent, note: intent.note ?? existing.intent.note } : intent,
    status: locked ? existing.status : (existing?.status ?? "new"),
    ackedAt: existing?.ackedAt ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const comicRef = col(uid, "comics").doc(p.contact.id);
  await db.runTransaction(async (tx) => {
    const comic = await tx.get(comicRef);
    if (!comic.exists) {
      const c: Comic = { id: p.contact.id, name: p.contact.name, phone: p.contact.phone, tier: "open", lastPerformedWeek: null, regularOf: [] };
      tx.set(comicRef, c);
    }
    tx.set(reqRef, request);
  });

  if (settings.ack.enabled && !request.ackedAt && request.intent.confidence >= INTENT_THRESHOLD && !locked) {
    const name = (await comicRef.get()).data()?.name ?? p.contact.name;
    const body = renderTemplate(settings.ack.template, { name: name.split(" ")[0] });
    await sendQueued(client, p.contact.id, body);
    await reqRef.update({ ackedAt: Date.now(), status: "acked" });
  }
}

/** After downtime, replay unread DMs so nothing asked overnight is missed. */
export async function catchUp(uid: string, client: WAWebJS.Client) {
  const chats = await client.getChats();
  const unread = chats.filter((c) => !c.isGroup && c.unreadCount > 0).slice(0, 100);
  for (const chat of unread) {
    const msgs = await chat.fetchMessages({ limit: Math.min(chat.unreadCount, MAX_CONTEXT) });
    for (const m of msgs) await enqueue(uid, client, m);
  }
  if (unread.length) console.log(`[intake] ${uid} catching up on ${unread.length} unread chats`);
}
