// The web app never talks to the worker directly. It writes users/{uid}/commands/{id}
// docs; we pick up pending ones, run them, and write the result back.
import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import WAWebJS from "whatsapp-web.js";
import {
  DAY_NAMES,
  dateInWeek,
  cancelledPatch,
  diffGroup,
  diffLineup,
  formatDate,
  formatTime,
  groupModeOf,
  lineupId,
  pendingRejections,
  localNow,
  confirmSkipReason,
  renderMessage,
  renderRich,
  groupPostVars,
  messageRich,
  renderTemplate,
  normalizeMessage,
  pollProblem,
  OFFER_POLL_OPTIONS,
  type RichMessage,
  TTL_DAYS,
  resendCandidates,
  sentSnapshot,
  settleSent,
  waitingStatus,
  withHistory,
  type Command,
  type ComicAction,
  type HostPoll,
  type SpotOffer,
  type Comic,
  type GroupSyncPlan,
  type Lineup,
  type NoticeKind,
  type Show,
  type SpotRequest,
} from "@spot/shared";
import { col, db, expireAt, userRef } from "./firebase.ts";
import { sessions } from "./sessions.ts";
import { agentSessions } from "./agentSession.ts";
import { curatorPhone, forgetSettings, resolvedInApp, sendToCurator } from "./agentOutbox.ts";
import { fleet } from "./fleet.ts";
import { watchUser } from "./userData.ts";
import { listContacts, listGroupMembers, pullGroupMembers } from "./people.ts";
import { deliverableId, enqueueTask, sendQueued } from "./sendQueue.ts";
import { sendRich } from "./sendRich.ts";
import { deliverDraft } from "./deliver.ts";
import { greetFor } from "./greet.ts";
import { inVoice, learnVoice, listVoiceSourceChats, previewVoice } from "./voice.ts";
import { applyFollowUpAction } from "./followUp.ts";
import { generateJson, generateJsonFromFile, listGeminiModels, ollamaPull, ollamaState, testRoute } from "./llm.ts";
import { parseRoster, type ParseRosterInput } from "./rosterImport.ts";
import { safeFetch } from "./safeFetch.ts";
import { reclassifyRequests } from "./reclassify.ts";
import { scanHistory } from "./scanHistory.ts";
import { applyReconcile, reconcileWaiting } from "./reconcile.ts";
import { getMedia, getThread, listThreads, summarizeThread } from "./chats.ts";
import { clearGroup, keepGroup } from "./groupCleanup.ts";
import { addDirect, settleRound } from "./replies.ts";
import { askForSpot } from "./groupWatch.ts";
import { sendAsk } from "./asks.ts";

type Handler = (uid: string, payload: Record<string, unknown>, commandId?: string) => Promise<unknown>;

/** A past show recorded afterwards (backfill) is history only: nothing is ever sent, synced or offered for it. */
export function assertNotBackfilled(l: { backfilled?: boolean } | undefined) {
  if (l?.backfilled) throw new Error("That past show is only recorded. Nobody is messaged for it.");
}

const handlers: Record<Command["type"], Handler> = {
  async connect(uid) {
    await userRef(uid).set({ waEnabled: true }, { merge: true });
    void sessions.start(uid);
  },

  async logout(uid) {
    await sessions.logout(uid);
  },

  /**
   * Link the agent number (a second WhatsApp that talks only to you). The QR shows in users/{uid}/session/agent. It starts on
   * this server because this server holds the account; if the account moves, the agent moves with it (docs/agent.md).
   */
  async connect_agent(uid) {
    sessions.require(uid); // the agent talks to your number, so your own WhatsApp has to be linked first
    await userRef(uid).set({ agentEnabled: true }, { merge: true });
    void agentSessions.start(uid);
  },

  /** Unlink the agent number. Your own WhatsApp stays as it is. */
  async logout_agent(uid) {
    await agentSessions.logout(uid);
    forgetSettings(uid);
  },

  /** "Send me a hello from the agent": the one message that proves the link works. */
  async test_agent(uid) {
    if (!agentSessions.get(uid)) throw new Error("The agent number isn't connected yet");
    if (!(await curatorPhone(uid))) throw new Error("Your own WhatsApp isn't linked, so the agent doesn't know your number");
    const ok = await sendToCurator(uid, "Hello from your Nothing BOT Curate agent. I'm linked and I only talk to you. Send *help* to see what I can do.", { ignoreSwitch: true });
    if (!ok) throw new Error("Couldn't send: the agent hit its hourly limit, try again later");
  },

  // Runs on the current holder, or on the target when nobody holds the account (see fleet.gate).
  async move_account(uid, { to }) {
    return fleet.requestMove(uid, String(to ?? ""));
  },

  async list_groups(uid) {
    const client = sessions.require(uid);
    const me = client.info.wid._serialized;
    const groups = (await client.getChats()).filter((c) => c.isGroup) as WAWebJS.GroupChat[];
    const ref = col(uid, "groups");
    const batch = db.batch();
    (await ref.get()).docs.forEach((d) => batch.delete(d.ref));
    for (const g of groups) {
      const self = g.participants.find((p) => p.id._serialized === me || p.id.user === client.info.wid.user);
      batch.set(ref.doc(g.id._serialized), {
        id: g.id._serialized,
        name: g.name,
        participants: g.participants.length,
        isAdmin: Boolean(self?.isAdmin || self?.isSuperAdmin),
      });
    }
    await batch.commit();
    return { count: groups.length };
  },

  async send_confirmations(uid, { lineupId }) {
    const client = sessions.require(uid);
    const { settings, shows } = watchUser(uid);
    const lineupRef = col(uid, "lineups").doc(String(lineupId));
    const lineup = (await lineupRef.get()).data() as Lineup | undefined;
    if (!lineup) throw new Error("Lineup not found");
    assertNotBackfilled(lineup);
    const show = shows.find((s) => s.id === lineup.showId);
    if (!show) throw new Error("Show not found");
    const comics = await loadComics(uid, lineup.slots.map((s) => s.comicId));

    const results: Record<string, string> = {};
    // Comics the curator already told by hand ("Check what I've done") are recorded in `sent`: don't message them twice.
    // People already in the show's group already have the spot: don't message them either.
    const fresh = (await col(uid, "shows").doc(show.id).get()).data() as Show | undefined;
    for (const slot of lineup.slots) {
      const comic = comics.get(slot.comicId);
      if (!comic) continue;
      // You can be on your own lineup; you never get your own confirmation.
      const isMe = isSelf(client, comic);
      const skip = isMe ? "told" : confirmSkipReason(comic, lineup, { groupId: show.groupId, groupMembers: fresh?.groupMembers ?? show.groupMembers });
      if (skip) {
        results[comic.id] = skip === "told" ? "sent (already told)" : "sent (already in the group)";
        continue;
      }
      try {
        await sendConfirmation(uid, client, show, comic, lineup.weekOf, slot.minutes);
        results[comic.id] = "sent";
      } catch (e) {
        results[comic.id] = `failed: ${(e as Error).message}`;
      }
    }

    const batch = db.batch();
    const date = dateInWeek(lineup.weekOf, show.weekday);
    for (const slot of lineup.slots) {
      if (!results[slot.comicId]?.startsWith("sent")) continue;
      const history = withHistory(comics.get(slot.comicId)?.history, { date, showId: show.id, showName: show.name, status: "confirmed", ...(slot.adhoc && { adhoc: true }) });
      // Ad hoc spots stay in history but never count as "performed" for the cooldown.
      batch.set(col(uid, "comics").doc(slot.comicId), { ...(!slot.adhoc && { lastPerformedWeek: lineup.weekOf }), history }, { merge: true });
      batch.set(col(uid, "requests").doc(`${lineup.weekOf}_${slot.comicId}`), { status: "confirmed", updatedAt: Date.now() }, { merge: true });
    }
    // Remember what each comic was told, so edits after confirming can be reviewed against it.
    const sentAt = Date.now();
    const told = lineup.slots.filter((s) => results[s.comicId]?.startsWith("sent"));
    batch.update(lineupRef, { status: "confirmed", sentAt, sent: sentSnapshot(told, show, sentAt, lineup.sent) });
    await batch.commit();

    // "Review when I confirm" shows open the group review now; manual and show-day ones wait for the curator or the day.
    if (show.groupId && groupModeOf(show) === "confirm") await handlers.plan_group_sync(uid, { lineupId }).catch((e) => console.error("[group] plan failed", e));
    // Last show of the week locked in → everyone still waiting gets a regret.
    if (settings.reject.enabled && (await weekIsFinal(uid, lineup.weekOf, shows))) {
      await handlers.send_rejections(uid, { weekOf: lineup.weekOf });
    }
    return results;
  },

  async send_rejections(uid, { weekOf, onlyIfFinal }) {
    const client = sessions.require(uid);
    const { settings, shows } = watchUser(uid);
    const week = String(weekOf);
    if (onlyIfFinal && !(await weekIsFinal(uid, week, shows))) throw new Error("Some shows this week aren't confirmed yet");
    const [reqSnap, lineupSnap] = await Promise.all([
      col(uid, "requests").where("weekOf", "==", week).get(),
      col(uid, "lineups").where("weekOf", "==", week).get(),
    ]);
    const placed = new Set(lineupSnap.docs.flatMap((d) => (d.data() as Lineup).slots.map((s) => s.comicId)));
    const targets = pendingRejections(reqSnap.docs.map((d) => d.data() as SpotRequest), placed);
    const comics = await loadComics(uid, targets.map((r) => r.comicId));
    let sent = 0;
    for (const r of targets) {
      const comic = comics.get(r.comicId);
      try {
        const name = await greetFor(client, comic ?? { id: r.comicId, name: r.comicName });
        await sendQueued(client, comics.get(r.comicId)?.chatId ?? r.comicId, await inVoice(uid, "reject", renderTemplate(settings.reject.template, { name }), { name }));
        await col(uid, "requests").doc(r.id).update({ status: "rejected", rejectedAt: Date.now(), updatedAt: Date.now() });
        sent++;
      } catch (e) {
        console.error(`[reject] ${r.comicId} failed`, e);
      }
    }
    return { sent, total: targets.length };
  },

  async plan_group_sync(uid, { lineupId }) {
    const client = sessions.require(uid);
    const { shows } = watchUser(uid);
    const lineupRef = col(uid, "lineups").doc(String(lineupId));
    const lineup = (await lineupRef.get()).data() as Lineup;
    assertNotBackfilled(lineup);
    const show = shows.find((s) => s.id === lineup.showId) as Show;
    if (!show.groupId) throw new Error("No WhatsApp group linked to this show");
    await lineupRef.update({ groupSync: { status: "computing", toAdd: [], toRemove: [], kept: [] } });

    const group = (await client.getChatById(show.groupId)) as WAWebJS.GroupChat;
    const participants = await normaliseParticipants(client, group);
    const resolved = participants.filter((p) => p.id.endsWith("@c.us"));
    const unresolved = participants.filter((p) => !p.id.endsWith("@c.us")).map((p) => p.id);

    const { toAdd, toRemove, kept } = diffGroup({
      participants: resolved,
      confirmed: lineup.slots.map((s) => s.comicId),
      regulars: show.regulars ?? [],
      protected: [...(show.protected ?? []), ...(show.pocs ?? [])],
      self: `${client.info.wid.user}@c.us`,
      forceRemove: lineup.groupLeaving ?? [],
    });
    // Anyone we couldn't map to a phone number is kept — never remove what we can't identify.
    const plan: GroupSyncPlan = { status: "pending", toAdd, toRemove, kept: [...kept, ...unresolved] };
    await lineupRef.update({ groupSync: plan });
    return plan;
  },

  async sync_group(uid, { lineupId, exclude }) {
    const client = sessions.require(uid);
    const { shows, settings } = watchUser(uid);
    const lineupRef = col(uid, "lineups").doc(String(lineupId));
    const lineup = (await lineupRef.get()).data() as Lineup;
    assertNotBackfilled(lineup);
    const plan = lineup.groupSync;
    if (!plan || plan.status !== "pending") throw new Error("No pending group sync to apply");
    const show = shows.find((s) => s.id === lineup.showId) as Show;
    const skip = new Set((exclude as string[] | undefined) ?? []);
    await lineupRef.update({ "groupSync.status": "applying" });

    const group = (await client.getChatById(show.groupId!)) as WAWebJS.GroupChat;
    const results: GroupSyncPlan["results"] = {};
    const lidOf = await lidMap(client, group);

    for (const id of plan.toAdd.filter((id) => !skip.has(id))) {
      await enqueueTask(client, async () => {
        const r = await group.addParticipants([id], { autoSendInviteV4: true, comment: renderMessage(settings, "groupWelcome", { show: show.name }) });
        // Runtime shape is { [id]: { code, message, isInviteV4Sent } } (the bundled typings nest it one level too deep).
        const res = typeof r === "string" ? null : (Object.values(r)[0] as unknown as { code: number; isInviteV4Sent: boolean });
        results[id] = res?.code === 200 ? "added" : res?.isInviteV4Sent ? "invited" : "failed";
      });
    }
    for (const id of plan.toRemove.filter((id) => !skip.has(id))) {
      await enqueueTask(client, async () => {
        try {
          await group.removeParticipants([lidOf.get(id) ?? id]);
          results[id] = "removed";
        } catch {
          results[id] = "failed";
        }
      });
    }
    await lineupRef.update({ "groupSync.status": "done", "groupSync.results": results, groupLeaving: null });
    // The cached member list on the show should match the group again.
    await listGroupMembers(uid, { showId: show.id }).catch((e) => console.error("[group] member refresh failed", e));
    return results;
  },

  /**
   * Send what changed on a confirmed lineup since the comics were last told. The diff is computed here from
   * lineup.sent, so the lists in `notify` can only narrow it: added get the confirmation, removed get the cancellation,
   * moved or retimed get the confirmation again if `resend` names them. People not named are settled without a message.
   */
  async send_lineup_updates(uid, { lineupId, notify }) {
    const client = sessions.require(uid);
    const { shows } = watchUser(uid);
    const lineupRef = col(uid, "lineups").doc(String(lineupId));
    const lineup = (await lineupRef.get()).data() as Lineup | undefined;
    if (!lineup) throw new Error("Lineup not found");
    assertNotBackfilled(lineup);
    if (lineup.status !== "confirmed") throw new Error("This lineup isn't confirmed yet. Confirm it first.");
    if (!lineup.sent) throw new Error("There's no record of what was sent, so there's nothing to compare. Nothing was sent.");
    const show = shows.find((s) => s.id === lineup.showId);
    if (!show) throw new Error("Show not found");
    const changes = diffLineup(lineup.slots, lineup.sent, show);
    if (!changes.total) throw new Error("Nothing has changed since the last send");
    const want = (notify ?? {}) as { add?: string[]; remove?: string[]; resend?: string[] };
    const only = (ids: string[] | undefined, allowed: string[]) => new Set((ids ?? []).filter((id) => allowed.includes(id)));
    const toAdd = only(want.add, changes.added);
    const toRemove = only(want.remove, changes.removed);
    const toResend = only(want.resend, resendCandidates(changes));

    const comics = await loadComics(uid, [...changes.added, ...changes.removed, ...resendCandidates(changes)]);
    const date = dateInWeek(lineup.weekOf, show.weekday);
    const messaged: string[] = [];
    const failed: string[] = [];
    const send = async (id: string, deliver: (c: Comic) => Promise<unknown>) => {
      const comic = comics.get(id);
      try {
        if (!comic) throw new Error("Comic not found");
        if (isSelf(client, comic)) return void messaged.push(id); // you: counts as told, no message to yourself
        await deliver(comic);
        messaged.push(id);
      } catch (e) {
        console.error(`[lineup-update] ${id} failed`, e);
        failed.push(id);
      }
    };
    for (const slot of lineup.slots) {
      if (toAdd.has(slot.comicId) || toResend.has(slot.comicId)) await send(slot.comicId, (c) => sendConfirmation(uid, client, show, c, lineup.weekOf, slot.minutes));
    }
    for (const id of changes.removed) if (toRemove.has(id)) await send(id, async (c) => sendQueued(client, c.chatId ?? c.id, await cancelBody(uid, client, show, c, lineup.weekOf)));

    // Settle the records: people who were told are done. Failed sends, and adds or removals the curator
    // unticked, stay pending, so nobody ends up on (or off) a lineup without knowing.
    const now = Date.now();
    const unticked = [...changes.added.filter((id) => !toAdd.has(id)), ...changes.removed.filter((id) => !toRemove.has(id))];
    const bad = new Set([...failed, ...unticked]);
    const weekLineups = (await col(uid, "lineups").where("weekOf", "==", lineup.weekOf).get()).docs.map((d) => d.data() as Lineup);
    const elsewhere = (id: string) => weekLineups.some((l) => l.id !== lineup.id && l.status !== "cancelled" && l.status !== "canned" && l.slots.some((s) => s.comicId === id));
    const batch = db.batch();
    for (const id of changes.added) {
      if (bad.has(id)) continue;
      const adhoc = Boolean(lineup.slots.find((x) => x.comicId === id)?.adhoc);
      const history = withHistory(comics.get(id)?.history, { date, showId: show.id, showName: show.name, status: "confirmed", ...(adhoc && { adhoc: true }) });
      batch.set(col(uid, "comics").doc(id), { ...(!adhoc && { lastPerformedWeek: lineup.weekOf }), history }, { merge: true });
      batch.set(col(uid, "requests").doc(`${lineup.weekOf}_${id}`), { status: "confirmed", updatedAt: now }, { merge: true });
    }
    for (const id of changes.removed) {
      if (bad.has(id)) continue;
      const other = elsewhere(id);
      batch.set(col(uid, "comics").doc(id), cancelledPatch(comics.get(id), lineup, show, other), { merge: true });
      const reqRef = col(uid, "requests").doc(`${lineup.weekOf}_${id}`);
      const req = (await reqRef.get()).data() as SpotRequest | undefined;
      // Back to waiting, unless they moved to another show this week (that show's own send settles them).
      if (req && !other && req.status === "confirmed") batch.set(reqRef, { status: waitingStatus(req), updatedAt: now }, { merge: true });
    }
    batch.update(lineupRef, { sent: settleSent(lineup.slots, show, lineup.sent, now, { messaged, failed: [...bad] }) });
    await batch.commit();

    if (show.groupId && groupModeOf(show) === "confirm") await handlers.plan_group_sync(uid, { lineupId }).catch((e) => console.error("[group] plan failed", e));
    return { sent: messaged.length, failed: failed.map((id) => comics.get(id)?.name ?? id) };
  },

  /** Curator approved a drafted reply (and for cancellations, the drop-out itself). */
  async send_action(uid, { actionId, body, rich }) {
    const client = sessions.require(uid);
    const ref = col(uid, "actions").doc(String(actionId));
    const action = (await ref.get()).data() as ComicAction | undefined;
    if (!action || action.status !== "pending") throw new Error("Nothing to send");
    if (action.kind === "cancel_spot" && action.lineupId) await dropFromLineup(uid, client, action.comicId, action.lineupId);
    const comic = (await col(uid, "comics").doc(action.comicId).get()).data() as Comic | undefined;
    await deliverDraft(uid, client, comic?.chatId ?? action.comicId, String(body ?? action.draft), (rich as ComicAction["rich"] | undefined) ?? action.rich);
    // Their next message is read as the answer to the onboarding question.
    if (action.kind === "onboard") await col(uid, "comics").doc(action.comicId).set({ onboarding: "asked" }, { merge: true });
    await ref.update({ status: "sent", sentAt: Date.now() });
  },

  /**
   * Curator offers an open slot. By default a poll ("Yes, I'll take it" / "Pass"): voting is handled in replies.ts
   * (handleVote), and a typed yes or no is still understood (handleOfferReply). `rich` carries what the curator
   * edited in the sheet; without it the offer goes out as the text in `body`.
   */
  /**
   * Offer open slot(s) to one comic (comicId, message already filled in) or to several at once (comicIds, the template:
   * {{name}} is filled per comic). Several make one ad hoc round that fills `slots`; autoAdd books the first yeses.
   */
  async send_offer(uid, { comicId, comicIds, lineupId, body, rich, slots, autoAdd, direct }) {
    const client = sessions.require(uid);
    const { settings, shows, venues } = watchUser(uid);
    const lineup = (await col(uid, "lineups").doc(String(lineupId)).get()).data() as Lineup | undefined;
    if (!lineup) throw new Error("Lineup not found");
    assertNotBackfilled(lineup);
    const show = shows.find((s) => s.id === lineup.showId);
    if (!show) throw new Error("Show not found");
    const ids = [...new Set((Array.isArray(comicIds) ? comicIds : [comicId]).map(String).filter(Boolean))];
    if (!ids.length) throw new Error("Pick someone to offer the spot to.");
    // Already agreed: no offer, no waiting for a yes. They go straight on the lineup, get the confirmation and join the group.
    if (direct === true) return addDirect(uid, client, String(lineupId), ids);
    const open = show.slotCount - lineup.slots.length;
    if (open <= 0) throw new Error(`${show.name} is full.`);
    const comics = await loadComics(uid, ids);

    const asPoll = rich ? normalizeMessage(rich).kind === "poll" : false;
    const msg: RichMessage = rich ? normalizeMessage(rich, { kind: "text", body: String(body ?? "") }) : { kind: "text", body: String(body ?? "") };
    let pollOptions: string[] | undefined;
    if (asPoll && msg.poll) {
      // The first option books the spot and the second passes, so those two are fixed.
      pollOptions = [...OFFER_POLL_OPTIONS];
      msg.poll = { question: msg.poll.question, options: pollOptions, multi: false };
      const problem = pollProblem(msg.poll);
      if (problem) throw new Error(problem);
    } else if (msg.kind !== "text") throw new Error("An offer goes out as a poll or as text.");

    const now = Date.now();
    const round = { id: `r${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, size: ids.length, slots: Math.max(1, Math.min(open, Number(slots) || 1, ids.length)), autoAdd: ids.length === 1 ? true : autoAdd !== false };
    let sentCount = 0;
    for (const id of ids) {
      const comic = comics.get(id);
      if (!comic) continue;
      // One live offer per comic: the newest replaces any older one.
      const old = await col(uid, "offers").where("comicId", "==", id).where("status", "==", "pending").get();
      for (const d of old.docs) await d.ref.update({ status: "expired" });
      // One comic: the curator's text as typed. Several: the template, filled in for each.
      const out = ids.length === 1 ? msg : renderRich(msg, { name: await greetFor(client, comic) });
      const sent = await sendRich(client, comic.chatId ?? comic.id, out, {}, venues.find((v) => v.id === show.venueId), { prerendered: true });
      const offer: Omit<SpotOffer, "id"> = {
        comicId: id,
        comicName: comic.name,
        weekOf: lineup.weekOf,
        showId: show.id,
        lineupId: String(lineupId),
        status: "pending",
        sentAt: now,
        expiresAt: now + settings.offers.expiryHours * 3600_000,
        reply: null,
        round,
        ...(pollOptions && sent && { pollMessageId: sent.id._serialized, pollOptions }),
      };
      await col(uid, "offers").add(offer);
      sentCount++;
    }
    return { sent: sentCount, roundId: round.id };
  },

  /** Pick from an ad hoc round's yeses (Updates). close: tell the rest it's filled. */
  async settle_round(uid, { roundId, pick, close }) {
    const r = await settleRound(uid, sessions.require(uid), String(roundId), Array.isArray(pick) ? pick.map(String) : [], close !== false);
    // Answered here: the agent must stop waiting on its "add them?" for this round.
    await resolvedInApp(uid, (p) => p.type === "adhoc_pick" && p.roundId === String(roundId));
    return r;
  },

  /** WhatsApp poll to the hosts group: which of this week's shows can you take? */
  async send_host_poll(uid, { weekOf }) {
    const client = sessions.require(uid);
    const { settings, shows } = watchUser(uid);
    const groupId = settings.hostPoll.groupId;
    if (!groupId) throw new Error("Pick a hosts group in Settings first");
    const week = String(weekOf);
    const active = shows.filter((s) => s.active);
    if (!active.length) throw new Error("No active shows");
    const options = active.map((s) => ({ showId: s.id, name: `${DAY_NAMES[s.weekday].slice(0, 3)} ${formatDate(dateInWeek(week, s.weekday))} · ${s.name}`.slice(0, 100) }));
    const poll = new WAWebJS.Poll(`Hosts: which shows can you take for the week of ${formatDate(week)}?`, options.map((o) => o.name), { allowMultipleAnswers: true, messageSecret: undefined });
    const msg = await enqueueTask(client, () => client.sendMessage(groupId, poll));
    const doc: HostPoll = { id: week, weekOf: week, groupId, messageId: msg.id._serialized, options, votes: {}, voterNames: {}, sentAt: Date.now() };
    await col(uid, "polls").doc(week).set(doc);
  },

  /** Models available on this server's Ollama. */
  async list_models() {
    return ollamaState();
  },

  /** Refresh the curator's Gemini model list with their stored key. */
  async list_gemini_models(uid) {
    const models = await listGeminiModels(uid);
    await userRef(uid).set({ aiModels: { gemini: models, fetchedAt: Date.now() } }, { merge: true });
    return { count: models.length };
  },

  /** Try a provider/model end to end with the curator's key. */
  async test_ai(uid, { provider, model }) {
    return testRoute(uid, { provider: provider as "ollama" | "gemini", model: String(model) });
  },

  /** Download an Ollama model onto the server. */
  async pull_model(_uid, { model }) {
    if (!/^[\w.:\/-]{1,80}$/.test(String(model))) throw new Error("Invalid model name");
    await ollamaPull(String(model));
    return ollamaState();
  },

  pull_group_members: pullGroupMembers,
  list_group_members: listGroupMembers,
  list_contacts: listContacts,
  reclassify_requests: reclassifyRequests,
  scan_history: scanHistory,
  reconcile_waiting: reconcileWaiting,
  apply_reconcile: applyReconcile,
  learn_voice: learnVoice,
  apply_follow_up: (uid, { actionId }) => applyFollowUpAction(uid, sessions.require(uid), String(actionId)),
  preview_voice: previewVoice,

  /**
   * What WhatsApp actually renders from this account: one sample of each rich message type, sent ONLY to the
   * curator's own chat ("Message yourself"). Buttons and lists are deprecated by WhatsApp for non-API accounts;
   * this shows whether they arrive at all. Returns which sends WhatsApp accepted.
   */
  async send_format_samples(uid) {
    const client = sessions.require(uid);
    const self = client.info?.wid?._serialized;
    if (!self) throw new Error("WhatsApp isn't ready");
    const out: Record<string, string> = {};
    const tryOne = async (name: string, content: string | WAWebJS.Poll | WAWebJS.Location | WAWebJS.Buttons | WAWebJS.List, opts?: WAWebJS.MessageSendOptions) => {
      try {
        const m = await enqueueTask(client, () => client.sendMessage(self, content, opts));
        out[name] = m ? "sent" : "refused";
      } catch (e) {
        out[name] = `failed: ${(e as Error).message.slice(0, 120)}`;
      }
    };
    await tryOne("text", "🧪 Nothing BOT Curate format test (only you see this)\n\n*bold* _italic_ ~strike~ ```mono```\n> a quote\n* a bullet\n1. a numbered line\n`inline code`");
    await tryOne("poll", new WAWebJS.Poll("🧪 Poll test: want the Monday 8:30 PM spot?", ["Yes, I'll take it", "Pass"], { allowMultipleAnswers: false, messageSecret: undefined }));
    await tryOne("location", new WAWebJS.Location(12.9784, 77.6408, { name: "Test venue pin", address: "Indiranagar, Bengaluru" }));
    await tryOne("buttons", new WAWebJS.Buttons("🧪 Buttons test: do you see two buttons below?", [{ body: "Yes" }, { body: "No" }], "Buttons", "Deprecated by WhatsApp"));
    await tryOne("list", new WAWebJS.List("🧪 List test: do you see a menu?", "Open menu", [{ title: "Shows", rows: [{ title: "Monday Mic" }, { title: "Tuesday Mic" }] }], "List"));
    console.log(`[format-test] ${uid}`, out);
    return out;
  },

  /**
   * A message to one chat. `voice` (Messages page): write the text in the curator's voice first. The rewrite is checked against
   * the typed text and falls back to it, so it can only change the wording. Returns what actually went out.
   */
  async send_message(uid, { to, body, rich, voice, name, tags }) {
    const r = rich as ComicAction["rich"] | undefined;
    const client = sessions.require(uid);
    let text = String(body ?? "");
    if (voice && text.trim() && (r?.kind ?? "text") === "text") text = await inVoice(uid, "reply", text, { name: String(name ?? "there") });
    // "@Amrit" typed in a group becomes a real tag: WhatsApp needs "@<their id>" in the text and the id in mentions. A tag can be
    // anyone in the group: `comicId` is a roster id, a member's phone id or their @lid. Longer names go first so "@Ravi Kumar"
    // isn't eaten by "@Ravi".
    const mentions: string[] = [];
    if (String(to).endsWith("@g.us") && Array.isArray(tags)) {
      const wanted = (tags as { label: string; comicId: string }[]).filter((t) => t?.label && t.comicId).sort((a, b) => b.label.length - a.label.length);
      const comics = await loadComics(uid, [...new Set(wanted.map((t) => String(t.comicId)))]);
      for (const t of wanted) {
        if (!text.includes(t.label)) continue;
        const id = await deliverableId(client, comics.get(t.comicId)?.chatId ?? t.comicId);
        text = text.split(t.label).join(`@${id.split("@")[0]}`);
        if (!mentions.includes(id)) mentions.push(id);
      }
    }
    await deliverDraft(uid, client, String(to), text, r, mentions);
    return { body: text };
  },

  /** Nothing BOT Comedy: send one drafted ask to a room's curator (asks/{askId}). In the comic's voice when the ask says so. */
  /** Comic app: DM the contact of a group spot alert ("Ask for it"). */
  ask_for_spot: (uid, payload) => askForSpot(uid, payload),

  async send_ask(uid, { askId }) {
    if (!askId) throw new Error("Pick an ask to send.");
    return sendAsk(uid, String(askId));
  },

  /** The curator's answer to "clear the group?" (Updates), or a clear-now. keep: leave everyone in. */
  async cleanup_group(uid, { lineupId, keep }) {
    const ref = col(uid, "lineups").doc(String(lineupId));
    const lineup = (await ref.get()).data() as Lineup | undefined;
    if (!lineup) throw new Error("That lineup isn't there any more.");
    assertNotBackfilled(lineup);
    const answered = () => resolvedInApp(uid, (p) => p.type === "cleanup" && p.lineupId === String(lineupId));
    if (lineup.cleanup?.status === "done") {
      await answered();
      return { already: true };
    }
    // "Retry now" on a cleanup that left people behind: another pass at once, no new thank-you.
    if (lineup.cleanup?.status === "partial") {
      const show = watchUser(uid).shows.find((s) => s.id === lineup.showId);
      if (!show?.groupId) throw new Error("This show has no WhatsApp group linked.");
      return clearGroup(uid, sessions.require(uid), show, { ...lineup, id: String(lineupId) }, { retry: true });
    }
    if (keep) {
      await keepGroup(uid, String(lineupId));
      return void (await answered());
    }
    const show = watchUser(uid).shows.find((s) => s.id === lineup.showId);
    if (!show?.groupId) throw new Error("This show has no WhatsApp group linked.");
    const r = await clearGroup(uid, sessions.require(uid), show, { ...lineup, id: String(lineupId) });
    await answered();
    return r;
  },

  // Messages page: read live from WhatsApp, returned as the (short-lived) command result, never stored elsewhere.
  list_threads: (uid) => listThreads(uid),
  get_thread: getThread,
  get_media: getMedia,
  summarize_thread: summarizeThread,
  // Nothing BOT Comedy, Rooms → Import from text, file or link: turns pasted text, a file or a link into rooms. Nothing is saved
  // here (the app shows the result in the merge-with-review sheet). The payload can hold a person's pasted list and curator
  // numbers, so the result is short-lived like the Messages ones.
  parse_roster: (uid, payload) => {
    const { settings } = watchUser(uid);
    return parseRoster(payload as ParseRosterInput, {
      ai: {
        text: (prompt, schema) => generateJson(uid, settings.ai, prompt, schema as Record<string, unknown>),
        file: (prompt, schema, file) => generateJsonFromFile(uid, settings.ai, prompt, schema as Record<string, unknown>, file),
      },
      fetchUrl: (url) => safeFetch(url),
    });
  },
  // "Your voice" → Choose chats: names of every chat, short-lived like the Messages results.
  list_voice_sources: (uid) => listVoiceSourceChats(uid),
};

/** Commands whose result holds chat text: it expires fast (TTL_DAYS.messages) and the app deletes it once read. */
const CHAT_RESULT_COMMANDS = new Set<Command["type"]>(["list_threads", "get_thread", "get_media", "summarize_thread", "list_voice_sources", "parse_roster"]);

/** The confirmation as the curator set it up: the text (in their voice), then the venue pin if that's on. */
/** Is this comic the curator's own WhatsApp? */
export function isSelf(client: WAWebJS.Client, c: Pick<Comic, "id" | "chatId" | "phone">) {
  const me = client.info?.wid?.user;
  return Boolean(me && (c.id === `${me}@c.us` || c.chatId === `${me}@c.us` || c.phone === me));
}

export async function sendConfirmation(uid: string, client: WAWebJS.Client, show: Show, comic: Comic, week: string, minutes?: number | null) {
  const { settings, venues } = watchUser(uid);
  const venue = venues.find((v) => v.id === show.venueId);
  const facts = await confirmFacts(uid, client, show, comic, week, minutes);
  return sendRich(client, comic.chatId ?? comic.id, { kind: "text", body: settings.confirm.template, attachLocation: settings.confirm.attachLocation }, facts, venue, {
    rewrite: (text) => inVoice(uid, "confirm", text, facts),
  });
}

async function confirmFacts(uid: string, client: WAWebJS.Client | null, show: Show, comic: Comic, week: string, minutes?: number | null) {
  const { venues } = watchUser(uid);
  const venue = venues.find((v) => v.id === show.venueId);
  return {
    name: await greetFor(client, comic),
    show: show.name,
    venue: venue?.name,
    mapsLink: venue?.mapsLink,
    day: DAY_NAMES[show.weekday],
    date: formatDate(dateInWeek(week, show.weekday)),
    time: formatTime(show.startTime),
    minutes: show.includeSlotTime ? (minutes ?? show.defaultMinutes) : null,
  };
}

export async function cancelBody(uid: string, client: WAWebJS.Client | null, show: Show, comic: Comic, week: string) {
  const { settings, venues } = watchUser(uid);
  const venue = venues.find((v) => v.id === show.venueId);
  const facts = {
    name: await greetFor(client, comic),
    show: show.name,
    venue: venue?.name,
    day: DAY_NAMES[show.weekday],
    date: formatDate(dateInWeek(week, show.weekday)),
    time: formatTime(show.startTime),
  };
  return inVoice(uid, "cancelSpot", renderTemplate(settings.cancelSpot.template, facts), facts);
}

/** Every active show this week is either sent or cancelled. */
async function weekIsFinal(uid: string, week: string, shows: Show[]) {
  const active = shows.filter((s) => s.active);
  if (!active.length) return false;
  const snaps = await db.getAll(...active.map((s) => col(uid, "lineups").doc(lineupId(week, s.id))));
  return snaps.every((s) => ["confirmed", "cancelled", "canned"].includes((s.data() as Lineup | undefined)?.status ?? "draft"));
}

/** A comic drops out: free the slot, log it, and pull them from the group if the show is today. */
export async function dropFromLineup(uid: string, client: WAWebJS.Client, comicId: string, id: string) {
  const { shows, settings } = watchUser(uid);
  const lineupRef = col(uid, "lineups").doc(id);
  const lineup = (await lineupRef.get()).data() as Lineup | undefined;
  if (!lineup || lineup.backfilled) return;
  const show = shows.find((s) => s.id === lineup.showId);
  const date = show ? dateInWeek(lineup.weekOf, show.weekday) : lineup.date;
  // They cancelled themselves: nothing is owed to them, so they leave the "what was sent" record too.
  const { [comicId]: _told, ...stillTold } = lineup.sent ?? {};
  await lineupRef.update({
    slots: lineup.slots.filter((s) => s.comicId !== comicId),
    dropped: [...(lineup.dropped ?? []), { comicId, at: Date.now() }],
    ...(lineup.sent ? { sent: stillTold } : {}),
  });
  const comicRef = col(uid, "comics").doc(comicId);
  const comic = (await comicRef.get()).data() as Comic | undefined;
  await comicRef.set(cancelledPatch(comic, lineup, show), { merge: true });
  await col(uid, "requests").doc(`${lineup.weekOf}_${comicId}`).set({ status: "dismissed", updatedAt: Date.now() }, { merge: true });
  if (show?.groupId && localNow(new Date(), settings.timezone).date === date) {
    const group = (await client.getChatById(show.groupId)) as WAWebJS.GroupChat;
    const lid = (await lidMap(client, group)).get(comicId);
    await group.removeParticipants([lid ?? comicId]).catch(() => undefined);
  }
  await notice(uid, "info", `${comic?.name ?? "A comic"} dropped out of ${show?.name ?? "a show"}. A slot is open.`, "lineup");
}

/** `kind` marks the notices the agent number also forwards to the curator's WhatsApp (offer outcomes, lineup changes, server moves); warnings always go. */
export async function notice(uid: string, level: "info" | "warn", text: string, kind?: NoticeKind) {
  await col(uid, "notices").add({ level, text, createdAt: Date.now(), read: false, expireAt: expireAt(TTL_DAYS.notices), ...(kind ? { kind } : {}) });
}

/** Run one command handler directly (the agent's "confirm Monday" uses the same code as the Confirm button). */
export const runHandler = (type: Command["type"], uid: string, payload: Record<string, unknown> = {}) => handlers[type](uid, payload);

/**
 * Show-day group update: one automatic pass on the day of the show.
 * Same safety rules as the manual sync (admins, regulars, protected and unidentified members stay).
 */
export async function runShowDaySync(uid: string, id: string) {
  const client = sessions.require(uid);
  const { shows } = watchUser(uid);
  const lineupRef = col(uid, "lineups").doc(id);
  const plan = (await handlers.plan_group_sync(uid, { lineupId: id })) as GroupSyncPlan;
  const results = (await handlers.sync_group(uid, { lineupId: id, exclude: [] })) as NonNullable<GroupSyncPlan["results"]>;
  const lineup = (await lineupRef.get()).data() as Lineup;
  const show = shows.find((s) => s.id === lineup.showId) as Show;
  await lineupRef.update({ showDaySyncedOn: dateInWeek(lineup.weekOf, show.weekday) });

  const comics = await loadComics(uid, [...plan.toAdd, ...lineup.slots.map((s) => s.comicId)]);
  const failed = Object.entries(results).filter(([, r]) => r === "failed").map(([cid]) => comics.get(cid)?.name ?? `+${cid.split("@")[0]}`);
  if (failed.length) await notice(uid, "warn", `${show.name}: couldn't update ${failed.join(", ")} in the group. Add them by hand.`);

  if (show.postLineupToGroup && show.groupId && lineup.slots.length) {
    const names = lineup.slots.map((s) => comics.get(s.comicId)?.name ?? "TBA");
    const venue = watchUser(uid).venues.find((v) => v.id === show.venueId);
    const vars = groupPostVars(show, venue, dateInWeek(lineup.weekOf, show.weekday), names);
    await sendRich(client, show.groupId, messageRich(watchUser(uid).settings, "groupLineup"), vars, venue);
  }
  console.log(`[show-day] ${uid} ${show.name}: +${plan.toAdd.length} −${plan.toRemove.length}`);
}

export async function loadComics(uid: string, ids: string[]) {
  const map = new Map<string, Comic>();
  if (!ids.length) return map;
  const refs = ids.map((id) => col(uid, "comics").doc(id));
  for (const snap of await db.getAll(...refs)) if (snap.exists) map.set(snap.id, snap.data() as Comic);
  return map;
}

/** Group members as phone-based ids. Newer WhatsApp groups expose @lid ids; map them back. */
export async function normaliseParticipants(client: WAWebJS.Client, group: WAWebJS.GroupChat) {
  const lids = group.participants.filter((p) => p.id.server === "lid").map((p) => p.id._serialized);
  const map = new Map<string, string>();
  if (lids.length) {
    for (const r of await client.getContactLidAndPhone(lids)) if (r.lid && r.pn) map.set(r.lid, r.pn);
  }
  return group.participants.map((p) => ({
    id: map.get(p.id._serialized) ?? p.id._serialized,
    isAdmin: Boolean(p.isAdmin || p.isSuperAdmin),
  }));
}

export async function lidMap(client: WAWebJS.Client, group: WAWebJS.GroupChat) {
  const lids = group.participants.filter((p) => p.id.server === "lid").map((p) => p.id._serialized);
  const map = new Map<string, string>(); // phone id -> lid
  if (lids.length) for (const r of await client.getContactLidAndPhone(lids)) if (r.lid && r.pn) map.set(r.pn, r.lid);
  return map;
}

const inFlight = new Set<string>();

export async function runCommand(uid: string, doc: QueryDocumentSnapshot) {
  if (inFlight.has(doc.id)) return;
  inFlight.add(doc.id);
  const cmd = doc.data() as Command;
  try {
    // Only the server holding the account's lease runs its commands; the rest leave them pending.
    if ((await fleet.gate(uid, cmd.type, cmd.payload)) === "skip") return;
    // Claim it atomically so two worker instances never double-send.
    const claimed = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      if (fresh.data()?.status !== "pending") return false;
      tx.update(doc.ref, { status: "running", startedAt: Date.now() });
      return true;
    });
    if (!claimed) {
      fleet.releaseIfUnwanted(uid, doc.id); // the gate may have claimed the account just for this command
      return;
    }
    const handler = handlers[cmd.type];
    if (!handler) throw new Error(`Unknown command ${cmd.type}`);
    const result = await handler(uid, cmd.payload ?? {}, doc.id);
    await doc.ref.update({ status: "done", result: result ?? null, finishedAt: Date.now(), ...(CHAT_RESULT_COMMANDS.has(cmd.type) && { expireAt: expireAt(TTL_DAYS.messages) }) });
  } catch (e) {
    console.error(`[command] ${uid} ${cmd.type} failed`, e);
    sessions.noteWaError(uid, e); // a wedged WhatsApp page (protocol error, closed target) gets probed and restarted
    await doc.ref.update({ status: "error", error: (e as Error).message, finishedAt: Date.now(), ...(CHAT_RESULT_COMMANDS.has(cmd.type) && { expireAt: expireAt(TTL_DAYS.messages) }) });
  } finally {
    inFlight.delete(doc.id);
  }
}
