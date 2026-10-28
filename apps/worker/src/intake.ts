// Turns bursts of DMs into spot requests: debounce per chat, classify the whole burst with Gemma,
// upsert one request per comic per week, and auto-acknowledge once.
import type WAWebJS from "whatsapp-web.js";
import {
  AUTO_ACK_MAX_AGE_MS,
  AUTO_ACK_THRESHOLD,
  INTENT_THRESHOLD,
  MAYBE_THRESHOLD,
  DAY_NAMES,
  dateInWeek,
  formatDate,
  formatTime,
  holdFor,
  lastSpot,
  localNow,
  messageRich,
  renderMessage,
  renderTemplate,
  windowOpensLabel,
  rolloverDayFor,
  weekOf,
  type ComicAction,
  type Intent,
  type Lineup,
  type Comic,
  type InboundMessage,
  type SpotRequest,
  cooldownWeeks,
  cooldownWords,
  recentSpot,
} from "@spot/shared";
import { col, db } from "./firebase.ts";
import { classify } from "./gemma.ts";
import { classifyContext, countPriorRequests } from "./classifyContext.ts";
import { watchUser } from "./userData.ts";
import { sendQueued } from "./sendQueue.ts";
import { sendRich } from "./sendRich.ts";
import { composeDraft, deliverDraft } from "./deliver.ts";
import { greetFor } from "./greet.ts";
import { inVoice } from "./voice.ts";
import { counters, live } from "./stats.ts";
import { handleOfferReply, handleOnboardingReply } from "./replies.ts";
import { notice } from "./commands.ts";
import { dropNeverRead, isNeverRead } from "./neverRead.ts";
import { knownComicId } from "./knownComic.ts";
import { afterMembershipHold, checkMembership } from "./membership.ts";

const MAX_CONTEXT = 12;

interface Pending {
  timer: NodeJS.Timeout;
  messages: InboundMessage[];
  contact: { id: string; chatId: string; name: string; nameSource: NonNullable<Comic["nameSource"]>; phone: string; isBusiness: boolean };
  /** Read while the server was down: triage it, but never reply on our own. */
  quiet?: boolean;
  /** Failed reads so far (the AI timed out or wasn't available). */
  tries?: number;
}

/** When a read fails, try again after these waits. Kept in memory only: chats that aren't requests are never stored. */
const RETRY_MS = [2, 5, 15, 30].map((m) => m * 60_000);
const lastAiNotice = new Map<string, number>();

const pending = new Map<string, Pending>();

export function isDirectHumanMessage(msg: WAWebJS.Message) {
  if (msg.fromMe || msg.isStatus || msg.broadcast) return false;
  if (msg.from.endsWith("@g.us") || msg.from === "status@broadcast") return false;
  if (msg.type !== "chat" || !msg.body?.trim()) return false;
  return true;
}

/** Stable identity for a sender. WhatsApp often hands us an @lid; map it back to the phone number when it'll tell us. */
export async function resolveContact(client: WAWebJS.Client, msg: WAWebJS.Message, uid?: string) {
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
  // Already on the roster under another id (phone vs @lid)? Use that one, so no second comic or request is created.
  const id = uid ? await knownComicId(uid, { id: pn ?? chatId, chatId, phone }) : (pn ?? chatId);
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
  // Never read comes first: nothing about this message is read, counted, stored or sent to a model.
  if (await isNeverRead(uid, client, msg.from, msg.author)) return;
  if (!isDirectHumanMessage(msg)) return;
  const since = liveSince.get(uid);
  if (!opts.quiet && (!since || msg.timestamp * 1000 < since - 5_000)) return;
  counters.messagesIn++;
  live.noteIn(uid);
  const contact = await resolveContact(client, msg, uid);
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
    flush(uid, client, next).catch((e) => void retryLater(uid, client, key, next, e as Error));
  }, settings.debounceSeconds * 1000);
  pending.set(key, next);
}

/**
 * The AI couldn't read a burst (a slow local model timing out, no Gemini key to fall back on). Don't drop it: try again
 * later, and tell the curator once an hour what's wrong (no message text in the notice). After the last try, point them
 * at Scan past messages, which re-reads WhatsApp once the AI works again.
 */
const readNoticed = new Map<string, number>();
const gaveUp = new Set<string>();

async function retryLater(uid: string, client: WAWebJS.Client, key: string, p: Pending, e: Error) {
  const tries = (p.tries ?? 0) + 1;
  console.error(`[intake] ${uid} flush failed (try ${tries})`, e);
  const last = lastAiNotice.get(uid) ?? 0;
  // One "couldn't read" notice per hour for the account, and never twice for the same person in that hour.
  const noticeKey = `${uid}|${p.contact.id}`;
  if (Date.now() - last > 60 * 60_000 && Date.now() - (readNoticed.get(noticeKey) ?? 0) > 60 * 60_000) {
    readNoticed.set(noticeKey, Date.now());
    lastAiNotice.set(uid, Date.now());
    const why = /No Gemini API key/.test(e.message)
      ? "The local model on your server is too slow to answer in time and there's no Gemini key to fall back on. Add a Gemini key in Settings → AI models, or move your account to a faster server."
      : `The AI couldn't read them (${e.message}).`;
    // Still retrying: the app's Updates only. The agent hears about it once, if it finally fails.
    await notice(uid, "warn", `Couldn't read new messages from ${p.contact.name}. ${why} Trying again in a few minutes.`, undefined, { quiet: true }).catch(() => undefined);
  }
  if (tries > RETRY_MS.length) {
    if (gaveUp.has(`${key}|${p.messages[0]?.id}`)) return;
    gaveUp.add(`${key}|${p.messages[0]?.id}`);
    await notice(uid, "warn", `Gave up reading messages from ${p.contact.name} after ${tries} tries. Once the AI works again, run Requests → Scan past messages to pick them up.`, undefined, { link: "/requests?view=updates", linkLabel: "See what happened" }).catch(() => undefined);
    return;
  }
  // A newer burst from the same person may already be waiting: fold these messages into it rather than racing it.
  const cur = pending.get(key);
  if (cur) {
    for (const m of p.messages) if (!cur.messages.some((x) => x.id === m.id)) cur.messages.push(m);
    return;
  }
  const next: Pending = { ...p, tries, timer: undefined as never };
  next.timer = setTimeout(() => {
    pending.delete(key);
    flush(uid, client, next).catch((err) => void retryLater(uid, client, key, next, err as Error));
  }, RETRY_MS[tries - 1]);
  pending.set(key, next);
}

async function flush(uid: string, client: WAWebJS.Client, p: Pending) {
  // Added to Never read while this burst was waiting (or being retried): drop it unread.
  if (await isNeverRead(uid, client, p.contact.id, p.contact.chatId)) return;
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
  if (intent.isSpotRequest) live.noteSpot(uid);

  const now = Date.now();
  const locked = existing && ["confirmed", "dismissed", "assigned", "rejected"].includes(existing.status);
  const newest = Math.max(...p.messages.map((m) => m.at));
  // Already on the lineup and in the group: confirmed (no request). In one but not the other, or unknown: held for the curator.
  const member = await checkMembership({ uid, client, p, intent, known, existing, locked: Boolean(locked), week });
  if (member.done) return;
  // V1 rules: banned/ignored/host lists, the weekly request window, and last week's performers.
  const hold = existing?.holdOverridden || locked ? (existing?.hold ?? null) : (member.hold ?? holdFor({ comic: known, week, at: new Date(newest), rules: settings.rules, timeZone: settings.timezone, regular: member.regular }));
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
    ...(member.hold && { holdNote: member.holdNote }),
    holdOverridden: existing?.holdOverridden ?? false,
    heldRepliedAt: existing?.heldRepliedAt ?? null,
    contact: { chatId: p.contact.chatId, phone: p.contact.phone, nameSource: p.contact.nameSource },
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
    // Only clear spot asks (and people already on the roster) belong in Comics; a Maybe joins when you place it.
    if (!cur && request.intent.isSpotRequest && request.intent.confidence >= INTENT_THRESHOLD) {
      const c: Comic = { id: p.contact.id, chatId: p.contact.chatId, name: p.contact.name, nameSource: p.contact.nameSource, phone: p.contact.phone, tier: "open", lastPerformedWeek: null, regularOf: [] };
      tx.set(comicRef, c);
    } else if (cur) {
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
  if (member.hold) await afterMembershipHold({ uid, client, p, week, outcome: member, known });

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

  // Held by the window or last-week rule: optionally say why, once. Banned, ignored and hosts never hear back.
  const okToExplain =
    !p.quiet &&
    settings.heldReplies?.enabled &&
    (hold === "midweek" || hold === "last_week") &&
    !request.holdOverridden &&
    !locked &&
    !request.heldRepliedAt &&
    intent.isSpotRequest &&
    intent.confidence >= AUTO_ACK_THRESHOLD &&
    !p.contact.isBusiness &&
    Date.now() - newest < AUTO_ACK_MAX_AGE_MS;
  if (okToExplain) await explainHold(uid, client, request, hold);

  // V1 new-contact flow: someone you haven't saved asks for a spot → draft "who are you?".
  if (settings.onboarding.enabled && intent.isSpotRequest && !existing && p.contact.nameSource !== "contact" && !known?.onboarding && !p.contact.isBusiness) {
    await draftOnboarding(uid, client, p, week);
  }
}

async function explainHold(uid: string, client: WAWebJS.Client, r: SpotRequest, hold: "midweek" | "last_week") {
  const { settings } = watchUser(uid);
  const comic = (await col(uid, "comics").doc(r.comicId).get()).data() as Comic | undefined;
  const name = await greetFor(client, comic ?? { id: r.comicId, name: r.comicName });
  const kind = hold === "midweek" ? "heldWindow" : "heldLastWeek";
  const weeks = cooldownWeeks(settings.rules);
  const spot = hold === "last_week" ? recentSpot(comic, r.weekOf, weeks) : null;
  const facts = {
    name,
    opens: windowOpensLabel(settings.rules.window),
    ...(spot && { ...cooldownWords(spot.date, r.weekOf, weeks, formatDate), lastShow: spot.showName, lastDate: formatDate(spot.date) }),
  };
  await col(uid, "requests").doc(r.id).update({ heldRepliedAt: Date.now() });
  if (settings.heldReplies?.mode === "review") {
    // Drafted in Updates → Needs a reply; nothing goes out until the curator sends it.
    const { draft, rich } = await composeDraft(uid, kind, facts);
    await col(uid, "actions").doc(`${r.id}_held`).set({
      kind: "held",
      comicId: r.comicId,
      comicName: r.comicName,
      weekOf: r.weekOf,
      message: r.messages.map((m) => m.body).join("\n"),
      draft,
      ...(rich && { rich }),
      lineupId: null,
      status: "pending",
      createdAt: Date.now(),
    } satisfies Omit<ComicAction, "id">);
    console.log(`[held] drafted for ${comic?.name ?? r.comicName} (${hold})`);
    return;
  }
  await sendRich(client, comic?.chatId ?? r.comicId, messageRich(settings, kind), facts, null, { rewrite: (t) => inVoice(uid, kind, t, facts), uid });
  console.log(`[held] told ${comic?.name ?? r.comicName} (${hold})`);
}

async function draftOnboarding(uid: string, client: WAWebJS.Client, p: Pending, week: string) {
  const { settings } = watchUser(uid);
  const name = await greetFor(client, { id: p.contact.id, chatId: p.contact.chatId, name: p.contact.nameSource === "number" ? "" : p.contact.name, nameSource: p.contact.nameSource });
  const { draft, rich } = await composeDraft(uid, "onboard", { name });
  const ref = col(uid, "actions").doc(actionId(p, "onboard"));
  const created = await ref.create({
    kind: "onboard",
    comicId: p.contact.id,
    comicName: p.contact.name,
    weekOf: week,
    message: p.messages.map((m) => m.body).join("\n"),
    draft,
    ...(rich && { rich }),
    lineupId: null,
    status: "pending",
    createdAt: Date.now(),
  } satisfies Omit<ComicAction, "id">).then(() => true).catch(() => false);
  if (!created) return;
  const fresh = Date.now() - Math.max(...p.messages.map((m) => m.at)) < AUTO_ACK_MAX_AGE_MS;
  if (settings.selfService.autoSend && fresh && !p.quiet) {
    await deliverDraft(uid, client, p.contact.chatId, draft, rich);
    await ref.update({ status: "sent", sentAt: Date.now() });
    await col(uid, "comics").doc(p.contact.id).set({ onboarding: "asked" }, { merge: true });
  }
}

async function acknowledge(uid: string, client: WAWebJS.Client, r: SpotRequest) {
  const { settings } = watchUser(uid);
  if (!settings.ack.enabled) return;
  const comic = (await col(uid, "comics").doc(r.comicId).get()).data() as Comic | undefined;
  const name = await greetFor(client, comic ?? { id: r.comicId, name: r.comicName });
  await sendRich(client, comic?.chatId ?? r.comicId, { kind: "text", body: settings.ack.template }, { name }, null, { rewrite: (t) => inVoice(uid, "ack", t, { name }) });
  await col(uid, "requests").doc(r.id).update({ ackedAt: Date.now(), status: "acked" });
  console.log(`[ack] sent to ${comic?.name ?? r.comicName}`);
}

/** Draft a reply for a booked comic's question or drop-out. Sent only when the curator approves (or opted into auto-send). */
async function draftAction(uid: string, client: WAWebJS.Client, p: Pending, intent: Intent, week: string) {
  const { settings, shows, venues } = watchUser(uid);
  const comic = (await col(uid, "comics").doc(p.contact.id).get()).data() as Comic | undefined;
  const name = await greetFor(client, comic ?? { id: p.contact.id, chatId: p.contact.chatId, name: p.contact.name, nameSource: p.contact.nameSource });
  const lineups = (await col(uid, "lineups").where("weekOf", "==", week).get()).docs.map((d) => d.data() as Lineup);
  const mine = lineups.find((l) => l.slots.some((s) => s.comicId === p.contact.id));
  const show = shows.find((s) => s.id === mine?.showId);
  const venue = venues.find((v) => v.id === show?.venueId);
  const vars = { name, ...(show && { show: show.name, venue: venue?.name, day: DAY_NAMES[show.weekday], date: formatDate(dateInWeek(week, show.weekday)), time: formatTime(show.startTime) }) };
  const say = (key: Parameters<typeof renderMessage>[1], extra: Record<string, string | null | undefined> = {}) => {
    return composeDraft(uid, key as Exclude<typeof key, "groupWelcome">, { ...vars, ...extra }, venue);
  };

  let drafted: Awaited<ReturnType<typeof say>>;
  if (intent.kind === "cancel_spot") {
    drafted = await (mine && show ? say("cancelDone") : say("cancelNone"));
  } else if (intent.kind === "status_query") {
    drafted = await (mine && show ? say(mine.status === "confirmed" ? "statusConfirmed" : "statusPencilled") : say("statusNone"));
  } else if (intent.kind === "show_info") {
    const lines = shows
      .filter((s) => s.active)
      .map((s) => {
        const v = venues.find((x) => x.id === s.venueId);
        return `• ${s.name}: ${DAY_NAMES[s.weekday]}s at ${formatTime(s.startTime)}${v ? `, ${v.name}${v.area ? ` (${v.area})` : ""}` : ""}${v?.mapsLink ? `\n  ${v.mapsLink}` : ""}`;
      });
    drafted = await say("showInfo", { shows: lines.join("\n") });
  } else {
    const last = lastSpot(comic?.history, localNow(new Date(), settings.timezone).date);
    drafted = await say("lastSpot", { lastShow: last?.showName, lastDate: last ? formatDate(last.date) : null });
  }
  const { draft, rich } = drafted;

  const action: Omit<ComicAction, "id"> = {
    kind: intent.kind as ComicAction["kind"],
    comicId: p.contact.id,
    comicName: comic?.name ?? p.contact.name,
    weekOf: week,
    message: p.messages.map((m) => m.body).join("\n"),
    draft,
    ...(rich && { rich }),
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
    await deliverDraft(uid, client, comic?.chatId ?? p.contact.chatId, draft, rich);
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
  let chats = (await client.getChats())
    .filter((c) => !c.isGroup && !c.isReadOnly && c.timestamp * 1000 > since)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 60);
  // Never read chats are not even opened.
  chats = await dropNeverRead(uid, client, chats);
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
