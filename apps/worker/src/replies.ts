// Replies to things the curator started: spot offers, onboarding questions, host polls, mic checks.
import type WAWebJS from "whatsapp-web.js";
import {
  dateInWeek,
  formatDate,
  localNow,
  parseYesNo,
  withHistory,
  type Comic,
  type HostPoll,
  type Lineup,
  type SpotOffer,
  type SpotRequest,
} from "@spot/shared";
import { col, db } from "./firebase.ts";
import { extractProfile } from "./gemma.ts";
import { confirmBody, notice } from "./commands.ts";
import { sendQueued } from "./sendQueue.ts";
import { watchUser } from "./userData.ts";

/** A pending offer's yes/no. Returns true when the messages were an answer to it. */
export async function handleOfferReply(uid: string, client: WAWebJS.Client, comicId: string, texts: string[]) {
  const snap = await col(uid, "offers").where("comicId", "==", comicId).where("status", "==", "pending").limit(1).get();
  const doc = snap.docs[0];
  if (!doc) return false;
  const offer = { ...(doc.data() as SpotOffer), id: doc.id };
  if (offer.expiresAt < Date.now()) {
    await doc.ref.update({ status: "expired" });
    return false;
  }
  const answer = texts.map(parseYesNo).find((a) => a !== null) ?? null;
  if (answer === null) return false;
  const reply = texts.join("\n").slice(0, 300);

  if (!answer) {
    await doc.ref.update({ status: "declined", reply });
    await notice(uid, "info", `${offer.comicName} passed on the ${showName(uid, offer.showId)} spot.`);
    return true;
  }

  const { shows, settings } = watchUser(uid);
  const show = shows.find((s) => s.id === offer.showId);
  const lineupRef = col(uid, "lineups").doc(offer.lineupId);
  const comicRef = col(uid, "comics").doc(comicId);
  const booked = await db.runTransaction(async (tx) => {
    const lineup = (await tx.get(lineupRef)).data() as Lineup | undefined;
    if (!show || !lineup || lineup.status === "cancelled" || lineup.status === "canned") return null;
    if (lineup.slots.some((s) => s.comicId === comicId)) return lineup;
    if (lineup.slots.length >= show.slotCount) return null;
    const comic = (await tx.get(comicRef)).data() as Comic | undefined;
    const date = dateInWeek(lineup.weekOf, show.weekday);
    tx.update(lineupRef, { slots: [...lineup.slots, { comicId, minutes: show.includeSlotTime ? (show.defaultMinutes ?? null) : null }] });
    tx.set(comicRef, { lastPerformedWeek: lineup.weekOf, history: withHistory(comic?.history, { date, showId: show.id, showName: show.name, status: "confirmed" }) }, { merge: true });
    const reqRef = col(uid, "requests").doc(`${lineup.weekOf}_${comicId}`);
    const req = (await tx.get(reqRef)).data() as SpotRequest | undefined;
    if (req) tx.update(reqRef, { status: "confirmed", updatedAt: Date.now() });
    return lineup;
  });

  if (!booked || !show) {
    await doc.ref.update({ status: "full", reply });
    await sendQueued(client, await chatOf(uid, comicId), "Ah, sorry! That spot just got filled. I'll keep you in mind for the next one 🙏");
    await notice(uid, "warn", `${offer.comicName} said yes, but ${show?.name ?? "the show"} was already full. They've been told.`);
    return true;
  }

  await doc.ref.update({ status: "accepted", reply });
  const comic = (await comicRef.get()).data() as Comic;
  await sendQueued(client, comic.chatId ?? comicId, confirmBody(uid, show, comic, booked.weekOf));
  // Show is today and its group is managed: add them now.
  if (show.groupId && localNow(new Date(), settings.timezone).date === dateInWeek(booked.weekOf, show.weekday)) {
    const group = (await client.getChatById(show.groupId)) as WAWebJS.GroupChat;
    await group.addParticipants([comicId], { autoSendInviteV4: true, comment: `You're on for ${show.name}!` }).catch(() => undefined);
  }
  await notice(uid, "info", `${offer.comicName} took the ${show.name} spot and got the confirmation.`);
  return true;
}

/** Reply to the onboarding question: fill in their profile. Returns true when handled. */
export async function handleOnboardingReply(uid: string, comicId: string, texts: string[]) {
  const ref = col(uid, "comics").doc(comicId);
  const comic = (await ref.get()).data() as Comic | undefined;
  if (comic?.onboarding !== "asked") return false;
  const { settings } = watchUser(uid);
  const p = await extractProfile(uid, texts, settings.ai);
  if (!p.name && !p.scene && !p.years) return false; // not an answer; let normal intake read it
  await ref.set(
    {
      onboarding: "done",
      profile: { scene: p.scene, years: p.years, travelling: p.travelling },
      // A self-given name beats a WhatsApp display name, but never a name you typed in yourself.
      ...(p.name && comic.nameSource !== "manual" && comic.nameSource !== "contact" ? { name: p.name, nameSource: "whatsapp" } : {}),
    },
    { merge: true },
  );
  const bits = [p.scene && `from ${p.scene}`, p.years && `${p.years} yr${p.years === 1 ? "" : "s"} in comedy`, p.travelling && "travelling"].filter(Boolean).join(", ");
  await notice(uid, "info", `${p.name ?? comic.name} introduced themselves${bits ? `: ${bits}` : ""}. Save them in your phone so their name sticks.`);
  return true;
}

/** Live host-poll votes. WhatsApp sends the voter's full current selection each time. */
export async function handleVote(uid: string, client: WAWebJS.Client, vote: WAWebJS.PollVote) {
  const msgId = vote.parentMessage?.id?._serialized;
  if (!msgId) return;
  const snap = await col(uid, "polls").where("messageId", "==", msgId).limit(1).get();
  const doc = snap.docs[0];
  if (!doc) return;
  const poll = doc.data() as HostPoll;
  let voter = vote.voter;
  if (voter.endsWith("@lid")) voter = (await client.getContactLidAndPhone([voter]).catch(() => []))[0]?.pn ?? voter;
  const contact = await client.getContactById(vote.voter).catch(() => null);
  const name = (contact?.isMyContact && contact.name) || contact?.pushname || `+${voter.split("@")[0]}`;
  const showIds = vote.selectedOptions.map((o) => poll.options.find((x) => x.name === o.name)?.showId).filter(Boolean) as string[];
  await doc.ref.update({ [`votes.${voter.replace(/\./g, "_")}`]: showIds, [`voterNames.${voter.replace(/\./g, "_")}`]: name });
}

/** Curator replied "yes"/"no" to a mic check in their own chat (Message yourself). */
export async function handleSelfReply(uid: string, client: WAWebJS.Client, msg: WAWebJS.Message) {
  const self = client.info?.wid?._serialized;
  if (!msg.fromMe || !self || msg.to !== self || msg.body.startsWith("🎤")) return;
  const answer = parseYesNo(msg.body);
  if (answer === null) return;
  const pending = await col(uid, "lineups").where("micCheckSentOn", "!=", null).get();
  const open = pending.docs.filter((d) => !(d.data() as Lineup).outcome).sort((a, b) => ((b.data() as Lineup).date ?? "").localeCompare((a.data() as Lineup).date ?? ""))[0];
  if (!open) return;
  await recordOutcome(uid, open.id, answer ? "happened" : "canned");
  await sendQueued(client, self, `🎤 Noted: ${answer ? "it happened" : "marked as didn't happen"}.`);
}

/** Store a mic-check answer. "canned" undoes the night for everyone on it. */
export async function recordOutcome(uid: string, lineupId: string, outcome: "happened" | "canned") {
  const ref = col(uid, "lineups").doc(lineupId);
  const lineup = (await ref.get()).data() as Lineup | undefined;
  if (!lineup) return;
  if (outcome === "happened") return void (await ref.update({ outcome }));
  const { shows } = watchUser(uid);
  const show = shows.find((s) => s.id === lineup.showId);
  const date = show ? dateInWeek(lineup.weekOf, show.weekday) : lineup.date;
  await ref.update({ outcome, status: "canned" });
  for (const s of lineup.slots) {
    const cref = col(uid, "comics").doc(s.comicId);
    const c = (await cref.get()).data() as Comic | undefined;
    await cref.set({ history: withHistory(c?.history, { date, showId: lineup.showId, showName: show?.name ?? "Show", status: "canned" }), ...(c?.lastPerformedWeek === lineup.weekOf ? { lastPerformedWeek: null } : {}) }, { merge: true });
  }
}

/** Morning after a confirmed show: ask (in the app always, on WhatsApp if enabled). */
export async function sendMicChecks(uid: string, client: WAWebJS.Client) {
  const { settings, shows } = watchUser(uid);
  if (!settings.micCheck.enabled) return;
  const now = localNow(new Date(), settings.timezone);
  if (now.time < settings.micCheck.time) return;
  const snap = await col(uid, "lineups").where("status", "==", "confirmed").get();
  for (const d of snap.docs) {
    const l = d.data() as Lineup;
    if (l.outcome || l.micCheckSentOn || !l.date || l.date >= now.date) continue;
    await d.ref.update({ micCheckSentOn: now.date });
    if (!settings.micCheck.whatsapp) continue;
    const self = client.info?.wid?._serialized;
    if (!self) continue;
    const show = shows.find((s) => s.id === l.showId);
    await sendQueued(client, self, `🎤 Did *${show?.name ?? "the show"}* on ${formatDate(l.date)} happen? Reply *yes* or *no* here.`);
  }
}

export async function expireOffers(uid: string) {
  const snap = await col(uid, "offers").where("status", "==", "pending").get();
  for (const d of snap.docs) {
    const o = d.data() as SpotOffer;
    if (o.expiresAt > Date.now()) continue;
    await d.ref.update({ status: "expired" });
    await notice(uid, "info", `No reply from ${o.comicName} about the ${showName(uid, o.showId)} spot. The offer expired.`);
  }
}

function showName(uid: string, showId: string) {
  return watchUser(uid).shows.find((s) => s.id === showId)?.name ?? "show";
}

async function chatOf(uid: string, comicId: string) {
  return ((await col(uid, "comics").doc(comicId).get()).data() as Comic | undefined)?.chatId ?? comicId;
}

