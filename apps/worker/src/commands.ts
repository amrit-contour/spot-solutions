// The web app never talks to the worker directly. It writes users/{uid}/commands/{id}
// docs; we pick up pending ones, run them, and write the result back.
import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import WAWebJS from "whatsapp-web.js";
import {
  DAY_NAMES,
  dateInWeek,
  diffGroup,
  formatDate,
  formatTime,
  lineupId,
  pendingRejections,
  localNow,
  renderTemplate,
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
import { col, db, userRef } from "./firebase.ts";
import { sessions } from "./sessions.ts";
import { watchUser } from "./userData.ts";
import { enqueueTask, sendQueued } from "./sendQueue.ts";
import { ollamaPull, ollamaState, testRoute } from "./llm.ts";

type Handler = (uid: string, payload: Record<string, unknown>) => Promise<unknown>;

const handlers: Record<Command["type"], Handler> = {
  async connect(uid) {
    await userRef(uid).set({ waEnabled: true }, { merge: true });
    void sessions.start(uid);
  },

  async logout(uid) {
    await sessions.logout(uid);
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
    for (const slot of lineup.slots) {
      const comic = comics.get(slot.comicId);
      if (!comic) continue;
      const body = confirmBody(uid, show, comic, lineup.weekOf, slot.minutes);
      try {
        await sendQueued(client, comic.chatId ?? comic.id, body);
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
    batch.update(lineupRef, { status: "confirmed", sentAt: Date.now() });
    await batch.commit();

    // Show-day groups are handled by the scheduler on the day; otherwise review the group now.
    if (show.groupId && show.groupMode !== "show_day") await handlers.plan_group_sync(uid, { lineupId }).catch((e) => console.error("[group] plan failed", e));
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
      const name = (comics.get(r.comicId)?.name ?? r.comicName).split(" ")[0];
      try {
        await sendQueued(client, comics.get(r.comicId)?.chatId ?? r.comicId, renderTemplate(settings.reject.template, { name }));
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
    });
    // Anyone we couldn't map to a phone number is kept — never remove what we can't identify.
    const plan: GroupSyncPlan = { status: "pending", toAdd, toRemove, kept: [...kept, ...unresolved] };
    await lineupRef.update({ groupSync: plan });
    return plan;
  },

  async sync_group(uid, { lineupId, exclude }) {
    const client = sessions.require(uid);
    const { shows } = watchUser(uid);
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
        const r = await group.addParticipants([id], { autoSendInviteV4: true, comment: `You're on for ${show.name}!` });
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
    await lineupRef.update({ "groupSync.status": "done", "groupSync.results": results });
    return results;
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

  async send_message(uid, { to, body }) {
    await sendQueued(sessions.require(uid), String(to), String(body));
  },
};

export function confirmBody(uid: string, show: Show, comic: Comic, week: string, minutes?: number | null) {
  const { settings, venues } = watchUser(uid);
  const venue = venues.find((v) => v.id === show.venueId);
  return renderTemplate(settings.confirm.template, {
    name: comic.name.split(" ")[0],
    show: show.name,
    venue: venue?.name,
    mapsLink: venue?.mapsLink,
    day: DAY_NAMES[show.weekday],
    date: formatDate(dateInWeek(week, show.weekday)),
    time: formatTime(show.startTime),
    minutes: show.includeSlotTime ? (minutes ?? show.defaultMinutes) : null,
  });
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
  await lineupRef.update({
    slots: lineup.slots.filter((s) => s.comicId !== comicId),
    dropped: [...(lineup.dropped ?? []), { comicId, at: Date.now() }],
  });
  const comicRef = col(uid, "comics").doc(comicId);
  const comic = (await comicRef.get()).data() as Comic | undefined;
  const history = withHistory(comic?.history, { date, showId: lineup.showId, showName: show?.name ?? "Show", status: "cancelled" });
  await comicRef.set({ history, ...(comic?.lastPerformedWeek === lineup.weekOf ? { lastPerformedWeek: null } : {}) }, { merge: true });
  await col(uid, "requests").doc(`${lineup.weekOf}_${comicId}`).set({ status: "dismissed", updatedAt: Date.now() }, { merge: true });
  if (show?.groupId && localNow(new Date(), settings.timezone).date === date) {
    const group = (await client.getChatById(show.groupId)) as WAWebJS.GroupChat;
    const lid = (await lidMap(client, group)).get(comicId);
    await group.removeParticipants([lid ?? comicId]).catch(() => undefined);
  }
  await notice(uid, "info", `${comic?.name ?? "A comic"} dropped out of ${show?.name ?? "a show"}. A slot is open.`);
}

export async function notice(uid: string, level: "info" | "warn", text: string) {
  await col(uid, "notices").add({ level, text, createdAt: Date.now(), read: false });
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
    // Claim it atomically so two worker instances never double-send.
    const claimed = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      if (fresh.data()?.status !== "pending") return false;
      tx.update(doc.ref, { status: "running", startedAt: Date.now() });
      return true;
    });
    if (!claimed) return;
    const handler = handlers[cmd.type];
    if (!handler) throw new Error(`Unknown command ${cmd.type}`);
    const result = await handler(uid, cmd.payload ?? {});
    await doc.ref.update({ status: "done", result: result ?? null, finishedAt: Date.now() });
  } catch (e) {
    console.error(`[command] ${uid} ${cmd.type} failed`, e);
    await doc.ref.update({ status: "error", error: (e as Error).message, finishedAt: Date.now() });
  } finally {
    inFlight.delete(doc.id);
  }
}
