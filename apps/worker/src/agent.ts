// The agent number's brain (docs/agent.md). It obeys ONLY the curator's own linked number, in a 1:1 chat.
//   - tells you things (mic checks, new requests in batches, follow-ups, offer outcomes, warnings) and a morning digest;
//   - answers questions from live data: the model only picks an intent (see shared/agent.ts); every fact comes from Firestore;
//   - does things you ask, but only after it repeats what it understood and you reply yes within 10 minutes.
// It never messages comics: confirmations still go out from the curator's own WhatsApp, through the same handler as the button.
import { createHash } from "node:crypto";
import type WAWebJS from "whatsapp-web.js";
import {
  ACTION_INTENTS, DAY_NAMES, HELP_TEXT, INTENT_SCHEMA, INTENT_THRESHOLD, QUESTION_INTENTS, agentHelpText, askText, dateInWeek, formatMicStatus, richReply, type RichReply, composeDigestRich, digestDue, formatAsked, formatLastPerformed, formatLineup,
  formatPendingConfirm, formatWaiting, intentPrompt, lastSpot, localNow, matchPeople, micAnswer, normalizeRawIntent, parseIntentByRules, personLabel, planAction, requestDays, resolveShow, rolloverDayFor, senderIsCurator, showDay,
  stepPending, strictNo, strictYes, waitingRequests, weekOf, type ActionPlan, type AgentIntent, type AgentScope, type AgentSettings, type Comic, type Lineup, type PersonRef, type Settings, type Show, type ShowDay, type SpotRequest, type Venue, type Weekday,
} from "@spot/shared";
import { col, userRef } from "./firebase.ts";
import { agentSessions } from "./agentSession.ts";
import { curatorPhone, agentOn, flushNotify, queueNotify, queuedCount, readMemory, readSettings, sendToCurator, writeMemory, type AgentMemory } from "./agentOutbox.ts";
import { AiPolicyError } from "./aiRouting.ts";
import { generateJson } from "./llm.ts";
import { loadComics, runHandler } from "./commands.ts";
import { removeFromLineup, placeOnLineup } from "./lineupOps.ts";
import { recordOutcome, settleRound } from "./replies.ts";
import { clearGroup, keepGroup } from "./groupCleanup.ts";
import { sessions } from "./sessions.ts";
import { sendQueued } from "./sendQueue.ts";
import { comicFor, scopeFor } from "./comicAgent.ts";
import { dispatch } from "./agentRoute.ts";
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

async function converse(uid: string, text: string) {
  const A = (await readSettings(uid)).agent!;
  const scope = await scopeFor(uid);
  await dispatch(scope, text, {
    say: (t) => say(uid, t),
    now: () => Date.now(),
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

/** Curate: something is waiting for a yes, a number or a no. True when this message answered it (or was a late answer to it). */
async function curatePending(uid: string, text: string, A: AgentSettings): Promise<boolean> {
  const mem = await readMemory(uid);
  const step = stepPending(mem.pending, text, Date.now());
  if (step.type === "none") return false;
  await writeMemory(uid, { pending: step.type === "chosen" ? step.pending : null });
  if (step.type === "execute") {
    if (!A.actions) await say(uid, "Actions are switched off in Settings, so I did nothing.");
    else await runPlan(uid, step.plan);
    return true;
  }
  if (step.type === "chosen") return void (await say(uid, askText(step.pending))), true;
  if (step.type === "cancel") {
    // "no" to "clear the group?" means keep everyone for next week.
    if (mem.pending?.stage === "confirm" && mem.pending.plan.type === "cleanup") {
      await keepGroup(uid, mem.pending.plan.lineupId);
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

/** Curate: a plain yes/no answers the latest open mic check. */
async function curateMic(uid: string, text: string, A: AgentSettings): Promise<boolean> {
  if (!A.notify) return false;
  const yn = micAnswer(text);
  if (yn === null) return false;
  const done = await answerMicCheck(uid, yn);
  await say(uid, done ?? "Nothing is waiting on a yes or no right now.");
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
    return void (await say(uid, r.pending ? askText(r.pending) : (r.reply ?? "I couldn't work that out."))), "done";
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

/** yes/no to the most recent mic check that is still open (same rule as the old "Message yourself" reply). */
async function answerMicCheck(uid: string, happened: boolean): Promise<string | null> {
  const snap = await col(uid, "lineups").where("micCheckSentOn", "!=", null).get();
  const open = snap.docs.filter((d) => !(d.data() as Lineup).outcome).sort((a, b) => ((b.data() as Lineup).date ?? "").localeCompare((a.data() as Lineup).date ?? ""))[0];
  if (!open) return null;
  const l = open.data() as Lineup;
  await recordOutcome(uid, open.id, happened ? "happened" : "canned");
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
  const w = await world(uid);
  const people = ["add", "remove"].includes(intent.name) ? await roster(uid, w) : [];
  return planAction(intent, { shows: w.shows, venues: w.venues, week: w.week, todayWeekday: w.todayWeekday, lineups: w.lineups }, people, { primaryReady: Boolean(sessions.get(uid)), now: Date.now() });
}

/** After the yes. Re-reads everything: what was true when it asked may not be true now. */
async function runPlan(uid: string, p: ActionPlan) {
  try {
    const w = await world(uid);
    const show = w.shows.find((s) => s.id === p.showId);
    if (!show) return void (await say(uid, "That show isn't there any more, so I did nothing."));
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
  const actions = (await col(uid, "actions").where("status", "==", "pending").get()).docs.map((d) => d.data() as { kind: string; createdAt: number; comicName: string; comicId?: string; followUp?: { action: string; showName: string | null }; dismissedAt?: number });
  for (const a of actions.filter((x) => x.kind === "follow_up" && x.createdAt > from.actions && !x.dismissedAt).sort((a, b) => a.createdAt - b.createdAt)) {
    next.actions = Math.max(next.actions, a.createdAt);
    queueNotify(uid, { kind: "followup", text: a.comicName, id: a.comicId?.includes("@") ? a.comicId : undefined, detail: `(${a.followUp?.action === "place" ? `on ${a.followUp.showName ?? "a show"}` : "said no"})` }, { actions: next.actions });
  }
  const notices = (await col(uid, "notices").where("createdAt", ">", from.notices).get()).docs.map((d) => d.data() as { level: string; kind?: string; text: string; createdAt: number; dismissedAt?: number });
  for (const n of notices.sort((a, b) => a.createdAt - b.createdAt)) {
    next.notices = Math.max(next.notices, n.createdAt);
    if (n.dismissedAt) continue;
    if (n.level === "warn") queueNotify(uid, { kind: "warn", text: n.text }, { notices: next.notices });
    else if (n.kind === "offer" || n.kind === "lineup" || n.kind === "server") queueNotify(uid, { kind: "notice", text: n.text }, { notices: next.notices });
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
  const calWeek = weekOf(new Date(), settings.timezone, 1); // calendar weeks, for "today" and "tomorrow"
  const tomorrow = new Date(Date.parse(`${local.date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const lineupFor = async (date: string, show: Show) => {
    const wk = date === local.date ? calWeek : weekOf(new Date(Date.parse(`${date}T12:00:00Z`)), "UTC", 1);
    const l = (await col(uid, "lineups").doc(`${wk}_${show.id}`).get()).data() as Lineup | undefined;
    const names = await loadComics(uid, l?.slots.map((s) => s.comicId) ?? []);
    const d = showDay(show, wk, l, (id) => names.get(id)?.name ?? `+${id.split("@")[0]}`);
    return { ...d, comicIds: (d.comicIds ?? []).map((id) => names.get(id)?.chatId ?? id) };
  };
  const todayShows = await Promise.all(w.shows.filter((s) => s.weekday === weekdayOf(local.date)).map((s) => lineupFor(local.date, s)));
  const tomorrowShows = await Promise.all(w.shows.filter((s) => s.weekday === weekdayOf(tomorrow)).map((s) => lineupFor(tomorrow, s)));
  const placed = new Set(w.lineups.filter((l) => l.status !== "cancelled" && l.status !== "canned").flatMap((l) => l.slots.map((s) => s.comicId)));
  const waiting = waitingRequests(w.requests, placed).map((r) => ({ name: r.comicName, id: idOf(w, r.comicId), days: requestDays(r) }));
  const unconfirmed = w.shows.map((s) => dayOfShow(w, s)).filter((d: ShowDay) => d.date > tomorrow && (d.status === "draft" || d.status === "none"));
  const [actions, notices, mics] = await Promise.all([
    col(uid, "actions").where("status", "==", "pending").get(),
    col(uid, "notices").where("read", "==", false).get(),
    col(uid, "lineups").where("micCheckSentOn", "!=", null).get(),
  ]);
  const updates = actions.docs.filter((d) => !d.data().dismissedAt).length + notices.docs.filter((d) => !d.data().dismissedAt).length + mics.docs.filter((d) => !(d.data() as Lineup).outcome).length;
  const rich = composeDigestRich({ today: local.date, todayShows, tomorrowShows, waiting, updates, unconfirmed });
  if (rich && !(await sendToCurator(uid, rich.text, { unprompted: true, mentions: { ids: rich.mentions, plain: rich.plain } }))) return; // couldn't send: try again next tick
  await writeMemory(uid, { lastDigestOn: local.date });
}

