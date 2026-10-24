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
  renderTemplate,
  type Command,
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
    const { settings, shows, venues } = watchUser(uid);
    const lineupRef = col(uid, "lineups").doc(String(lineupId));
    const lineup = (await lineupRef.get()).data() as Lineup | undefined;
    if (!lineup) throw new Error("Lineup not found");
    const show = shows.find((s) => s.id === lineup.showId);
    if (!show) throw new Error("Show not found");
    const venue = venues.find((v) => v.id === show.venueId);
    const comics = await loadComics(uid, lineup.slots.map((s) => s.comicId));

    const results: Record<string, string> = {};
    for (const slot of lineup.slots) {
      const comic = comics.get(slot.comicId);
      if (!comic) continue;
      const body = renderTemplate(settings.confirm.template, {
        name: comic.name.split(" ")[0],
        show: show.name,
        venue: venue?.name,
        mapsLink: venue?.mapsLink,
        day: DAY_NAMES[show.weekday],
        date: formatDate(dateInWeek(lineup.weekOf, show.weekday)),
        time: formatTime(show.startTime),
        minutes: show.includeSlotTime ? (slot.minutes ?? show.defaultMinutes) : null,
      });
      try {
        await sendQueued(client, comic.chatId ?? comic.id, body);
        results[comic.id] = "sent";
      } catch (e) {
        results[comic.id] = `failed: ${(e as Error).message}`;
      }
    }

    const batch = db.batch();
    for (const slot of lineup.slots) {
      if (!results[slot.comicId]?.startsWith("sent")) continue;
      batch.set(col(uid, "comics").doc(slot.comicId), { lastPerformedWeek: lineup.weekOf }, { merge: true });
      batch.set(col(uid, "requests").doc(`${lineup.weekOf}_${slot.comicId}`), { status: "confirmed", updatedAt: Date.now() }, { merge: true });
    }
    batch.update(lineupRef, { status: "confirmed", sentAt: Date.now() });
    await batch.commit();

    if (show.groupId) await handlers.plan_group_sync(uid, { lineupId }).catch((e) => console.error("[group] plan failed", e));
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

  async send_message(uid, { to, body }) {
    await sendQueued(sessions.require(uid), String(to), String(body));
  },
};

/** Every active show this week is either sent or cancelled. */
async function weekIsFinal(uid: string, week: string, shows: Show[]) {
  const active = shows.filter((s) => s.active);
  if (!active.length) return false;
  const snaps = await db.getAll(...active.map((s) => col(uid, "lineups").doc(lineupId(week, s.id))));
  return snaps.every((s) => ["confirmed", "cancelled"].includes((s.data() as Lineup | undefined)?.status ?? "draft"));
}

async function loadComics(uid: string, ids: string[]) {
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

async function lidMap(client: WAWebJS.Client, group: WAWebJS.GroupChat) {
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
