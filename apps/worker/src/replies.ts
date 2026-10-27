// Replies to things the curator started: spot offers, onboarding questions, host polls, mic checks.
import type WAWebJS from "whatsapp-web.js";
import {
  confirmPending,
  dateInWeek,
  directNotice,
  formatDate,
  onYes,
  localNow,
  messageRich,
  micCheckDue,
  micDelayHours,
  offerVote,
  OFFER_POLL_OPTIONS,
  parseYesNo,
  renderMessage,
  adhocToldPatch,
  sentSnapshot,
  toldSent,
  withHistory,
  type Comic,
  type HostPoll,
  type Lineup,
  type SpotOffer,
  type Show,
  type Slot,
  type SpotRequest,
} from "@spot/shared";
import { col, db } from "./firebase.ts";
import { extractProfile } from "./gemma.ts";
import { notice, sendConfirmation } from "./commands.ts";
import { sendQueued } from "./sendQueue.ts";
import { sendRich } from "./sendRich.ts";
import { greetFor } from "./greet.ts";
import { inVoice } from "./voice.ts";
import { watchUser } from "./userData.ts";
import { askCurator, sendMicCheck } from "./agentOutbox.ts";

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
  await settleOffer(uid, client, doc.ref, offer, answer, texts.join("\n").slice(0, 300));
  return true;
}

/** Every offer in the same ad hoc round. */
async function roundOffers(uid: string, roundId: string) {
  return (await col(uid, "offers").where("round.id", "==", roundId).get()).docs.map((d) => ({ ...(d.data() as SpotOffer), id: d.id, ref: d.ref }));
}

/**
 * A yes or no to an offer. Shared by typed replies and poll votes. One comic asked: yes books it. Several asked at once:
 * yes books it while slots are left (auto-add) or waits in Updates for the curator to pick; a yes after it filled is told so.
 */
async function settleOffer(uid: string, client: WAWebJS.Client, offerRef: FirebaseFirestore.DocumentReference, offer: SpotOffer, answer: boolean, reply: string) {
  const show = showName(uid, offer.showId);
  if (!answer) {
    await offerRef.update({ status: "declined", reply });
    const single = !offer.round || offer.round.size <= 1;
    await notice(uid, single ? "warn" : "info", `${offer.comicName} passed on the ${show} spot.${single ? " Offer it to someone else from Lineup." : ""}`, "offer");
    return;
  }
  const round = offer.round ? await roundOffers(uid, offer.round.id) : [];
  const step = onYes(offer, round);
  if (step === "full") return void (await tellFull(uid, client, offerRef, offer, reply, false));
  if (step === "pick") {
    await offerRef.update({ status: "interested", reply });
    const yeses = round.filter((o) => o.status === "interested").length + 1;
    await notice(uid, "info", `${offer.comicName} said yes to the ${show} ad hoc spot (${yeses} yes so far for ${offer.round!.slots} spot${offer.round!.slots === 1 ? "" : "s"}). Pick who gets it in Updates.`, "offer");
    await askAgentToPick(uid, offer, show);
    return;
  }
  await bookOffer(uid, client, offerRef, offer, reply);
}

/** With the agent number linked: "Rohan said yes. Add them?" A yes there books them (see agent.ts, adhoc_pick). */
async function askAgentToPick(uid: string, offer: SpotOffer, show: string) {
  const summary = `${offer.comicName} said yes to the ${show} ad hoc spot. Add them to the lineup?`;
  const pending = { ...confirmPending({ type: "adhoc_pick", showId: offer.showId, roundId: offer.round!.id, comicId: offer.comicId, comicName: offer.comicName }, summary, Date.now()), expiresAt: offer.expiresAt };
  await askCurator(uid, `🎤 ${summary}\nReply *yes* to add them (they get the confirmation), or pick in Updates.`, pending);
}

/** Tell someone who said yes that the spot is gone. */
async function tellFull(uid: string, client: WAWebJS.Client, offerRef: FirebaseFirestore.DocumentReference, offer: SpotOffer, reply: string | null, quiet: boolean) {
  const { settings } = watchUser(uid);
  await offerRef.update({ status: "full", ...(reply !== null && { reply }) });
  const who = (await col(uid, "comics").doc(offer.comicId).get()).data() as Comic | undefined;
  const name = await greetFor(client, who ?? { id: offer.comicId, name: offer.comicName });
  await sendRich(client, await chatOf(uid, offer.comicId), messageRich(settings, "offerFull"), { name }, null, { rewrite: (t) => inVoice(uid, "offerFull", t, { name }) });
  if (!quiet) await notice(uid, "info", `${offer.comicName} said yes, but the ${showName(uid, offer.showId)} spot was already filled. They've been told.`, "offer");
}

/**
 * Put one comic on a show's lineup as an ad hoc spot (in their history, never counted by the cooldown).
 * Returns the lineup, or null when the show is full (unless `overfill`) or called off.
 */
async function placeAdhoc(uid: string, show: Show | undefined, lineupId: string, comicId: string, overfill = false, flags: Pick<Slot, "notTold" | "noGroup"> = {}): Promise<Lineup | null> {
  const lineupRef = col(uid, "lineups").doc(lineupId);
  const comicRef = col(uid, "comics").doc(comicId);
  return db.runTransaction(async (tx) => {
    const lineup = (await tx.get(lineupRef)).data() as Lineup | undefined;
    if (!show || !lineup || lineup.status === "cancelled" || lineup.status === "canned") return null;
    if (lineup.slots.some((s) => s.comicId === comicId)) return lineup;
    if (!overfill && lineup.slots.length >= show.slotCount) return null;
    // Every read before any write: Firestore transactions refuse a get after a set/update.
    const reqRef = col(uid, "requests").doc(`${lineup.weekOf}_${comicId}`);
    const [comicSnap, reqSnap] = await Promise.all([tx.get(comicRef), tx.get(reqRef)]);
    const comic = comicSnap.data() as Comic | undefined;
    const req = reqSnap.data() as SpotRequest | undefined;
    const date = dateInWeek(lineup.weekOf, show.weekday);
    tx.update(lineupRef, { slots: [...lineup.slots, { comicId, minutes: show.includeSlotTime ? (show.defaultMinutes ?? null) : null, adhoc: true, ...(flags.notTold && { notTold: true }), ...(flags.noGroup && { noGroup: true }) }] });
    // Ad hoc: in their history, but never counted against them by the cooldown (no lastPerformedWeek).
    tx.set(comicRef, { history: withHistory(comic?.history, { date, showId: show.id, showName: show.name, status: "confirmed", adhoc: true }) }, { merge: true });
    if (req) tx.update(reqRef, { status: "confirmed", updatedAt: Date.now() });
    return lineup;
  });
}

/** After they're on the lineup: the confirmation, counted as told, and into the show's group when it's today. */
async function finishPlaced(uid: string, client: WAWebJS.Client, show: Show, lineupId: string, comicId: string, weekOf: string, status: Lineup["status"], opts: { confirm?: boolean; addToGroup?: boolean } = {}) {
  const { settings } = watchUser(uid);
  const lineupRef = col(uid, "lineups").doc(lineupId);
  const comic = (await col(uid, "comics").doc(comicId).get()).data() as Comic;
  const lineupBefore = (await lineupRef.get()).data() as Lineup;
  if (opts.confirm === false) {
    // Not told: on a confirmed lineup the record of what was sent must exist and leave them out, so Send updates still tells them.
    if (status === "confirmed" && !lineupBefore.sent) await lineupRef.update({ sent: sentSnapshot(lineupBefore.slots.filter((s) => s.comicId !== comicId), show, lineupBefore.sentAt ?? Date.now()) });
  } else {
    await sendConfirmation(uid, client, show, comic, weekOf);
    // Counted as told, so neither "Send updates" nor Confirm & send messages them a second time.
    const fresh = (await lineupRef.get()).data() as Lineup;
    await lineupRef.update({ sent: toldSent(fresh, show, comicId, Date.now()) });
  }
  // Show is today and its group is managed: add them now (ad hoc comics join the group like everyone else).
  if (opts.addToGroup !== false && show.groupId && localNow(new Date(), settings.timezone).date === dateInWeek(weekOf, show.weekday)) {
    const group = (await client.getChatById(show.groupId)) as WAWebJS.GroupChat;
    await group.addParticipants([comicId], { autoSendInviteV4: true, comment: renderMessage(settings, "groupWelcome", { show: show.name }) }).catch(() => undefined);
  }
}

/** Book an offer: slot (ad hoc), confirmation, group. Returns false when the show was full or called off (they're told). */
export async function bookOffer(uid: string, client: WAWebJS.Client, offerRef: FirebaseFirestore.DocumentReference, offer: SpotOffer, reply: string | null): Promise<boolean> {
  const { shows } = watchUser(uid);
  const show = shows.find((s) => s.id === offer.showId);
  const booked = await placeAdhoc(uid, show, offer.lineupId, offer.comicId, offer.overfill === true);

  if (!booked || !show) {
    await tellFull(uid, client, offerRef, offer, reply, true);
    await notice(uid, "warn", `${offer.comicName} said yes, but ${show?.name ?? "the show"} was already full. They've been told.`, "offer");
    return false;
  }

  await offerRef.update({ status: "accepted", ...(reply !== null && { reply }) });
  await finishPlaced(uid, client, show, offer.lineupId, offer.comicId, booked.weekOf, booked.status);
  await notice(uid, "info", `${offer.comicName} took the ${show.name} spot and got the confirmation.`, "offer");
  return true;
}

/**
 * "Already agreed": the curator adds comics straight onto the lineup, no offer and no waiting for a yes. Same placing,
 * confirmation message and group add as a booked offer. The cooldown never applies and a full show doesn't block it
 * (the sheet warns). Returns who was added and who was already on it.
 */
export async function addDirect(uid: string, client: WAWebJS.Client, lineupId: string, comicIds: string[], opts: { overfill?: boolean; confirm?: boolean; addToGroup?: boolean } = {}) {
  const { shows } = watchUser(uid);
  const lineup = (await col(uid, "lineups").doc(lineupId).get()).data() as Lineup | undefined;
  const show = shows.find((s) => s.id === lineup?.showId);
  if (!lineup || !show) throw new Error("Lineup not found");
  if (lineup.status === "cancelled" || lineup.status === "canned") throw new Error(`${show.name} is called off.`);
  const overfill = opts.overfill === true;
  const confirm = opts.confirm !== false;
  const addToGroup = opts.addToGroup !== false;
  const newOnes = comicIds.filter((id) => !lineup.slots.some((s) => s.comicId === id));
  // The slot count is a soft limit: going over needs an explicit yes (the app's "Add anyway").
  if (!overfill && lineup.slots.length + newOnes.length > show.slotCount) throw new Error(`${show.name} has ${show.slotCount} ${show.slotCount === 1 ? "spot" : "spots"} and ${lineup.slots.length} ${lineup.slots.length === 1 ? "is" : "are"} filled. Adding ${newOnes.length === 1 ? "them" : `${newOnes.length}`} goes over; confirm to add anyway.`);
  const added: string[] = [];
  const already: string[] = [];
  const names: string[] = [];
  for (const id of comicIds) {
    const comicRef = col(uid, "comics").doc(id);
    const comic = (await comicRef.get()).data() as Comic | undefined;
    if (!comic) continue;
    const placed = await placeAdhoc(uid, show, lineupId, id, true, { ...(confirm ? {} : { notTold: true }), ...(addToGroup ? {} : { noGroup: true }) });
    if (!placed) continue;
    if (placed.slots.some((s) => s.comicId === id)) {
      already.push(id);
      continue;
    }
    // A direct add replaces any offer still waiting on them.
    for (const d of (await col(uid, "offers").where("comicId", "==", id).where("status", "==", "pending").get()).docs) await d.ref.update({ status: "expired" });
    await finishPlaced(uid, client, show, lineupId, id, placed.weekOf, placed.status, { confirm, addToGroup });
    added.push(id);
    names.push(comic.name);
  }
  if (names.length) await notice(uid, "info", directNotice(names, show.name, { confirm, addToGroup }), "offer");
  return { added: added.length, already: already.length, ids: added };
}

/**
 * The curator picked from an ad hoc round's yeses (Updates or the agent). The picked are booked in order while slots last.
 * close: everyone else who said yes is told it's filled. Offers nobody answered stay open; a later yes is told it's filled
 * once the round's slots are taken.
 */
export async function settleRound(uid: string, client: WAWebJS.Client, roundId: string, pick: string[], close: boolean) {
  const round = await roundOffers(uid, roundId);
  if (!round.length) throw new Error("That ad hoc request isn't there any more.");
  const picked = new Set(pick);
  let booked = 0;
  for (const o of round) {
    if (!picked.has(o.comicId) || (o.status !== "interested" && o.status !== "pending")) continue;
    if (await bookOffer(uid, client, o.ref, o, null)) booked++;
  }
  const after = await roundOffers(uid, roundId);
  const filled = after.filter((o) => o.status === "accepted").length >= (after[0].round?.slots ?? 1);
  if (close || filled) for (const o of after.filter((x) => x.status === "interested")) await tellFull(uid, client, o.ref, o, null, true);
  return { booked };
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
  if (!doc) return handleOfferVote(uid, client, vote, msgId);
  const poll = doc.data() as HostPoll;
  let voter = vote.voter;
  if (voter.endsWith("@lid")) voter = (await client.getContactLidAndPhone([voter]).catch(() => []))[0]?.pn ?? voter;
  const contact = await client.getContactById(vote.voter).catch(() => null);
  const name = (contact?.isMyContact && contact.name) || contact?.pushname || `+${voter.split("@")[0]}`;
  const showIds = vote.selectedOptions.map((o) => poll.options.find((x) => x.name === o.name)?.showId).filter(Boolean) as string[];
  await doc.ref.update({ [`votes.${voter.replace(/\./g, "_")}`]: showIds, [`voterNames.${voter.replace(/\./g, "_")}`]: name });
}

/** A vote on a spot-offer poll: the first option books the spot, the second passes. Taking a vote back does nothing. */
async function handleOfferVote(uid: string, client: WAWebJS.Client, vote: WAWebJS.PollVote, msgId: string) {
  const snap = await col(uid, "offers").where("pollMessageId", "==", msgId).where("status", "==", "pending").limit(1).get();
  const doc = snap.docs[0];
  if (!doc) return;
  const offer = { ...(doc.data() as SpotOffer), id: doc.id };
  if (offer.expiresAt < Date.now()) return void (await doc.ref.update({ status: "expired" }));
  const picked = vote.selectedOptions.map((o) => o.name);
  const answer = offerVote(picked, offer.pollOptions ?? OFFER_POLL_OPTIONS);
  if (answer === null) return;
  await settleOffer(uid, client, doc.ref, offer, answer, `Poll: ${picked.join(", ")}`.slice(0, 300));
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

/**
 * A fixed time after a confirmed show STARTS (default 2 hours, micCheck.afterHours): ask. The app's "Did it happen?" card comes from
 * the lineup itself (confirmed, due, no outcome), so it exists whether or not any WhatsApp is up and stays a pending update until
 * answered; this marks it asked and also asks on the agent number (or, failing that, in the curator's own chat). Runs without the
 * main WhatsApp too, so the agent still asks when only it is linked.
 */
export async function sendMicChecks(uid: string, client: WAWebJS.Client | undefined) {
  const { settings, shows } = watchUser(uid);
  if (!settings.micCheck.enabled) return;
  const now = localNow(new Date(), settings.timezone);
  const hours = micDelayHours(settings.micCheck);
  const snap = await col(uid, "lineups").where("status", "==", "confirmed").get();
  for (const d of snap.docs) {
    const l = d.data() as Lineup;
    const show = shows.find((s) => s.id === l.showId);
    if (l.micCheckSentOn || !micCheckDue(l, show, now, hours)) continue;
    await d.ref.update({ micCheckSentOn: now.date });
    // With the agent number linked (and its notices on), it asks you there and reads your yes/no; no "Message yourself" chat.
    if (await sendMicCheck(uid, `🎤 Did *${show?.name ?? "the show"}* on ${formatDate(l.date)} happen? Reply *yes* or *no* here.`)) continue;
    if (!settings.micCheck.whatsapp) continue;
    const self = client?.info?.wid?._serialized;
    if (!client || !self) continue;
    await sendQueued(client, self, `🎤 Did *${show?.name ?? "the show"}* on ${formatDate(l.date)} happen? Reply *yes* or *no* here.`);
  }
}

export async function expireOffers(uid: string) {
  const snap = await col(uid, "offers").where("status", "==", "pending").get();
  for (const d of snap.docs) {
    const o = d.data() as SpotOffer;
    if (o.expiresAt > Date.now()) continue;
    await d.ref.update({ status: "expired" });
    await notice(uid, "info", `No reply from ${o.comicName} about the ${showName(uid, o.showId)} spot. The offer expired.`, "offer");
  }
}

function showName(uid: string, showId: string) {
  return watchUser(uid).shows.find((s) => s.id === showId)?.name ?? "show";
}

async function chatOf(uid: string, comicId: string) {
  return ((await col(uid, "comics").doc(comicId).get()).data() as Comic | undefined)?.chatId ?? comicId;
}


/**
 * Once per start: ad hoc comics who accepted an offer (the offer and the "you're in" reply told them) before the lineup recorded
 * that get their "sent" entry, so Confirm & send / Send updates never messages them a second time. Idempotent.
 */
export async function markAdhocTold(uid: string) {
  const { shows } = watchUser(uid);
  const accepted = await col(uid, "offers").where("status", "==", "accepted").get();
  const byLineup = new Map<string, Set<string>>();
  for (const d of accepted.docs) {
    const o = d.data() as SpotOffer;
    byLineup.set(o.lineupId, (byLineup.get(o.lineupId) ?? new Set()).add(o.comicId));
  }
  let fixed = 0;
  for (const [lineupId, ids] of byLineup) {
    const ref = col(uid, "lineups").doc(lineupId);
    const lineup = (await ref.get()).data() as Lineup | undefined;
    const show = shows.find((s) => s.id === lineup?.showId);
    if (!lineup || !show) continue;
    const sent = adhocToldPatch(lineup, show, ids, Date.now());
    if (!sent) continue;
    await ref.update({ sent });
    fixed++;
  }
  if (fixed) console.log(`[adhoc] ${uid}: recorded ${fixed} lineup(s) of told ad hoc comics`);
}
