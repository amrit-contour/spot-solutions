// Turns bursts of DMs into spot requests: debounce per chat, classify the whole burst with Gemma,
// upsert one request per comic per week, and auto-acknowledge once.
import type WAWebJS from "whatsapp-web.js";
import {
  AUTO_ACK_MAX_AGE_MS,
  AUTO_ACK_THRESHOLD,
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
  contact: { id: string; chatId: string; name: string; nameSource: NonNullable<Comic["nameSource"]>; phone: string; isBusiness: boolean };
}

const pending = new Map<string, Pending>();

export function isDirectHumanMessage(msg: WAWebJS.Message) {
  if (msg.fromMe || msg.isStatus || msg.broadcast) return false;
  if (msg.from.endsWith("@g.us") || msg.from === "status@broadcast") return false;
  if (msg.type !== "chat" || !msg.body?.trim()) return false;
  return true;
}

/** Stable identity for a sender. WhatsApp often hands us an @lid; map it back to the phone number when it'll tell us. */
export async function resolveContact(client: WAWebJS.Client, msg: WAWebJS.Message) {
  const chatId = msg.from;
  const contact = await msg.getContact().catch(() => null);
  let pn: string | undefined = chatId.endsWith("@c.us") ? chatId : undefined;
  if (!pn) {
    try {
      pn = (await client.getContactLidAndPhone([chatId]))[0]?.pn;
    } catch {
      /* unknown mapping — fall back to the lid */
    }
  }
  const phone = pn?.split("@")[0] ?? "";
  const id = pn ?? chatId;
  // Prefer the name saved in the curator's phone, then the person's WhatsApp profile name.
  const saved = contact?.isMyContact ? contact.name?.trim() : undefined;
  const profile = contact?.pushname?.trim();
  const name = saved || profile || (phone ? `+${phone}` : "Unknown");
  const nameSource = saved ? "contact" : profile ? "whatsapp" : "number";
  // Banks, telcos, delivery apps: business or verified accounts never get an automatic reply.
  const isBusiness = Boolean(contact?.isBusiness || contact?.isEnterprise);
  return { id, chatId, name, nameSource, phone, isBusiness } as const;
}

/** Messages from before this moment (per curator) are backlog: never read, never answered. */
const liveSince = new Map<string, number>();
export const markLive = (uid: string) => liveSince.set(uid, Date.now());

export async function enqueue(uid: string, client: WAWebJS.Client, msg: WAWebJS.Message) {
  if (!isDirectHumanMessage(msg)) return;
  const since = liveSince.get(uid);
  if (!since || msg.timestamp * 1000 < since - 5_000) return;
  const contact = await resolveContact(client, msg);
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
    comicName: p.contact.nameSource === "number" && existing?.comicName ? existing.comicName : p.contact.name,
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
    const cur = comic.data() as Comic | undefined;
    if (!cur) {
      const c: Comic = { id: p.contact.id, chatId: p.contact.chatId, name: p.contact.name, nameSource: p.contact.nameSource, phone: p.contact.phone, tier: "open", lastPerformedWeek: null, regularOf: [] };
      tx.set(comicRef, c);
    } else {
      const patch: Partial<Comic> = {};
      if (cur.chatId !== p.contact.chatId) patch.chatId = p.contact.chatId;
      // Keep auto names fresh (e.g. you saved them in your phone since), never override a hand-edited one.
      const rank = { number: 0, whatsapp: 1, contact: 2, manual: 3 } as const;
      const curRank = rank[cur.nameSource ?? "whatsapp"];
      if (cur.nameSource !== "manual" && cur.name !== p.contact.name && rank[p.contact.nameSource] >= Math.min(curRank, 2)) {
        patch.name = p.contact.name;
        patch.nameSource = p.contact.nameSource;
      }
      if (Object.keys(patch).length) tx.update(comicRef, patch);
    }
    tx.set(reqRef, request);
  });

  // Every guard must pass before anything is sent on the curator's behalf.
  const newest = Math.max(...p.messages.map((m) => m.at));
  const okToAck =
    settings.ack.enabled &&
    !locked &&
    !request.ackedAt &&
    intent.isSpotRequest &&
    intent.confidence >= AUTO_ACK_THRESHOLD &&
    !p.contact.isBusiness &&
    Date.now() - newest < AUTO_ACK_MAX_AGE_MS;
  if (okToAck) await acknowledge(uid, client, request);
}

async function acknowledge(uid: string, client: WAWebJS.Client, r: SpotRequest) {
  const { settings } = watchUser(uid);
  if (!settings.ack.enabled) return;
  const comic = (await col(uid, "comics").doc(r.comicId).get()).data() as Comic | undefined;
  const body = renderTemplate(settings.ack.template, { name: (comic?.name ?? r.comicName).split(" ")[0] });
  await sendQueued(client, comic?.chatId ?? r.comicId, body);
  await col(uid, "requests").doc(r.id).update({ ackedAt: Date.now(), status: "acked" });
  console.log(`[ack] sent to ${comic?.name ?? r.comicName}`);
}
