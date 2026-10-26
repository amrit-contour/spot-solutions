// Turns bursts of DMs into spot requests: debounce per chat, classify the whole burst with Gemma,
// upsert one request per comic per week, and auto-acknowledge once.
import type WAWebJS from "whatsapp-web.js";
import {
  AUTO_ACK_MAX_AGE_MS,
  AUTO_ACK_THRESHOLD,
  MAYBE_THRESHOLD,
  DAY_NAMES,
  dateInWeek,
  formatDate,
  formatTime,
  holdFor,
  lastSpot,
  localNow,
  renderTemplate,
  rolloverDayFor,
  weekOf,
  type ComicAction,
  type Intent,
  type Lineup,
  type Comic,
  type InboundMessage,
  type SpotRequest,
} from "@spot/shared";
import { col, db } from "./firebase.ts";
import { classify } from "./gemma.ts";
import { classifyContext, countPriorRequests } from "./classifyContext.ts";
import { watchUser } from "./userData.ts";
import { sendQueued } from "./sendQueue.ts";
import { counters } from "./stats.ts";
import { handleOfferReply, handleOnboardingReply } from "./replies.ts";

const MAX_CONTEXT = 12;

interface Pending {
  timer: NodeJS.Timeout;
  messages: InboundMessage[];
  contact: { id: string; chatId: string; name: string; nameSource: NonNullable<Comic["nameSource"]>; phone: string; isBusiness: boolean };
  /** Read while the server was down: triage it, but never reply on our own. */
  quiet?: boolean;
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

export async function enqueue(uid: string, client: WAWebJS.Client, msg: WAWebJS.Message, opts: { quiet?: boolean } = {}) {
  if (!isDirectHumanMessage(msg)) return;
  const since = liveSince.get(uid);
  if (!opts.quiet && (!since || msg.timestamp * 1000 < since - 5_000)) return;
  counters.messagesIn++;
  const contact = await resolveContact(client, msg);
  const key = `${uid}|${contact.id}`;
  const p = pending.get(key);
  const item: InboundMessage = { id: msg.id._serialized, body: msg.body.slice(0, 1000), at: msg.timestamp * 1000 };
  const { settings } = watchUser(uid);
  if (p) clearTimeout(p.timer);
  const next: Pending = p ?? { messages: [], contact, timer: undefined as never, quiet: true };
  // One live message in the burst makes the whole burst live.
  next.quiet = Boolean(next.quiet && opts.quiet);
  if (!next.messages.some((m) => m.id === item.id)) next.messages.push(item);
  next.timer = setTimeout(() => {
    pending.delete(key);
    flush(uid, client, next).catch((e) => console.error(`[intake] ${uid} flush failed`, e));
  }, settings.debounceSeconds * 1000);
  pending.set(key, next);
}

async function flush(uid: string, client: WAWebJS.Client, p: Pending) {
  const { settings, shows } = watchUser(uid);
  const week = weekOf(new Date(), settings.timezone, rolloverDayFor(shows));
  const reqRef = col(uid, "requests").doc(`${week}_${p.contact.id}`);
  const existing = (await reqRef.get()).data() as SpotRequest | undefined;

  const seen = new Set(existing?.messages.map((m) => m.id));
  const messages = [...(existing?.messages ?? []), ...p.messages.filter((m) => !seen.has(m.id))]
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_CONTEXT);

  const activeShows = shows.filter((s) => s.active);
  // Read the new burst on its own first: "cancel my spot" from someone already booked shouldn't be
  // blended into their earlier spot request.
  const burst = p.messages.map((m) => m.body);
  // Answers to things you started (a spot offer, the "who are you?" question) come first.
  if (await handleOfferReply(uid, client, p.contact.id, burst)) return;
  if (await handleOnboardingReply(uid, p.contact.id, burst)) return;
  const known = (await col(uid, "comics").doc(p.contact.id).get()).data() as Comic | undefined;
  const priorRequests = known ? await countPriorRequests(uid, p.contact.id, week) : 0;
  const ctx = classifyContext(uid, known, week, priorRequests);
  const first = await classify(uid, burst, activeShows, settings.ai, ctx);
  if (first.kind && ["cancel_spot", "status_query", "last_spot_query", "show_info"].includes(first.kind)) {
    console.log(`[intake] ${p.contact.name}: ${first.kind} — ${first.note}`);
    if (settings.selfService.enabled) await draftAction(uid, client, p, first, week);
    return;
  }
  const intent = existing ? await classify(uid, messages.map((m) => m.body), activeShows, settings.ai, ctx) : first;
  console.log(`[intake] ${p.contact.name}: spot=${intent.isSpotRequest} conf=${intent.confidence} (${intent.model}) — ${intent.note}`);

  // Privacy: chats that aren't spot requests are never stored.
  if (!existing && intent.confidence < MAYBE_THRESHOLD) return;

  const now = Date.now();
  const locked = existing && ["confirmed", "dismissed", "assigned", "rejected"].includes(existing.status);
  const newest = Math.max(...p.messages.map((m) => m.at));
  // V1 rules: banned/ignored/host lists, the weekly request window, and last week's performers.
  const hold = existing?.holdOverridden || locked ? (existing?.hold ?? null) : holdFor({ comic: known, week, at: new Date(newest), rules: settings.rules, timeZone: settings.timezone });
  const request: SpotRequest = {
    id: reqRef.id,
    comicId: p.contact.id,
    comicName: p.contact.nameSource === "number" && existing?.comicName ? existing.comicName : p.contact.name,
    weekOf: week,
    messages,
    // A follow-up like "thanks" shouldn't downgrade an earlier clear request.
    intent: existing && existing.intent.confidence > intent.confidence ? { ...existing.intent, note: intent.note ?? existing.intent.note, ...(intent.isSpotRequest && { tags: intent.tags, venueId: intent.venueId }) } : intent,
    status: locked ? existing.status : (existing?.status ?? "new"),
    ackedAt: existing?.ackedAt ?? null,
    hold,
    holdOverridden: existing?.holdOverridden ?? false,
    // Stamped once, when the request is first created.
    firstContact: existing ? (existing.firstContact ?? false) : !known,
    priorRequests: existing ? (existing.priorRequests ?? priorRequests) : priorRequests,
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
  const okToAck =
    !p.quiet &&
    settings.ack.enabled &&
    (!hold || request.holdOverridden) &&
    !locked &&
    !request.ackedAt &&
    intent.isSpotRequest &&
    intent.confidence >= AUTO_ACK_THRESHOLD &&
    !p.contact.isBusiness &&
    Date.now() - newest < AUTO_ACK_MAX_AGE_MS;
  if (okToAck) await acknowledge(uid, client, request);

  // V1 new-contact flow: someone you haven't saved asks for a spot → draft "who are you?".
  if (settings.onboarding.enabled && intent.isSpotRequest && !existing && p.contact.nameSource !== "contact" && !known?.onboarding && !p.contact.isBusiness) {
    await draftOnboarding(uid, client, p, week);
  }
}

async function draftOnboarding(uid: string, client: WAWebJS.Client, p: Pending, week: string) {
  const { settings } = watchUser(uid);
  const greet = p.contact.nameSource === "whatsapp" ? ` ${p.contact.name.split(" ")[0]}` : "";
  const draft = `Hey${greet}! Don't think I have you saved yet 🙂 Could you tell me your full name, which comedy scene you're from, and how long you've been doing comedy? Also, are you travelling?`;
  const ref = col(uid, "actions").doc(actionId(p, "onboard"));
  const created = await ref.create({
    kind: "onboard",
    comicId: p.contact.id,
    comicName: p.contact.name,
    weekOf: week,
    message: p.messages.map((m) => m.body).join("\n"),
    draft,
    lineupId: null,
    status: "pending",
    createdAt: Date.now(),
  } satisfies Omit<ComicAction, "id">).then(() => true).catch(() => false);
  if (!created) return;
  const fresh = Date.now() - Math.max(...p.messages.map((m) => m.at)) < AUTO_ACK_MAX_AGE_MS;
  if (settings.selfService.autoSend && fresh && !p.quiet) {
    await sendQueued(client, p.contact.chatId, draft);
    await ref.update({ status: "sent", sentAt: Date.now() });
    await col(uid, "comics").doc(p.contact.id).set({ onboarding: "asked" }, { merge: true });
  }
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

/** Draft a reply for a booked comic's question or drop-out. Sent only when the curator approves (or opted into auto-send). */
async function draftAction(uid: string, client: WAWebJS.Client, p: Pending, intent: Intent, week: string) {
  const { settings, shows, venues } = watchUser(uid);
  const comic = (await col(uid, "comics").doc(p.contact.id).get()).data() as Comic | undefined;
  const first = (comic?.name ?? p.contact.name).split(" ")[0];
  const lineups = (await col(uid, "lineups").where("weekOf", "==", week).get()).docs.map((d) => d.data() as Lineup);
  const mine = lineups.find((l) => l.slots.some((s) => s.comicId === p.contact.id));
  const show = shows.find((s) => s.id === mine?.showId);
  const when = show && mine ? `${show.name}, ${DAY_NAMES[show.weekday]} ${formatDate(dateInWeek(week, show.weekday))} at ${formatTime(show.startTime)}` : "";

  let draft: string;
  if (intent.kind === "cancel_spot") {
    draft = mine ? `Okay ${first}, I've cancelled your spot for ${when}. See you next time! 🫡` : `Hey ${first}, you don't have a spot this week, so there's nothing to cancel.`;
  } else if (intent.kind === "status_query") {
    draft = mine?.status === "confirmed" ? `Yes! You're on ${when}.` : mine ? `You're pencilled in, but the lineup isn't final yet. I'll confirm soon.` : `You don't have a spot this week yet. I'll let you know once the lineup is out.`;
  } else if (intent.kind === "show_info") {
    const lines = shows
      .filter((s) => s.active)
      .map((s) => {
        const v = venues.find((x) => x.id === s.venueId);
        return `• ${s.name}: ${DAY_NAMES[s.weekday]}s at ${formatTime(s.startTime)}${v ? `, ${v.name}${v.area ? ` (${v.area})` : ""}` : ""}${v?.mapsLink ? `\n  ${v.mapsLink}` : ""}`;
      });
    draft = lines.length ? `Hey ${first}! Here's where and when:\n${lines.join("\n")}` : `Hey ${first}! I'll share the details soon.`;
  } else {
    const last = lastSpot(comic?.history, localNow(new Date(), settings.timezone).date);
    draft = last ? `Your last spot was ${last.showName} on ${formatDate(last.date)}.` : `I don't have a record of your last spot yet.`;
  }

  const action: Omit<ComicAction, "id"> = {
    kind: intent.kind as ComicAction["kind"],
    comicId: p.contact.id,
    comicName: comic?.name ?? p.contact.name,
    weekOf: week,
    message: p.messages.map((m) => m.body).join("\n"),
    draft,
    lineupId: intent.kind === "cancel_spot" && mine && mine.status !== "cancelled" ? `${week}_${mine.showId}` : null,
    status: "pending",
    createdAt: Date.now(),
  };
  // Keyed by the first message, so re-reading the same messages (e.g. catch-up after a restart) never drafts twice.
  const ref = col(uid, "actions").doc(actionId(p));
  if (!(await ref.create(action).then(() => true).catch(() => false))) return;

  const fresh = Date.now() - Math.max(...p.messages.map((m) => m.at)) < AUTO_ACK_MAX_AGE_MS;
  if (settings.selfService.autoSend && fresh && !p.quiet && !p.contact.isBusiness) {
    const { dropFromLineup } = await import("./commands.ts");
    if (action.lineupId) await dropFromLineup(uid, client, p.contact.id, action.lineupId);
    await sendQueued(client, comic?.chatId ?? p.contact.chatId, draft);
    await ref.update({ status: "sent", sentAt: Date.now() });
  }
}

const actionId = (p: Pending, prefix = "a") => `${prefix}_${p.messages[0].id}`.replace(/[^\w-]/g, "_").slice(0, 300);

const CATCHUP_MAX_AGE_MS = 3 * 24 * 3600_000;

/**
 * After the server was down, read the DMs that arrived meanwhile so no spot request is lost.
 * Read-only: they land in Requests / Needs a reply, but nothing is sent automatically.
 * Only runs when an existing WhatsApp link was restored (never on a fresh QR link).
 */
export async function catchUpSince(uid: string, client: WAWebJS.Client, sinceMs: number) {
  const since = Math.max(sinceMs - 60_000, Date.now() - CATCHUP_MAX_AGE_MS);
  const chats = (await client.getChats())
    .filter((c) => !c.isGroup && !c.isReadOnly && c.timestamp * 1000 > since)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 60);
  let n = 0;
  for (const chat of chats) {
    const msgs = await chat.fetchMessages({ limit: 15 }).catch(() => []);
    for (const m of msgs) {
      if (m.timestamp * 1000 <= since || m.fromMe) continue;
      await enqueue(uid, client, m, { quiet: true });
      n++;
    }
  }
  if (n) console.log(`[intake] ${uid} caught up on ${n} messages from ${chats.length} chats received while offline`);
  return n;
}
