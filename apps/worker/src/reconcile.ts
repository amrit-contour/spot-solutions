// "Check what I've already done". reconcile_waiting reads the curator's own replies and the show groups and suggests
// what to tidy; it writes nothing but its result (and progress). apply_reconcile makes the changes the curator ticked.
// Neither sends a WhatsApp message or touches a group.
import {
  RECONCILE_MEMBERS_MAX_AGE_MS,
  dateInWeek,
  isGroupMember,
  movesOffOtherShows,
  planReconcilePlace,
  suggestReconcile,
  waitingRequests,
  withHistory,
  type Comic,
  type Lineup,
  type ReconcileApplyItem,
  type ReconcileApplyResult,
  type ReconcileDecision,
  type ReconcileSuggestion,
  type Show,
  type SpotRequest,
} from "@spot/shared";
import { col, db } from "./firebase.ts";
import { generateJson } from "./llm.ts";
import { AiPolicyError } from "./aiRouting.ts";
import { listGroupMembers } from "./people.ts";
import { sessions } from "./sessions.ts";
import { watchUser } from "./userData.ts";
import { RECONCILE_SCHEMA, buildReconcilePrompt, parseReconcileDecision } from "./reconcilePrompt.ts";

/** The curator's own messages to read per comic. */
const MAX_REPLIES = 30;
const FETCH_LIMIT = 120;
const PAUSE_MS = 250;
const MAX_ITEMS = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const weekOfPayload = (p: Record<string, unknown>) => {
  const w = String(p.weekOf ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(w)) throw new Error("Pick a week first");
  return w;
};

/** Members of every grouped show this week, refreshing any list older than ten minutes. Returns who failed to refresh. */
export async function groupsFor(uid: string, shows: Show[]) {
  const members = new Map<string, NonNullable<Show["groupMembers"]>["members"]>();
  const failed: string[] = [];
  for (const s of shows.filter((x) => x.groupId)) {
    let cache = ((await col(uid, "shows").doc(s.id).get()).data() as Show | undefined)?.groupMembers;
    if (!cache || cache.groupId !== s.groupId || Date.now() - cache.at > RECONCILE_MEMBERS_MAX_AGE_MS) {
      try {
        await listGroupMembers(uid, { showId: s.id });
        cache = ((await col(uid, "shows").doc(s.id).get()).data() as Show | undefined)?.groupMembers;
      } catch (e) {
        console.error(`[reconcile] ${uid} members of ${s.name} failed`, e);
        failed.push(s.name);
      }
    }
    if (cache && cache.groupId === s.groupId) members.set(s.id, cache.members);
  }
  return { members, failed };
}

/** The curator's own text replies to this comic since they asked, oldest first, with when the newest was sent. */
export async function curatorReplies(client: ReturnType<typeof sessions.require>, chatId: string, since: number) {
  const chat = await client.getChatById(chatId);
  const msgs = (await chat.fetchMessages({ limit: FETCH_LIMIT }))
    .filter((m) => m.fromMe && m.type === "chat" && m.body?.trim() && m.timestamp * 1000 > since)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-MAX_REPLIES);
  return { replies: msgs.map((m) => m.body.slice(0, 1000)), lastAt: msgs.length ? msgs[msgs.length - 1].timestamp * 1000 : 0 };
}

/** What the curator decided, read from their replies. Throws AiPolicyError when no model is allowed. */
export async function readDecision(uid: string, r: SpotRequest, replies: string[], shows: Show[]) {
  const { settings, venues } = watchUser(uid);
  const prompt = buildReconcilePrompt({ replies, ask: r.messages.map((m) => m.body).join(" / "), shows, venues });
  const { text } = await generateJson(uid, settings.ai, prompt, RECONCILE_SCHEMA);
  return parseReconcileDecision(text, replies, shows.map((s) => s.id));
}

export async function reconcileWaiting(uid: string, payload: Record<string, unknown>, commandId?: string) {
  const client = sessions.require(uid);
  const week = weekOfPayload(payload);
  const { settings, venues } = watchUser(uid);
  const cmdRef = commandId ? col(uid, "commands").doc(commandId) : null;
  const writeProgress = (p: { chats: number; done: number; found: number }) => cmdRef?.update({ progress: p }).catch(() => undefined);

  const shows = (await col(uid, "shows").get()).docs.map((d) => ({ ...(d.data() as Show), id: d.id })).filter((s) => s.active);
  const [reqSnap, lineupSnap] = await Promise.all([col(uid, "requests").where("weekOf", "==", week).get(), col(uid, "lineups").where("weekOf", "==", week).get()]);
  const placed = new Set(lineupSnap.docs.flatMap((d) => (d.data() as Lineup).slots.map((s) => s.comicId)));
  const waiting = waitingRequests(
    reqSnap.docs.map((d) => d.data() as SpotRequest),
    placed,
  );

  const { members, failed: groupErrors } = await groupsFor(uid, shows);
  const comics = new Map<string, Comic>();
  for (const s of await db.getAll(...waiting.map((r) => col(uid, "comics").doc(r.comicId)))) if (s.exists) comics.set(s.id, s.data() as Comic);

  const progress = { chats: waiting.length, done: 0, found: 0 };
  await writeProgress(progress);
  const suggestions: ReconcileSuggestion[] = [];
  let unreadable = 0;
  let modelFailed = 0;

  for (const r of waiting) {
    const comic = comics.get(r.comicId);
    const since = Math.min(...r.messages.map((m) => m.at), r.createdAt);
    let replies: string[] = [];
    try {
      replies = (await curatorReplies(client, comic?.chatId ?? r.comicId, since)).replies;
    } catch (e) {
      unreadable++;
      console.error(`[reconcile] ${uid} ${r.comicId} chat unreadable`, e);
    }

    let decision: ReconcileDecision | null = null;
    if (replies.length) {
      try {
        decision = await readDecision(uid, r, replies, shows);
      } catch (e) {
        // A Local-only policy with no local model fails every comic the same way: stop and say so.
        if (e instanceof AiPolicyError) throw e;
        modelFailed++;
        console.error(`[reconcile] ${uid} ${r.comicId} model failed`, e);
      }
    }

    const asMember = comic ?? { id: r.comicId };
    const inGroupOf = shows.filter((s) => members.has(s.id) && isGroupMember(asMember, members.get(s.id) ?? [])).map((s) => s.id);
    const core = suggestReconcile({ decision, groupShowIds: inGroupOf, shows });
    suggestions.push({ requestId: r.id, comicId: r.comicId, comicName: comic?.name ?? r.comicName, inGroupOf, replies: replies.length, ...core });
    if (core.action !== "none") progress.found++;
    progress.done++;
    await writeProgress(progress);
    if (replies.length) await sleep(PAUSE_MS);
  }

  console.log(`[reconcile] ${uid} ${week}: ${waiting.length} checked, ${progress.found} suggestions`);
  // One command result is one Firestore doc (1 MiB). A week's Waiting list is dozens of rows of a few hundred bytes.
  return { suggestions, checked: waiting.length, unreadable, modelFailed, groupErrors, at: Date.now() };
}

/** Apply what the curator ticked. Places each comic in one transaction per show; closes in one more. Sends nothing. */
export async function applyReconcile(uid: string, payload: Record<string, unknown>): Promise<ReconcileApplyResult> {
  const week = weekOfPayload(payload);
  const items = (Array.isArray(payload.items) ? payload.items : []).slice(0, MAX_ITEMS) as ReconcileApplyItem[];
  const out: ReconcileApplyResult = { placed: [], closed: [], skipped: [] };
  const comicOf = (requestId: string) => requestId.slice(week.length + 1);
  const shows = (await col(uid, "shows").get()).docs.map((d) => ({ ...(d.data() as Show), id: d.id }));
  const reqRef = (id: string) => col(uid, "requests").doc(id);
  const validId = (id: unknown): id is string => typeof id === "string" && id.startsWith(`${week}_`) && id.length > week.length + 1;

  const places = new Map<string, ReconcileApplyItem[]>();
  const closes: string[] = [];
  for (const it of items) {
    if (!validId(it?.requestId)) {
      out.skipped.push({ requestId: String(it?.requestId ?? ""), reason: "invalid" });
    } else if (it.action === "close_declined") closes.push(it.requestId);
    else if (it.action === "place" && typeof it.showId === "string") places.set(it.showId, [...(places.get(it.showId) ?? []), it]);
    else out.skipped.push({ requestId: it.requestId, comicId: comicOf(it.requestId), reason: "invalid" });
  }

  const activeShows = shows.filter((s) => s.active);
  for (const [showId, list] of places) {
    const show = shows.find((s) => s.id === showId);
    if (!show) {
      for (const it of list) out.skipped.push({ requestId: it.requestId, comicId: comicOf(it.requestId), reason: "no_show" });
      continue;
    }
    await db.runTransaction(async (tx) => {
      const lineupRefs = activeShows.map((s) => col(uid, "lineups").doc(`${week}_${s.id}`));
      if (!activeShows.some((s) => s.id === show.id)) lineupRefs.push(col(uid, "lineups").doc(`${week}_${show.id}`));
      const lineups = new Map((await tx.getAll(...lineupRefs)).filter((s) => s.exists).map((s) => [s.id, s.data() as Lineup]));
      const reqs = await tx.getAll(...list.map((it) => reqRef(it.requestId)));
      const comicSnaps = await tx.getAll(...list.map((it) => col(uid, "comics").doc(comicOf(it.requestId))));

      const mine = lineups.get(`${week}_${show.id}`);
      let slots = mine?.slots ?? [];
      let sent = mine?.sent ?? null;
      let status: Lineup["status"] = mine?.status ?? "draft";
      let changed = false;
      const now = Date.now();
      const writes: (() => void)[] = [];
      list.forEach((it, i) => {
        const comicId = comicOf(it.requestId);
        const req = reqs[i].data() as SpotRequest | undefined;
        if (!req) return void out.skipped.push({ requestId: it.requestId, comicId, reason: "no_request" });
        if (!["new", "acked"].includes(req.status)) return void out.skipped.push({ requestId: it.requestId, comicId, reason: "not_waiting" });
        const elsewhere = movesOffOtherShows(watchUser(uid).settings.rules, show, comicId) && [...lineups.entries()].some(([id, l]) => id !== `${week}_${show.id}` && l.status !== "cancelled" && l.status !== "canned" && l.slots.some((s) => s.comicId === comicId));
        if (elsewhere) return void out.skipped.push({ requestId: it.requestId, comicId, reason: "elsewhere" });
        const plan = planReconcilePlace({ lineup: { slots, status, sent, sentAt: mine?.sentAt }, show, comicId, markTold: Boolean(it.markTold), now });
        if (plan.outcome === "full" || plan.outcome === "called_off") return void out.skipped.push({ requestId: it.requestId, comicId, reason: plan.outcome === "full" ? "full" : "called_off" });
        slots = plan.slots;
        sent = plan.sent;
        changed = true;
        const comic = comicSnaps[i].data() as Comic | undefined;
        if (it.markTold) {
          // Same records a confirmation leaves, so history and "performed last week" stay right.
          const history = withHistory(comic?.history, { date: dateInWeek(week, show.weekday), showId: show.id, showName: show.name, status: "confirmed" });
          writes.push(() => tx.set(col(uid, "comics").doc(comicId), { lastPerformedWeek: week, history }, { merge: true }));
        }
        writes.push(() => tx.set(reqRef(it.requestId), { status: it.markTold ? "confirmed" : "assigned", updatedAt: now }, { merge: true }));
        out.placed.push({ requestId: it.requestId, comicId, showId: show.id });
      });
      if (changed) {
        const base = mine ?? ({ id: `${week}_${show.id}`, weekOf: week, showId: show.id, date: dateInWeek(week, show.weekday), slots: [], status, sentAt: null, groupSync: null } as Lineup);
        tx.set(col(uid, "lineups").doc(`${week}_${show.id}`), { ...base, slots, ...(sent ? { sent } : {}) });
        writes.forEach((w) => w());
      }
    });
  }

  for (let i = 0; i < closes.length; i += 200) {
    const chunk = closes.slice(i, i + 200);
    await db.runTransaction(async (tx) => {
      const snaps = await tx.getAll(...chunk.map(reqRef));
      const now = Date.now();
      snaps.forEach((s, n) => {
        const id = chunk[n];
        const req = s.data() as SpotRequest | undefined;
        if (!req) return void out.skipped.push({ requestId: id, comicId: comicOf(id), reason: "no_request" });
        if (!["new", "acked"].includes(req.status)) return void out.skipped.push({ requestId: id, comicId: comicOf(id), reason: "not_waiting" });
        // "dismissed" = closed by the curator, nothing sent. ("rejected" means a regret message went out.)
        tx.update(reqRef(id), { status: "dismissed", updatedAt: now });
        out.closed.push(id);
      });
    });
  }
  // Settled here, so any "You already replied" card for the same person is done too.
  const settled = [...out.placed.map((p) => p.requestId), ...out.closed];
  await Promise.all(settled.map((id) => col(uid, "actions").doc(`fu_${id}`.replace(/[^\w-]/g, "_")).update({ status: "sent", sentAt: Date.now() }).catch(() => undefined)));
  console.log(`[reconcile] ${uid} ${week}: applied ${out.placed.length} placed, ${out.closed.length} closed, ${out.skipped.length} skipped`);
  return out;
}
