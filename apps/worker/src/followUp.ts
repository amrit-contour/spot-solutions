// Follow-ups: the curator often answers a comic by hand in WhatsApp ("haan bhai monday done", "sorry full this week").
// Every so often, read the curator's own replies to everyone still Waiting this week. A clear "you're on" or "no"
// becomes an Updates card to apply, or, on Auto, is applied straight away. Placing someone also adds them to the
// show's group when they aren't in it. Nothing here sends a message to the comic.
import type WAWebJS from "whatsapp-web.js";
import {
  isGroupMember,
  renderMessage,
  curationWeek,
  suggestReconcile,
  waitingRequests,
  weekOf,
  type ComicAction,
  type Comic,
  type FollowUpSuggestion,
  type Lineup,
  type Show,
  type SpotRequest,
} from "@spot/shared";
import { col, db } from "./firebase.ts";
import { AiPolicyError } from "./aiRouting.ts";
import { isNeverRead } from "./neverRead.ts";
import { applyReconcile, curatorReplies, groupsFor, readDecision } from "./reconcile.ts";
import { notice } from "./commands.ts";
import { enqueueTask, deliverableId } from "./sendQueue.ts";
import { watchUser } from "./userData.ts";

const EVERY_MS = 20 * 60_000;
const lastRun = new Map<string, number>();
const running = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const actionIdFor = (requestId: string) => `fu_${requestId}`.replace(/[^\w-]/g, "_");

/** Called from the scheduler tick; runs at most every 20 minutes per curator. */
export async function maybeCheckFollowUps(uid: string, client: WAWebJS.Client) {
  const { settings } = watchUser(uid);
  if (!(settings.followUp?.enabled ?? true)) return;
  if (running.has(uid) || Date.now() - (lastRun.get(uid) ?? 0) < EVERY_MS) return;
  running.add(uid);
  lastRun.set(uid, Date.now());
  try {
    await checkFollowUps(uid, client);
  } catch (e) {
    if (!(e instanceof AiPolicyError)) console.error(`[follow-up] ${uid} failed`, e);
  } finally {
    running.delete(uid);
  }
}

export async function checkFollowUps(uid: string, client: WAWebJS.Client) {
  const { settings, shows: allShows } = watchUser(uid);
  const shows = allShows.filter((s) => s.active);
  const week = curationWeek(new Date(), settings.timezone, allShows);
  const [reqSnap, lineupSnap] = await Promise.all([col(uid, "requests").where("weekOf", "==", week).get(), col(uid, "lineups").where("weekOf", "==", week).get()]);
  const placed = new Set(lineupSnap.docs.flatMap((d) => (d.data() as Lineup).slots.map((s) => s.comicId)));
  const waiting = waitingRequests(reqSnap.docs.map((d) => d.data() as SpotRequest), placed);
  if (!waiting.length) return;

  // Only people you've written to since you last checked are worth a model call.
  const comics = new Map<string, Comic>();
  for (const s of await db.getAll(...waiting.map((r) => col(uid, "comics").doc(r.comicId)))) if (s.exists) comics.set(s.id, s.data() as Comic);
  const fresh: { r: SpotRequest; replies: string[]; lastAt: number }[] = [];
  for (const r of waiting) {
    // On Never read: their chat is not opened at all.
    if (await isNeverRead(uid, client, r.comicId, comics.get(r.comicId)?.chatId, r.contact?.chatId)) continue;
    const since = Math.min(...r.messages.map((m) => m.at), r.createdAt);
    try {
      const chatId = comics.get(r.comicId)?.chatId ?? r.contact?.chatId ?? r.comicId;
      const { replies, lastAt } = await curatorReplies(client, chatId, since);
      if (replies.length && lastAt > (r.followUpReplyAt ?? 0)) fresh.push({ r, replies, lastAt });
    } catch {
      /* chat not loadable right now: try next round */
    }
  }
  if (!fresh.length) return;

  const { members } = await groupsFor(uid, shows);
  const auto = Boolean(settings.followUp?.auto);
  let applied = 0;
  for (const { r, replies, lastAt } of fresh) {
    const decision = await readDecision(uid, r, replies, shows);
    await col(uid, "requests").doc(r.id).set({ followUpReplyAt: lastAt }, { merge: true });
    const who = comics.get(r.comicId) ?? { id: r.comicId };
    const inGroupOf = shows.filter((s) => members.has(s.id) && isGroupMember(who, members.get(s.id) ?? [])).map((s) => s.id);
    const core = suggestReconcile({ decision, groupShowIds: inGroupOf, shows });
    // Group membership alone is a guess; only your own words make a follow-up.
    if (core.action === "none" || core.confidence !== "high") continue;
    const show = shows.find((s) => s.id === core.showId) ?? null;
    const suggestion: FollowUpSuggestion = {
      requestId: r.id,
      action: core.action,
      showId: core.showId,
      showName: show?.name ?? null,
      addToGroup: core.action === "place" && Boolean(show?.groupId) && !inGroupOf.includes(show?.id ?? ""),
      confidence: "high",
      reason: core.reason,
      evidence: core.evidence,
    };
    const name = comics.get(r.comicId)?.name ?? r.comicName;
    if (auto) {
      const ok = await applyFollowUp(uid, client, week, suggestion);
      if (ok) {
        applied++;
        await notice(uid, "info", suggestion.action === "place" ? `${name}: you told them they're on ${suggestion.showName ?? "a show"}, so they're on the lineup${suggestion.addToGroup ? " and added to the group" : ""}.` : `${name}: you told them no, so their request is closed.`);
      }
    } else {
      await col(uid, "actions").doc(actionIdFor(r.id)).set({
        kind: "follow_up",
        comicId: r.comicId,
        comicName: name,
        weekOf: week,
        message: replies[replies.length - 1],
        draft: "",
        lineupId: null,
        status: "pending",
        createdAt: Date.now(),
        followUp: suggestion,
      } satisfies Omit<ComicAction, "id">);
    }
    await sleep(250);
  }
  console.log(`[follow-up] ${uid} ${week}: ${fresh.length} read, ${auto ? `${applied} applied` : "cards in Updates"}`);
}

/** Place or close the request; add to the show's group when placing someone who isn't in it. Sends no message. */
export async function applyFollowUp(uid: string, client: WAWebJS.Client, week: string, s: FollowUpSuggestion) {
  const res = await applyReconcile(uid, { weekOf: week, items: [{ requestId: s.requestId, action: s.action, showId: s.showId ?? undefined, markTold: true }] });
  const done = res.placed.length > 0 || res.closed.length > 0;
  if (done && s.action === "place" && s.addToGroup && s.showId) {
    const { shows } = watchUser(uid);
    const show: Show | undefined = shows.find((x) => x.id === s.showId);
    if (show?.groupId) {
      const comicId = s.requestId.slice(week.length + 1);
      await enqueueTask(client, async () => {
        const group = (await client.getChatById(show.groupId!)) as WAWebJS.GroupChat;
        await group.addParticipants([await deliverableId(client, comicId)], { autoSendInviteV4: true, comment: renderMessage(watchUser(uid).settings, "groupWelcome", { show: show.name }) });
      }).catch((e) => console.error(`[follow-up] add to ${show.name} failed`, e));
    }
  }
  return done;
}

/** Updates card → Apply. */
export async function applyFollowUpAction(uid: string, client: WAWebJS.Client, actionId: string) {
  const ref = col(uid, "actions").doc(actionId);
  const a = (await ref.get()).data() as ComicAction | undefined;
  if (!a || a.kind !== "follow_up" || a.status !== "pending" || !a.followUp) throw new Error("Nothing to apply");
  const ok = await applyFollowUp(uid, client, a.weekOf, a.followUp);
  await ref.update({ status: ok ? "sent" : "dismissed", sentAt: Date.now() });
  if (!ok) throw new Error("Couldn't apply: the request changed or the show is full. It's been cleared.");
  return { ok };
}
