// The agent number's brain (docs/agent.md). It obeys ONLY the curator's own linked number, in a 1:1 chat.
//   - tells you things (mic checks, new requests in batches, follow-ups, offer outcomes, warnings) and a morning digest;
//   - answers questions from live data: the model only picks an intent (see shared/agent.ts); every fact comes from Firestore;
//   - does things you ask, but only after it repeats what it understood and you reply yes within 10 minutes.
// It never messages comics: confirmations still go out from the curator's own WhatsApp, through the same handler as the button.
import { createHash } from "node:crypto";
import type WAWebJS from "whatsapp-web.js";
import {
  ACTION_INTENTS, DAY_NAMES, HELP_TEXT, lineupId, offerPayload, pastShowReason, INTENT_SCHEMA, INTENT_THRESHOLD, QUESTION_INTENTS, agentHelpText, askText, dateInWeek, formatMicStatus, richReply, type RichReply, composeDigestRich, digestDue, formatAsked, formatLastPerformed, formatLineup,
  formatPendingConfirm, formatWaiting, intentPrompt, lastSpot, localNow, matchPeople, micAnswer, normalizeRawIntent, parseIntentByRules, personLabel, planAction, requestDays, resolveShow, rolloverDayFor, senderIsCurator, showDay,
  stepPending, strictNo, pollForPending, DISMISS_REACTIONS, conflictText, judgeLateVote, mirrorKey, type ChangeAsk, type PollRecord, SIDE_POLL, SIDE_QUESTION, type SideAsk, type PendingAction, strictYes, waitingRequests, weekOf, type ActionPlan, type AgentIntent, type AgentScope, type AgentSettings, type Comic, type Lineup, type PersonRef, type Settings, parseNoNote, type SpotReview, performed, isRating, type YesterdayShow, digestActionPoll, type Show, type ShowDay, type SpotRequest, type Venue, type Weekday,
} from "@spot/shared";
import { col, userRef } from "./firebase.ts";
import { agentSessions } from "./agentSession.ts";
import { curatorPhone, agentOn, flushNotify, queueNotify, queuedCount, readMemory, readSettings, sendCommandPoll, sendQuestion, sendToCurator, writeMemory, type AgentMemory } from "./agentOutbox.ts";
import { applyChange, applyVote, closeMicPolls } from "./agentPolls.ts";
import { claimOnWhatsApp, dismissForwarded, mirrorOfPending, mutateAsks } from "./agentMirror.ts";
import { AiPolicyError } from "./aiRouting.ts";
import { generateJson } from "./llm.ts";
import { loadComics, runHandler } from "./commands.ts";
import { removeFromLineup, placeOnLineup, ensureComic, ensureLineup } from "./lineupOps.ts";
import { adminEmail, membersWaitingText, planMemberChange, runMemberChange } from "./agentAdmin.ts";
import { recordOutcome, settleRound } from "./replies.ts";
import { answerRatings, askRatings, reviewComics, reviewLineup } from "./ratings.ts";
import { clearGroup, keepGroup } from "./groupCleanup.ts";
import { seedAfterKeep } from "./repeatNext.ts";
import { answerNoText, answerRepeat, askDidntHappen, askRepeatAgain, setWhy } from "./noShow.ts";
import { sessions } from "./sessions.ts";
import { sendQueued } from "./sendQueue.ts";
import { comicFor, scopeFor } from "./comicAgent.ts";
import { dispatch } from "./agentRoute.ts";
/** The Curate app, for links in agent messages. */
const APP_BASE = "https://nothingbotcurate.web.app";
import { QUESTION_NOT_COMMAND, curateIntent } from "./agentIntent.ts";

// ---------------------------------------------------------------- incoming messages

const MAX_AGE_MS = 15 * 60_000; // a backlog delivered after a restart is never acted on
const chains = new Map<string, Promise<unknown>>();

/** Hooked to the agent session's "message" event. Messages are handled one at a time per account, so a quick "yes" can't race its question. */
export function onAgentMessage(uid: string, client: WAWebJS.Client, msg: WAWebJS.Message) {
  const run = (chains.get(uid) ?? Promise.resolve()).catch(() => undefined).then(() => handle(uid, client, msg));
  const tail = run.catch((e) => console.error(`[agent] ${uid} handling a message failed:`, (e as Error).message));
  chains.set(uid, tail);
  void tail.then(() => chains.get(uid) === tail && chains.delete(uid));
}

async function handle(uid: string, client: WAWebJS.Client, msg: WAWebJS.Message) {
  // Never log or keep what other people send: only counted, never read.
  if (msg.fromMe || msg.isStatus || msg.broadcast || msg.from.endsWith("@g.us")) return;
  let resolved: string | null = null;
  if (msg.from.endsWith("@lid")) resolved = (await client.getContactLidAndPhone([msg.from]).catch(() => []))[0]?.pn ?? null;
  const phone = await curatorPhone(uid);
  if (!senderIsCurator({ from: msg.from, resolvedPhone: resolved, curatorPhone: phone })) return void (await politeNote(uid, client, msg.from));
  if (Date.now() - msg.timestamp * 1000 > MAX_AGE_MS) return;
  const settings = await readSettings(uid);
  if (!settings.agent?.enabled) return;
  if (msg.type !== "chat" || !msg.body?.trim()) return void (await sendToCurator(uid, "I read text messages only. Send *help* to see what I can do."));
  await converse(uid, msg.body.trim());
}

/** Hooked to the agent session's "vote_update" event: a tap on one of the agent's polls. Same queue as messages, so it can't race them. */
export function onAgentVote(uid: string, client: WAWebJS.Client, vote: WAWebJS.PollVote) {
  const run = (chains.get(uid) ?? Promise.resolve()).catch(() => undefined).then(() => handleVote(uid, client, vote));
  const tail = run.catch((e) => console.error(`[agent] ${uid} handling a vote failed:`, (e as Error).message));
  chains.set(uid, tail);
  void tail.then(() => chains.get(uid) === tail && chains.delete(uid));
}

async function handleVote(uid: string, client: WAWebJS.Client, vote: WAWebJS.PollVote) {
  const pollId = vote.parentMessage?.id?._serialized;
  if (!pollId || vote.parentMessage.to?.endsWith("@g.us")) return;
  // Same rule as text: only the curator's own number, in the one-to-one chat. Anyone else's tap is ignored without a word.
  let resolved: string | null = null;
  if (vote.voter.endsWith("@lid")) resolved = (await client.getContactLidAndPhone([vote.voter]).catch(() => []))[0]?.pn ?? null;
  if (!senderIsCurator({ from: vote.voter, resolvedPhone: resolved, curatorPhone: await curatorPhone(uid) })) return;
  if (!(await readSettings(uid)).agent?.enabled) return;
  await applyVote(voteDeps(uid), pollId, vote.selectedOptions.map((o) => o.name));
}

const voteDeps = (uid: string) => ({
  readMemory: () => readMemory(uid),
  writeMemory: (p: Record<string, unknown>) => writeMemory(uid, p),
  say: (t: string) => say(uid, t),
  now: () => Date.now(),
  // A tap on a rating poll saves straight to the lineup slot / show (any time inside the poll's window; a changed vote replaces the old one).
  review: (lineupId: string, comicId: string, review: SpotReview) => reviewComics(uid, lineupId, { [comicId]: review }),
  overall: (lineupId: string, rating: number) => reviewLineup(uid, lineupId, { rating }),
  why: (lineupId: string, reasons: string[]) => setWhy(uid, lineupId, reasons),
  repeat: (lineupId: string, choice: "repeat" | "no" | "later") => answerRepeat(uid, lineupId, choice),
  nameOf: async (comicId: string) => (await loadComics(uid, [comicId])).get(comicId)?.name ?? "them",
  claim: (pollId: string) => claimOnWhatsApp(uid, (a) => a.msgId === pollId),
  answer: async (kind: string, text: string, rec?: PollRecord) => {
    if (kind === "mic") {
      const A = (await readSettings(uid)).agent!;
      await curateMic(uid, text, A, rec?.lineupId);
      return;
    }
    await converse(uid, text);
  },
});

const changeDeps = (uid: string) => ({
  readMemory: () => readMemory(uid),
  writeMemory: (p: Record<string, unknown>) => writeMemory(uid, p),
  say: (t: string) => say(uid, t),
  now: () => Date.now(),
  setOutcome: (lineupId: string, outcome: "happened" | "canned") => recordOutcome(uid, lineupId, outcome),
  setRepeat: (lineupId: string, choice: "repeat" | "no") => answerRepeat(uid, lineupId, choice),
  reclose: (key: string, result: string, what: string) => mutateAsks(uid, (list, now) => list.map((a) => (a.key === key ? { ...a, closed: { by: "whatsapp" as const, at: now, result, what, verb: "Done" as const }, reacted: true, replied: true } : a))),
});

/**
 * Hooked to the agent session's "message_reaction" event. A ✅ (or 👍) from the curator on a message that forwarded notices dismisses
 * those notices in the app's Updates, the WhatsApp half of the mirror. Only notices: follow-ups and requests are decisions, not news.
 */
export function onAgentReaction(uid: string, client: WAWebJS.Client, reaction: WAWebJS.Reaction) {
  const run = (chains.get(uid) ?? Promise.resolve()).catch(() => undefined).then(() => handleReaction(uid, client, reaction));
  const tail = run.catch((e) => console.error(`[agent] ${uid} handling a reaction failed:`, (e as Error).message));
  chains.set(uid, tail);
  void tail.then(() => chains.get(uid) === tail && chains.delete(uid));
}

async function handleReaction(uid: string, client: WAWebJS.Client, r: WAWebJS.Reaction) {
  if (!DISMISS_REACTIONS.has(r.reaction)) return;
  const msgId = r.msgId?._serialized;
  if (!msgId) return;
  let resolved: string | null = null;
  if (r.senderId?.endsWith("@lid")) resolved = (await client.getContactLidAndPhone([r.senderId]).catch(() => []))[0]?.pn ?? null;
  if (!senderIsCurator({ from: r.senderId ?? "", resolvedPhone: resolved, curatorPhone: await curatorPhone(uid) })) return;
  if (!(await readSettings(uid)).agent?.enabled) return;
  await dismissForwarded(uid, msgId);
}

/** Optional (off by default): one polite line, once per sender. Nothing about their message is read or kept; only a hash of who it was. */
async function politeNote(uid: string, client: WAWebJS.Client, from: string) {
  if (from.includes("broadcast") || from.endsWith("@newsletter")) return;
  const settings = await readSettings(uid);
  if (!settings.agent?.enabled || !settings.agent.politeNote) return;
  const key = createHash("sha256").update(`${uid}:${from}`).digest("hex").slice(0, 16);
  const mem = (await userRef(uid).collection("session").doc("agent").get()).data() as { told?: string[] } | undefined;
  if (mem?.told?.includes(key)) return;
  await writeMemory(uid, { told: [...(mem?.told ?? []), key].slice(-200) });
  const name = String((await userRef(uid).get()).data()?.name ?? "").split(" ")[0];
  await sendQueued(client, from, `I'm ${name ? `${name}'s` : "the curator's"} assistant for Nothing BOT Curate. Please message ${name || "them"} directly on their own number.`);
}

// ---------------------------------------------------------------- the conversation

const say = (uid: string, text: string) => sendToCurator(uid, text).catch((e) => console.warn(`[agent] ${uid} reply failed:`, (e as Error).message));

/** Ask the question that was just stored as pending: a poll when the account uses them (else the text), remembering the poll's id on it. */
async function askPending(uid: string, p: PendingAction) {
  try {
    const id = await sendQuestion(uid, askText(p), { poll: pollForPending(p), kind: "pending", mirror: mirrorOfPending(p) });
    if (id) await writeMemory(uid, { pending: { ...p, pollId: id } });
  } catch (e) {
    console.warn(`[agent] ${uid} reply failed:`, (e as Error).message);
  }
}

/** "Curate or Comedy?" as a poll (text when polls are off or fail). */
async function askSide(uid: string, a: SideAsk) {
  try {
    const id = await sendQuestion(uid, SIDE_QUESTION, { poll: SIDE_POLL, kind: "side" });
    if (id) await writeMemory(uid, { sideAsk: { ...a, pollId: id } });
  } catch (e) {
    console.warn(`[agent] ${uid} reply failed:`, (e as Error).message);
  }
}

async function converse(uid: string, text: string) {
  if (await applyChange(changeDeps(uid), text)) return;
  const A = (await readSettings(uid)).agent!;
  const scope = await scopeFor(uid);
  await dispatch(scope, text, {
    say: (t) => say(uid, t),
    now: () => Date.now(),
    askSide: (a) => askSide(uid, a),
    readSideAsk: async () => (await readMemory(uid)).sideAsk ?? null,
    // One question at a time: asking "Curate or Comedy?" drops any yes/number that was waiting.
    writeSideAsk: async (a) => void (await writeMemory(uid, a ? { sideAsk: a, pending: null, comicPending: null } : { sideAsk: null })),
    curate: {
      answerPending: (t) => curatePending(uid, t, A),
      micAnswer: (t) => curateMic(uid, t, A),
      run: (t) => curateRun(uid, t, scope),
    },
    comic: comicFor(uid),
  });
}

/** The questions an executed plan answers on the app mirror: its own confirmation, and the Updates question about the same thing. */
const claimPlan = (uid: string, p: ActionPlan) =>
  claimOnWhatsApp(uid, (a) => (p.type === "outcome" ? a.lineupId === p.lineupId && (a.kind === "mic" || a.kind === "plan") : p.type === "confirm" ? a.lineupId === p.lineupId && a.kind === "confirm" : p.type === "cleanup" ? a.key === mirrorKey.cleanup(p.lineupId) : p.type === "adhoc_pick" ? a.key === mirrorKey.adhoc(p.roundId) : false));

/** Curate: something is waiting for a yes, a number or a no. True when this message answered it (or was a late answer to it). */
async function curatePending(uid: string, text: string, A: AgentSettings): Promise<boolean> {
  const mem = await readMemory(uid);
  const step = stepPending(mem.pending, text, Date.now());
  if (step.type === "none") return false;
  await writeMemory(uid, { pending: step.type === "chosen" ? step.pending : null });
  // Answered here: close its mirror first, so the state change that follows is never echoed back as "done in the app".
  const pk = mem.pending ? mirrorOfPending(mem.pending)?.key : undefined;
  if (pk && (step.type === "execute" || step.type === "cancel")) await claimOnWhatsApp(uid, (a) => a.key === pk);
  if (step.type === "execute") await claimPlan(uid, step.plan);
  if (step.type === "execute") {
    if (!A.actions) await say(uid, "Actions are switched off in Settings, so I did nothing.");
    else await runPlan(uid, step.plan);
    return true;
  }
  if (step.type === "chosen") return void (await askPending(uid, step.pending)), true;
  if (step.type === "cancel") {
    // "no" to "clear the group?" means keep everyone for next week.
    if (mem.pending?.stage === "confirm" && mem.pending.plan.type === "cleanup") {
      await keepGroup(uid, mem.pending.plan.lineupId);
      await seedAfterKeep(uid, mem.pending.plan.lineupId).catch((e) => console.warn(`[agent] ${uid} seeding next week failed:`, (e as Error).message));
      return void (await say(uid, "Okay, I left the group as it is. Your scheduled group posts go out for next week's show as usual.")), true;
    }
    return void (await say(uid, "Okay, cancelled. Nothing changed.")), true;
  }
  if (step.type === "reprompt") {
    await writeMemory(uid, { pending: mem.pending });
    return void (await say(uid, step.text)), true;
  }
  if (step.type === "expired") {
    await say(uid, "That one timed out after 10 minutes, so nothing was changed. Ask me again if you still want it.");
    return strictYes(text) || strictNo(text);
  }
  // drop: a new request. The old question is gone; say so in a few words so nobody waits on it.
  await say(uid, `(Dropped the earlier question: ${(mem.pending!.stage === "confirm" ? mem.pending!.summary : mem.pending!.prompt).split("\n")[0]!.slice(0, 80)}. Say it again if you still want it.)`);
  return false;
}

/** Curate: a plain yes/no answers the latest open mic check, or the one a tapped poll is about (`lineupId`). */
async function curateMic(uid: string, text: string, A: AgentSettings, lineupId?: string): Promise<boolean> {
  if (!A.notify) return false;
  // "1 4, 2 5": ratings for the lineup the agent just asked about (only when it is waiting for them).
  const rated = await answerRatings(uid, text);
  if (rated) {
    const wait = (await readMemory(uid)).ratingAsk;
    if (wait) await claimOnWhatsApp(uid, (a) => a.lineupId === wait.lineupId && (a.kind === "rate" || a.kind === "overall"));
    return void (await say(uid, rated)), true;
  }
  // "note: rain" / "repeat" after a "didn't happen" question.
  const noReply = await answerNoText(uid, text, parseNoNote);
  if (noReply) {
    const wait = (await readMemory(uid)).noAsk;
    if (wait) await claimOnWhatsApp(uid, (a) => a.lineupId === wait.lineupId && a.kind === "repeat");
    return void (await say(uid, noReply)), true;
  }
  const yn = micAnswer(text);
  if (yn === null) return false;
  const open = await openMicCheck(uid, lineupId);
  if (open?.l.outcome) {
    // The app (or an earlier answer) already settled this show: the same answer is fine, a different one asks first.
    const asked = (await readMemory(uid)).asks?.find((a) => a.key === mirrorKey.mic(open.id));
    const was: NonNullable<Lineup["outcome"]> = open.l.outcome;
    const ask = { kind: "mic" as const, closed: { by: "app" as const, at: Date.now(), result: was, what: was === "happened" ? "marked happened" : "marked didn't happen" }, ...(asked ?? {}) };
    if (judgeLateVote(ask, yn ? "happened" : "canned") === "conflict") {
      await writeMemory(uid, { changeAsk: { key: mirrorKey.mic(open.id), kind: "mic", lineupId: open.id, to: yn ? "happened" : "canned", at: Date.now() } satisfies ChangeAsk });
      await say(uid, conflictText(ask));
    }
    return true;
  }
  if (open) await claimOnWhatsApp(uid, (a) => a.lineupId === open.id && (a.kind === "mic" || a.kind === "plan"));
  const done = await answerMicCheck(uid, yn, open);
  if (done) await closeMicPolls({ readMemory: () => readMemory(uid), writeMemory: (p) => writeMemory(uid, p) }, open?.id);
  await say(uid, done ?? "Nothing is waiting on a yes or no right now.");
  // It happened: ask how each comic did, right away (the scheduler also does this for a yes given in the app).
  if (done && !yn) await askDidntHappen(uid, { immediate: true }).catch((e) => console.warn(`[agent] ${uid} follow-up questions failed:`, (e as Error).message));
  if (done && yn) await askRatings(uid, { immediate: true }).catch((e) => console.warn(`[agent] ${uid} rating question failed:`, (e as Error).message));
  return true;
}

/** Curate: what do they mean? Rules, then the model. Never touches Comedy. */
async function curateRun(uid: string, text: string, scope: AgentScope): Promise<"done" | "unknown"> {
  const settings = await readSettings(uid);
  const A = settings.agent!;
  const { intent, questionNote } = await curateIntent(text, A.answer || A.actions ? () => modelIntent(uid, settings, text) : null, (path, name) => console.log(`[agent] ${uid} intent via ${path}: ${name}`));
  if (questionNote) return void (await say(uid, QUESTION_NOT_COMMAND)), "done";
  if (intent.name === "help") return void (await say(uid, agentHelpText(scope))), "done";
  if (intent.name === "unknown") return "unknown";
  if (QUESTION_INTENTS.includes(intent.name)) {
    if (!A.answer) return void (await say(uid, "Answering questions is switched off in Settings.")), "done";
    {
      const r = await answer(uid, intent);
      return void (typeof r === "string" ? await say(uid, r) : await sendToCurator(uid, r.text, { mentions: { ids: r.mentions, plain: r.plain } }).catch((e) => console.warn(`[agent] ${uid} reply failed:`, (e as Error).message))), "done";
    }
  }
  if (ACTION_INTENTS.includes(intent.name)) {
    if (!A.actions) return void (await say(uid, "Doing things for you is switched off in Settings, so I didn't touch anything.")), "done";
    const r = await plan(uid, intent);
    if (r.pending) await writeMemory(uid, { pending: r.pending, comicPending: null, sideAsk: null });
    return void (await (r.pending ? askPending(uid, r.pending) : say(uid, r.reply ?? "I couldn't work that out."))), "done";
  }
  return "unknown";
}

async function modelIntent(uid: string, settings: Settings, text: string): Promise<AgentIntent> {
  try {
    const w = await world(uid);
    const { text: out } = await generateJson(uid, settings.ai, intentPrompt(text, w.shows.map((s) => ({ name: s.name, weekday: s.weekday, venue: w.venues.find((v) => v.id === s.venueId)?.name }))), INTENT_SCHEMA);
    return normalizeRawIntent(out);
  } catch (e) {
    if (!(e instanceof AiPolicyError)) console.warn(`[agent] ${uid} intent model failed:`, (e as Error).message);
    return { name: "unknown" };
  }
}

/** The mic check a yes/no is about: the one named (a tapped poll), else the most recent one with no answer yet. A named one is returned even when already answered. */
async function openMicCheck(uid: string, lineupId?: string): Promise<{ id: string; l: Lineup } | null> {
  if (lineupId) {
    const l = (await col(uid, "lineups").doc(lineupId).get()).data() as Lineup | undefined;
    if (l) return { id: lineupId, l };
  }
  const snap = await col(uid, "lineups").where("micCheckSentOn", "!=", null).get();
  const open = snap.docs.filter((d) => !(d.data() as Lineup).outcome).sort((a, b) => ((b.data() as Lineup).date ?? "").localeCompare((a.data() as Lineup).date ?? ""))[0];
  return open ? { id: open.id, l: open.data() as Lineup } : null;
}

/** Record yes/no on that mic check (same rule as the old "Message yourself" reply). */
async function answerMicCheck(uid: string, happened: boolean, open: { id: string; l: Lineup } | null): Promise<string | null> {
  if (!open) return null;
  const { id, l } = open;
  await recordOutcome(uid, id, happened ? "happened" : "canned");
  const show = (await world(uid)).shows.find((s) => s.id === l.showId);
  return `Noted: ${show?.name ?? "the show"} on ${l.date} ${happened ? "happened" : "didn't happen"}.`;
}

// ---------------------------------------------------------------- reading the curator's data

interface World {
  settings: Settings;
  shows: Show[];
  venues: Venue[];
  week: string;
  today: string;
  todayWeekday: Weekday;
  lineups: Lineup[];
  requests: SpotRequest[];
  names: Map<string, Comic>;
}

const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() as Weekday;

/** A fresh read of everything an answer needs. Small (one curator's week), and the agent never trusts a cache that restarts with the main WhatsApp. */
async function world(uid: string): Promise<World> {
  const settings = await readSettings(uid);
  const [showSnap, venueSnap] = await Promise.all([col(uid, "shows").get(), col(uid, "venues").get()]);
  const all = showSnap.docs.map((d) => ({ ...(d.data() as Show), id: d.id }));
  const shows = all.filter((s) => s.active);
  const venues = venueSnap.docs.map((d) => ({ ...(d.data() as Venue), id: d.id }));
  const now = new Date();
  const week = weekOf(now, settings.timezone, rolloverDayFor(all));
  const [lineupSnap, reqSnap] = await Promise.all([col(uid, "lineups").where("weekOf", "==", week).get(), col(uid, "requests").where("weekOf", "==", week).get()]);
  const lineups = lineupSnap.docs.map((d) => ({ ...(d.data() as Lineup), id: d.id }));
  const requests = reqSnap.docs.map((d) => ({ ...(d.data() as SpotRequest), id: d.id }));
  const names = await loadComics(uid, [...new Set(lineups.flatMap((l) => l.slots.map((s) => s.comicId)))]);
  const today = localNow(now, settings.timezone).date;
  return { settings, shows, venues, week, today, todayWeekday: weekdayOf(today), lineups, requests, names };
}

const nameFn = (w: World) => (id: string) => w.names.get(id)?.name ?? w.requests.find((r) => r.comicId === id)?.comicName ?? `+${id.split("@")[0]}`;
/** The WhatsApp id a comic can be mentioned by: the id WhatsApp delivers to, else the id itself when it is one. */
const idOf = (w: World, comicId: string | undefined) => (comicId ? w.names.get(comicId)?.chatId ?? (comicId.includes("@") ? comicId : undefined) : undefined);
const dayOfShow = (w: World, s: Show) => showDay(s, w.week, w.lineups.find((l) => l.showId === s.id), nameFn(w));

async function roster(uid: string, w: World): Promise<(PersonRef & { comic?: Comic; banned?: boolean })[]> {
  const comics = (await col(uid, "comics").get()).docs.map((d) => d.data() as Comic);
  const have = new Set(comics.map((c) => c.id));
  const asks = w.requests.filter((r) => !have.has(r.comicId)).map((r) => ({ id: r.comicId, name: r.comicName, phone: r.contact?.phone ?? r.comicId.split("@")[0] }));
  return [...comics.map((c) => ({ id: c.id, name: c.name, phone: c.phone, comic: c, banned: c.list === "banned" })), ...asks];
}

// ---------------------------------------------------------------- questions

async function answer(uid: string, intent: AgentIntent): Promise<string | RichReply> {
  const w = await world(uid);
  if (!w.shows.length) return "You don't have any active shows yet. Add one in the app first.";
  switch (intent.name) {
    case "lineup": {
      const m = resolveShow(intent.day, w.shows, w.venues, w.todayWeekday);
      const list = m.kind === "ok" ? [m.show] : m.kind === "ambiguous" ? m.shows : [];
      if (!list.length) return `I couldn't match "${intent.day}" to one of your shows. Your shows: ${w.shows.map((s) => `${s.name} (${DAY_NAMES[s.weekday]})`).join(", ")}.`;
      const days = list.slice(0, 5).map((s) => dayOfShow(w, s));
      const people = days.flatMap((d) => d.names.map((n, i) => ({ name: n, id: idOf(w, d.comicIds?.[i]) })));
      return richReply(people, (labels) => {
        let k = 0;
        return days.map((d) => formatLineup({ ...d, names: d.names.map(() => labels[k++]!) })).join("\n\n");
      });
    }
    case "waiting": {
      const placed = new Set(w.lineups.filter((l) => l.status !== "cancelled" && l.status !== "canned").flatMap((l) => l.slots.map((s) => s.comicId)));
      const ws = waitingRequests(w.requests, placed);
      return richReply(ws.map((r) => ({ name: r.comicName, id: idOf(w, r.comicId) })), (labels) => formatWaiting(ws.map((r, i) => ({ name: labels[i]!, days: requestDays(r) }))));
    }
    case "members_waiting":
      return membersWaitingText(uid);
    case "pending_confirm":
      return formatPendingConfirm(w.shows.map((s) => dayOfShow(w, s)).filter((d) => d.date >= w.today));
    case "asked": {
      const m = resolveShow(intent.day, w.shows, w.venues, w.todayWeekday);
      const days = new Set<Weekday>(m.kind === "ok" ? [m.show.weekday] : m.kind === "ambiguous" ? m.shows.map((s) => s.weekday) : []);
      const label = m.kind === "ok" ? m.show.name : [...days].map((d) => DAY_NAMES[d]).join(" or ");
      if (!days.size) return `I couldn't match "${intent.day}" to one of your shows.`;
      const who = w.requests.filter((r) => !["rejected", "dismissed"].includes(r.status) && r.intent.isSpotRequest && r.intent.confidence >= INTENT_THRESHOLD && r.intent.preferredDays.some((d) => days.has(d)));
      return richReply(who.map((r) => ({ name: r.comicName, id: idOf(w, r.comicId) })), (labels) => formatAsked(label, who.map((_, i) => ({ name: labels[i]! }))));
    }
    case "mic_status": {
      const m = intent.day ? resolveShow(intent.day, w.shows, w.venues, w.todayWeekday) : null;
      const shows = m ? (m.kind === "ok" ? [m.show] : m.kind === "ambiguous" ? m.shows : []) : w.shows;
      if (!shows.length) return `I couldn't match "${intent.day}" to one of your shows. Your shows: ${w.shows.map((s) => `${s.name} (${DAY_NAMES[s.weekday]})`).join(", ")}.`;
      return shows.slice(0, 5).map((s) => {
        const l = w.lineups.find((x) => x.showId === s.id);
        return formatMicStatus({ showName: s.name, date: dateInWeek(w.week, s.weekday), time: s.startTime, status: l?.status ?? "none", outcome: l?.outcome ?? null, micCheckSent: Boolean(l?.micCheckSentOn) }, w.today);
      }).join("\n");
    }
    case "last_performed": {
      const people = matchPeople(intent.person ?? "", await roster(uid, w));
      if (!people.length) return `I couldn't find anyone called "${intent.person}".`;
      return people.slice(0, 5).map((p) => formatLastPerformed(people.length > 1 ? personLabel(p) : p.name, lastSpot((p as { comic?: Comic }).comic?.history, w.today), w.today)).join("\n");
    }
    default:
      return HELP_TEXT;
  }
}

// ---------------------------------------------------------------- doing things: plan, ask, then run

/** Turns what you asked for into what the agent will repeat back (planAction, shared). Nothing is written here. */
async function plan(uid: string, intent: AgentIntent) {
  if (intent.name === "approve_member" || intent.name === "decline_member") return planMemberChange(uid, intent, Date.now());
  const w = await world(uid);
  const people = ["add", "remove", "offer"].includes(intent.name) ? await roster(uid, w) : [];
  return planAction(intent, { shows: w.shows, venues: w.venues, week: w.week, todayWeekday: w.todayWeekday, lineups: w.lineups, today: w.today }, people, { primaryReady: Boolean(sessions.get(uid)), now: Date.now() });
}

/** After the yes. Re-reads everything: what was true when it asked may not be true now. */
async function runPlan(uid: string, p: ActionPlan) {
  try {
    if (p.type === "member") return void (await say(uid, await runMemberChange(uid, p)));
    const w = await world(uid);
    const show = w.shows.find((s) => s.id === p.showId);
    if (!show) return void (await say(uid, "That show isn't there any more, so I did nothing."));
    if (p.type === "add" || p.type === "remove" || p.type === "offer") {
      // What was true when it asked may not be now: a past or backfilled show is never changed from here ("Record who performed" in the app).
      const l = w.lineups.find((x) => x.showId === show.id);
      const past = pastShowReason({ showName: show.name, date: l?.date ?? dateInWeek(w.week, show.weekday), backfilled: l?.backfilled, today: w.today, what: p.type === "offer" && !p.direct ? "offer" : p.type === "remove" ? "remove" : "add" });
      if (past) return void (await say(uid, past));
    }
    switch (p.type) {
      case "add": {
        const r = await placeOnLineup(uid, w.week, show, w.shows, { id: p.comicId, name: p.comicName, phone: p.phone });
        if (r.outcome === "full") return void (await say(uid, `${show.name} filled up while we were talking, so I didn't add ${p.comicName}.`));
        if (r.outcome === "called_off") return void (await say(uid, `${show.name} is called off, so I didn't add ${p.comicName}.`));
        if (r.outcome === "already") return void (await say(uid, `${p.comicName} was already on ${show.name}.`));
        const l = w.lineups.find((x) => x.showId === show.id);
        return void (await say(uid, `Done: ${p.comicName} is on ${show.name}${r.movedFrom ? ` (moved off ${r.movedFrom})` : ""}.${l?.status === "confirmed" ? " It's confirmed, so they haven't been told yet. Use Send updates in the app." : " They haven't been told: confirm the lineup when you're ready."}`));
      }
      case "remove": {
        const ok = await removeFromLineup(uid, w.week, show, p.comicId);
        const l = w.lineups.find((x) => x.showId === show.id);
        return void (await say(uid, ok ? `Done: ${p.comicName} is off ${show.name}.${l?.status === "confirmed" ? " They haven't been told. Use Send updates in the app if they should be." : ""}` : `${p.comicName} wasn't on ${show.name} any more.`));
      }
      case "offer": {
        if (!sessions.get(uid)) return void (await say(uid, "Your own WhatsApp isn't connected right now, so nothing was sent."));
        const first = p.comicName.split(" ")[0];
        await ensureComic(uid, w.week, { id: p.comicId, name: p.comicName, phone: p.phone });
        const lid = await ensureLineup(uid, w.week, show);
        if (p.direct) {
          // The app's "Already agreed": same handler as send_offer with direct: true (placing, confirmation message, group).
          const r = (await runHandler("send_offer", uid, { comicIds: [p.comicId], lineupId: lid, direct: true, overfill: true, confirm: p.confirm !== false, addToGroup: p.addToGroup !== false })) as { added: number; already: number };
          return void (await say(uid, r.added ? `Done: ${p.comicName} is on ${show.name}${p.confirm === false ? ", not told yet (Send updates or confirm will tell them)" : " and got your confirmation"}${p.addToGroup === false ? ", not added to the group" : ""}.` : r.already ? `${p.comicName} was already on ${show.name}.` : `I couldn't add ${p.comicName} to ${show.name}.`));
        }
        const venue = w.venues.find((v) => v.id === show.venueId);
        const msg = offerPayload(w.settings, show, w.week, venue?.name, p.comicName);
        const r = (await runHandler("send_offer", uid, { comicIds: [p.comicId], lineupId: lid, body: msg.body, rich: msg.rich, overfill: true })) as { sent: number };
        return void (await say(uid, r.sent ? `Done: I sent ${first} the offer for ${show.name}. If they say yes they're added and get your confirmation; I'll tell you what they say.` : `I couldn't send ${first} the offer.`));
      }
      case "outcome": {
        await recordOutcome(uid, p.lineupId, p.outcome);
        return void (await say(uid, `Done: ${show.name} marked as ${p.outcome === "happened" ? "happened" : "didn't happen"}.`));
      }
      case "adhoc_pick": {
        const client = sessions.get(uid);
        if (!client) return void (await say(uid, "Your own WhatsApp isn't connected right now, so I couldn't add them."));
        const r = await settleRound(uid, client, p.roundId, [p.comicId], false);
        return void (await say(uid, r.booked ? `Done: ${p.comicName} is on ${show.name} and got the confirmation.` : `${show.name} filled up, so ${p.comicName} couldn't be added. They've been told.`));
      }
      case "cleanup": {
        const l = (await col(uid, "lineups").doc(p.lineupId).get()).data() as Lineup | undefined;
        if (l?.cleanup?.status === "partial") return void (await say(uid, `The ${show.name} group is mostly cleared; the ${l.cleanup.pending?.length ?? 0} still in are being retried.`));
        if (!l || l.cleanup?.status === "done") return void (await say(uid, `The ${show.name} group was already cleared.`));
        const client = sessions.get(uid);
        if (!client) return void (await say(uid, "Your own WhatsApp isn't connected right now, so I couldn't clear the group."));
        await say(uid, `Clearing the ${show.name} group. It's spaced out, so it takes a minute or two.`);
        const r = await clearGroup(uid, client, show, { ...l, id: p.lineupId });
        return void (await say(uid, `Done: ${r.removed} removed from the ${show.name} group${r.failed ? `, ${r.failed} couldn't be removed (check by hand)` : ""}.`));
      }
      case "retime": {
        await col(uid, "shows").doc(show.id).update({ startTime: p.startTime });
        return void (await say(uid, `Done: ${show.name} now starts at ${p.startTime}. Comics already confirmed haven't been told.`));
      }
      case "confirm": {
        const l = (await col(uid, "lineups").doc(p.lineupId).get()).data() as Lineup | undefined;
        if (!l || l.status === "confirmed" || !l.slots.length) return void (await say(uid, `${show.name} changed (it's confirmed or empty now), so I did nothing.`));
        if (!sessions.get(uid)) return void (await say(uid, "Your own WhatsApp isn't connected right now, so nothing was sent."));
        await say(uid, `On it: sending ${show.name} confirmations from your WhatsApp. It's spaced out, so it takes a minute or two. I'll tell you when it's done.`);
        // Same handler as the Confirm button. It runs in the background so you can keep talking to me meanwhile.
        void runHandler("send_confirmations", uid, { lineupId: p.lineupId }).then(
          async (res) => {
            const r = res as Record<string, string>;
            const sent = Object.values(r).filter((v) => v.startsWith("sent")).length;
            const bad = Object.entries(r).filter(([, v]) => !v.startsWith("sent")).map(([id]) => w.names.get(id)?.name ?? id.split("@")[0]);
            await say(uid, `Done: ${show.name} is confirmed. ${sent} told${bad.length ? `; couldn't reach ${bad.join(", ")}` : ""}.`);
          },
          async (e) => say(uid, `Couldn't send the ${show.name} confirmations: ${(e as Error).message}`),
        );
        return;
      }
    }
  } catch (e) {
    console.error(`[agent] ${uid} action failed`, e);
    await say(uid, `That didn't work: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------- unprompted: notices and the morning digest

/** Called from the scheduler every couple of minutes while the agent is ready. */
export async function agentTick(uid: string) {
  if (!(await agentOn(uid))) return;
  const settings = await readSettings(uid);
  const A = settings.agent!;
  let mem = await readMemory(uid);
  const now = Date.now();
  if (!mem.cursor) {
    // First time: start from now, so linking the agent never replays history.
    mem = { ...mem, cursor: { requests: now, actions: now, notices: now } };
    await writeMemory(uid, { cursor: mem.cursor });
  }
  if (A.notify) {
    await scan(uid, mem, settings).catch((e) => console.warn(`[agent] ${uid} scan failed:`, (e as Error).message));
    // A send that failed leaves the cursors where they were: forget what was scanned so the next tick queues it again.
    if ((await flushNotify(uid)) === "failed") scanned.delete(uid);
  }
  if (A.digest) await maybeDigest(uid, mem, settings).catch((e) => console.warn(`[agent] ${uid} digest failed:`, (e as Error).message));
  // An old question nobody answered is dropped quietly: the next message says it timed out.
}

const scanned = new Map<string, { requests: number; actions: number; notices: number }>();

async function scan(uid: string, mem: AgentMemory, settings: Settings) {
  const persisted = { requests: mem.cursor?.requests ?? Date.now(), actions: mem.cursor?.actions ?? Date.now(), notices: mem.cursor?.notices ?? Date.now() };
  const prev = scanned.get(uid);
  const from = prev ? { requests: Math.max(prev.requests, persisted.requests), actions: Math.max(prev.actions, persisted.actions), notices: Math.max(prev.notices, persisted.notices) } : persisted;
  const next = { ...from };
  const all = (await col(uid, "shows").get()).docs.map((d) => d.data() as Show);
  const week = weekOf(new Date(), settings.timezone, rolloverDayFor(all.map((s) => ({ ...s }))));

  const reqs = (await col(uid, "requests").where("weekOf", "==", week).get()).docs.map((d) => d.data() as SpotRequest);
  for (const r of reqs.filter((x) => x.createdAt > from.requests).sort((a, b) => a.createdAt - b.createdAt)) {
    next.requests = Math.max(next.requests, r.createdAt);
    if (r.intent.isSpotRequest && r.intent.confidence >= INTENT_THRESHOLD && (!r.hold || r.holdOverridden)) queueNotify(uid, { kind: "request", text: r.comicName, id: r.comicId.includes("@") ? r.comicId : undefined }, { requests: next.requests });
  }
  const actions = (await col(uid, "actions").where("status", "==", "pending").get()).docs.map((d) => ({ id: d.id, ...(d.data() as { kind: string; createdAt: number; comicName: string; comicId?: string; followUp?: { action: string; showName: string | null }; dismissedAt?: number }) }));
  for (const a of actions.filter((x) => x.kind === "follow_up" && x.createdAt > from.actions && !x.dismissedAt).sort((a, b) => a.createdAt - b.createdAt)) {
    next.actions = Math.max(next.actions, a.createdAt);
    queueNotify(uid, { kind: "followup", text: a.comicName, id: a.comicId?.includes("@") ? a.comicId : undefined, detail: `(${a.followUp?.action === "place" ? `on ${a.followUp.showName ?? "a show"}` : "said no"})`, ref: { c: "actions", id: a.id } }, { actions: next.actions });
  }
  const notices = (await col(uid, "notices").where("createdAt", ">", from.notices).get()).docs.map((d) => ({ id: d.id, ...(d.data() as { level: string; kind?: string; text: string; agentText?: string; createdAt: number; dismissedAt?: number; quiet?: boolean; link?: string }) }));
  for (const n of notices.sort((a, b) => a.createdAt - b.createdAt)) {
    next.notices = Math.max(next.notices, n.createdAt);
    if (n.dismissedAt || n.quiet) continue; // quiet: in-progress retries, shown in the app's Updates only
    const withLink = (t: string) => (n.link ? `${t}\nDetails: ${APP_BASE}${n.link}` : t);
    if (n.level === "warn") queueNotify(uid, { kind: "warn", text: withLink(n.text), ref: { c: "notices", id: n.id } }, { notices: next.notices });
    else if (n.kind === "offer" || n.kind === "lineup" || n.kind === "server") queueNotify(uid, { kind: "notice", text: n.text, ref: { c: "notices", id: n.id } }, { notices: next.notices });
    else if (n.kind === "access" && (await adminEmail(uid))) queueNotify(uid, { kind: "notice", text: n.agentText ?? n.text, ref: { c: "notices", id: n.id } }, { notices: next.notices });
  }
  // Nothing new to say: still move the cursors forward, so the same scan never repeats.
  scanned.set(uid, next);
  if (!queuedCount(uid) && (next.requests !== persisted.requests || next.actions !== persisted.actions || next.notices !== persisted.notices)) await writeMemory(uid, { cursor: next });
}

async function maybeDigest(uid: string, mem: AgentMemory, settings: Settings) {
  const A = settings.agent!;
  const local = localNow(new Date(), settings.timezone);
  if (!digestDue({ now: local, digestTime: A.digestTime, lastDigestOn: mem.lastDigestOn })) return;
  const w = await world(uid);
  const calWeek = weekOf(new Date(), settings.timezone, 1); // calendar weeks, for "today
  const lineupFor = async (date: string, show: Show) => {
    const wk = date === local.date ? calWeek : weekOf(new Date(Date.parse(`${date}T12:00:00Z`)), "UTC", 1);
    const l = (await col(uid, "lineups").doc(`${wk}_${show.id}`).get()).data() as Lineup | undefined;
    const names = await loadComics(uid, l?.slots.map((s) => s.comicId) ?? []);
    const d = showDay(show, wk, l, (id) => names.get(id)?.name ?? `+${id.split("@")[0]}`);
    return { ...d, comicIds: (d.comicIds ?? []).map((id) => names.get(id)?.chatId ?? id) };
  };
  const todayShows = await Promise.all(w.shows.filter((s) => s.weekday === weekdayOf(local.date)).map((s) => lineupFor(local.date, s)));
  const placed = new Set(w.lineups.filter((l) => l.status !== "cancelled" && l.status !== "canned").flatMap((l) => l.slots.map((s) => s.comicId)));
  const waiting = waitingRequests(w.requests, placed).map((r) => ({ name: r.comicName, id: idOf(w, r.comicId), days: requestDays(r) }));
  const unconfirmed = w.shows.map((s) => dayOfShow(w, s)).filter((d: ShowDay) => d.date > local.date && (d.status === "draft" || d.status === "none"));
  // Yesterday's recap: lineups dated yesterday for the curator's shows (recorded past shows excluded).
  const yesterday = new Date(Date.parse(`${local.date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const yLineups = (await col(uid, "lineups").where("date", "==", yesterday).get()).docs.map((d) => d.data() as Lineup).filter((l) => !l.backfilled && w.shows.some((s) => s.id === l.showId));
  const yesterdayShows: YesterdayShow[] = yLineups.map((l) => ({
    showName: w.shows.find((s) => s.id === l.showId)!.name,
    status: l.status,
    outcome: l.outcome ?? null,
    comics: l.slots.length,
    unrated: l.slots.filter((s) => performed(s.attendance) && !isRating(s.rating)).length,
    noShows: l.slots.filter((s) => s.attendance === "no_show").length,
  }));
  // "3 asks waiting": offers still open for today's lineups.
  const todayLineupIds = new Set(todayShows.map((s) => `${calWeek}_${s.showId}`));
  const offers = (await col(uid, "offers").where("status", "==", "pending").get()).docs.map((d) => d.data() as { lineupId: string; showId: string });
  const asksWaiting: Record<string, number> = {};
  for (const o of offers) if (todayLineupIds.has(o.lineupId)) asksWaiting[o.showId] = (asksWaiting[o.showId] ?? 0) + 1;
  const [actions, notices, mics] = await Promise.all([
    col(uid, "actions").where("status", "==", "pending").get(),
    col(uid, "notices").where("read", "==", false).get(),
    col(uid, "lineups").where("micCheckSentOn", "!=", null).get(),
  ]);
  const updates = actions.docs.filter((d) => !d.data().dismissedAt).length + notices.docs.filter((d) => !d.data().dismissedAt).length + mics.docs.filter((d) => !(d.data() as Lineup).outcome).length;
  const input = { today: local.date, yesterday: yesterdayShows, todayShows, asksWaiting, waiting, updates, unconfirmed };
  const rich = composeDigestRich(input);
  // No show yesterday and none today: no message at all (it is still marked done for the day).
  if (rich) {
    if (!(await sendToCurator(uid, rich.text, { unprompted: true }))) return; // couldn't send: try again next tick
    // Where an action is natural, a tap instead of typing: "Confirm Monday's lineup?" Yes / Later.
    const poll = digestActionPoll(input);
    const confirmId = poll?.showId ? `${w.week}_${poll.showId}` : null;
    const confirming = confirmId ? { key: mirrorKey.confirm(confirmId), kind: "confirm" as const, lineupId: confirmId, label: w.shows.find((x) => x.id === poll!.showId)?.name } : null;
    if (poll) await sendCommandPoll(uid, poll, confirming).catch((e) => console.warn(`[agent] ${uid} digest poll failed:`, (e as Error).message));
  }
  // A show answered "Not decided" on repeating next week is asked once more.
  await askRepeatAgain(uid, local.date).catch((e) => console.warn(`[agent] ${uid} repeat question failed:`, (e as Error).message));
  await writeMemory(uid, { lastDigestOn: local.date });
}

