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
  renderMessage,
  renderTemplate,
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
  type Show,
  type SpotRequest,
} from "@spot/shared";
import { col, db, expireAt, userRef } from "./firebase.ts";
import { sessions } from "./sessions.ts";
import { fleet } from "./fleet.ts";
import { watchUser } from "./userData.ts";
import { listContacts, listGroupMembers, pullGroupMembers } from "./people.ts";
import { enqueueTask, sendQueued } from "./sendQueue.ts";
import { greetFor } from "./greet.ts";
import { inVoice, learnVoice, previewVoice } from "./voice.ts";
import { listGeminiModels, ollamaPull, ollamaState, testRoute } from "./llm.ts";
import { reclassifyRequests } from "./reclassify.ts";
import { scanHistory } from "./scanHistory.ts";
import { applyReconcile, reconcileWaiting } from "./reconcile.ts";

type Handler = (uid: string, payload: Record<string, unknown>, commandId?: string) => Promise<unknown>;

const handlers: Record<Command["type"], Handler> = {
  async connect(uid) {
    await userRef(uid).set({ waEnabled: true }, { merge: true });
    void sessions.start(uid);
  },

  async logout(uid) {
    await sessions.logout(uid);
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
    const show = shows.find((s) => s.id === lineup.showId);
    if (!show) throw new Error("Show not found");
    const comics = await loadComics(uid, lineup.slots.map((s) => s.comicId));

    const results: Record<string, string> = {};
    // Comics the curator already told by hand ("Check what I've done") are recorded in `sent`: don't message them twice.
    const toldByHand = new Set(lineup.status === "confirmed" ? [] : Object.keys(lineup.sent ?? {}));
    for (const slot of lineup.slots) {
      const comic = comics.get(slot.comicId);
      if (!comic) continue;
      if (toldByHand.has(slot.comicId)) {
        results[comic.id] = "sent (already told)";
        continue;
      }
      try {
        await sendQueued(client, comic.chatId ?? comic.id, await confirmBody(uid, client, show, comic, lineup.weekOf, slot.minutes));
        results[comic.id] = "sent";
      } catch (e) {
        results[comic.id] = `failed: ${(e as Error).message}`;
      }
    }

    const batch = db.batch();
    const date = dateInWeek(lineup.weekOf, show.weekday);
    for (const slot of lineup.slots) {
      if (!results[slot.comicId]?.startsWith("sent")) continue;
      const history = withHistory(comics.get(slot.comicId)?.history, { date, showId: show.id, showName: show.name, status: "confirmed" });
      batch.set(col(uid, "comics").doc(slot.comicId), { lastPerformedWeek: lineup.weekOf, history }, { merge: true });
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
      protected: show.protected ?? [],
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
    const send = async (id: string, body: (c: Comic) => Promise<string>) => {
      const comic = comics.get(id);
      try {
        if (!comic) throw new Error("Comic not found");
        await sendQueued(client, comic.chatId ?? comic.id, await body(comic));
        messaged.push(id);
      } catch (e) {
        console.error(`[lineup-update] ${id} failed`, e);
        failed.push(id);
      }
    };
    for (const slot of lineup.slots) {
      if (toAdd.has(slot.comicId) || toResend.has(slot.comicId)) await send(slot.comicId, (c) => confirmBody(uid, client, show, c, lineup.weekOf, slot.minutes));
    }
    for (const id of changes.removed) if (toRemove.has(id)) await send(id, (c) => cancelBody(uid, client, show, c, lineup.weekOf));

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
      const history = withHistory(comics.get(id)?.history, { date, showId: show.id, showName: show.name, status: "confirmed" });
      batch.set(col(uid, "comics").doc(id), { lastPerformedWeek: lineup.weekOf, history }, { merge: true });
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
  async send_action(uid, { actionId, body }) {
    const client = sessions.require(uid);
    const ref = col(uid, "actions").doc(String(actionId));
    const action = (await ref.get()).data() as ComicAction | undefined;
    if (!action || action.status !== "pending") throw new Error("Nothing to send");
    if (action.kind === "cancel_spot" && action.lineupId) await dropFromLineup(uid, client, action.comicId, action.lineupId);
    const comic = (await col(uid, "comics").doc(action.comicId).get()).data() as Comic | undefined;
    await sendQueued(client, comic?.chatId ?? action.comicId, String(body ?? action.draft));
    // Their next message is read as the answer to the onboarding question.
    if (action.kind === "onboard") await col(uid, "comics").doc(action.comicId).set({ onboarding: "asked" }, { merge: true });
    await ref.update({ status: "sent", sentAt: Date.now() });
  },

  /** Curator offers an open slot. A "yes" reply books it (see replies.ts). */
  async send_offer(uid, { comicId, lineupId, body }) {
    const client = sessions.require(uid);
    const { settings, shows } = watchUser(uid);
    const lineup = (await col(uid, "lineups").doc(String(lineupId)).get()).data() as Lineup | undefined;
    if (!lineup) throw new Error("Lineup not found");
    const show = shows.find((s) => s.id === lineup.showId);
    if (!show) throw new Error("Show not found");
    const comic = (await col(uid, "comics").doc(String(comicId)).get()).data() as Comic | undefined;
    if (!comic) throw new Error("Comic not found");
    // One live offer per comic: the newest replaces any older one.
    const old = await col(uid, "offers").where("comicId", "==", comic.id).where("status", "==", "pending").get();
    for (const d of old.docs) await d.ref.update({ status: "expired" });
    await sendQueued(client, comic.chatId ?? comic.id, String(body));
    const now = Date.now();
    const offer: Omit<SpotOffer, "id"> = {
      comicId: comic.id,
      comicName: comic.name,
      weekOf: lineup.weekOf,
      showId: show.id,
      lineupId: String(lineupId),
      status: "pending",
      sentAt: now,
      expiresAt: now + settings.offers.expiryHours * 3600_000,
      reply: null,
    };
    await col(uid, "offers").add(offer);
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
  preview_voice: previewVoice,

  async send_message(uid, { to, body }) {
    await sendQueued(sessions.require(uid), String(to), String(body));
  },
};

export async function confirmBody(uid: string, client: WAWebJS.Client | null, show: Show, comic: Comic, week: string, minutes?: number | null) {
  const { settings, venues } = watchUser(uid);
  const venue = venues.find((v) => v.id === show.venueId);
  const facts = {
    name: await greetFor(client, comic),
    show: show.name,
    venue: venue?.name,
    mapsLink: venue?.mapsLink,
    day: DAY_NAMES[show.weekday],
    date: formatDate(dateInWeek(week, show.weekday)),
    time: formatTime(show.startTime),
    minutes: show.includeSlotTime ? (minutes ?? show.defaultMinutes) : null,
  };
  return inVoice(uid, "confirm", renderTemplate(settings.confirm.template, facts), facts);
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
  if (!lineup) return;
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
  await notice(uid, "info", `${comic?.name ?? "A comic"} dropped out of ${show?.name ?? "a show"}. A slot is open.`);
}

export async function notice(uid: string, level: "info" | "warn", text: string) {
  await col(uid, "notices").add({ level, text, createdAt: Date.now(), read: false, expireAt: expireAt(TTL_DAYS.notices) });
}

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
    const names = lineup.slots.map((s, i) => `${i + 1}. ${comics.get(s.comicId)?.name ?? "TBA"}`).join("\n");
    await sendQueued(client, show.groupId, `*${show.name}: tonight's lineup* (${formatTime(show.startTime)})\n\n${names}`);
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
async function normaliseParticipants(client: WAWebJS.Client, group: WAWebJS.GroupChat) {
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
    await doc.ref.update({ status: "done", result: result ?? null, finishedAt: Date.now() });
  } catch (e) {
    console.error(`[command] ${uid} ${cmd.type} failed`, e);
    await doc.ref.update({ status: "error", error: (e as Error).message, finishedAt: Date.now() });
  } finally {
    inFlight.delete(doc.id);
  }
}
