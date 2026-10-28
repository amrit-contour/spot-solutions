// "Did it happen?" answered NO: the agent asks two follow-ups, as polls. "What happened at <show>?" (multi-select; the reasons plus
// any typed note go on the lineup and into the show review's notes) and "Repeat this lineup next week?" (Repeat / Don't repeat /
// Not decided). The scheduler picks it up for a no given in the app too. Repeat also answers the day-after cleanup's "keep everyone?"
// (the same question for a show that didn't happen), so the curator is asked once. Not decided is asked again in the morning message.
import {
  RATING_ASK_DAYS, WHY_PRESETS, addDays, cleanReasonOptions, composeNoNotes, isCatchUp, localNow, micCheckDueAt, micDelayHours, ratingAskGate, repeatPollSpec, reviewWithNoNotes, whyPollSpec, formatDate, DAY_NAMES,
  type Lineup, type Show,
} from "@spot/shared";
import { col } from "./firebase.ts";
import { agentOn, readMemory, readSettings, rememberRatingPolls, resolvedInApp, sendRatingPoll, sendToCurator, writeMemory } from "./agentOutbox.ts";
import { generateJson } from "./llm.ts";
import { repeatLineup } from "./repeatNext.ts";
import { watchUser } from "./userData.ts";

const asking = new Set<string>();

/** Reasons for the poll: from the account's AI policy when a model is available, else the presets. "Other" is always last. */
async function reasonOptions(uid: string, show: Show, date: string): Promise<string[]> {
  try {
    const ai = (await readSettings(uid)).ai;
    if (!ai) return WHY_PRESETS;
    const { text } = await generateJson(
      uid,
      ai,
      `A stand-up comedy open mic ("${show.name}", ${date}) was meant to happen but didn't. Suggest 5 to 7 short reasons (2 to 4 words each) the host might pick from, most likely first, such as no audience, too few comics, venue cancelled, rain. Do not include "Other". Reply as JSON: {"reasons": ["..."]}.`,
      { type: "object", properties: { reasons: { type: "array", items: { type: "string" } } }, required: ["reasons"] },
    );
    return cleanReasonOptions(JSON.parse(text)) ?? WHY_PRESETS;
  } catch {
    return WHY_PRESETS;
  }
}

/**
 * Ask what happened, and whether to repeat, for the newest show answered "didn't happen" that hasn't been asked about (once:
 * noAskedOn). `immediate`: the answer was just given, so no waiting. A backlog waits out quiet hours and goes one show at a time.
 */
export async function askDidntHappen(uid: string, o: { immediate?: boolean } = {}): Promise<void> {
  if (asking.has(uid) || !(await agentOn(uid, "notify"))) return;
  const { settings, shows } = watchUser(uid);
  if (!settings.micCheck.enabled) return;
  asking.add(uid);
  try {
    const local = localNow(new Date(), settings.timezone);
    const mem = await readMemory(uid);
    const oldest = addDays(local.date, -RATING_ASK_DAYS);
    const snap = await col(uid, "lineups").where("outcome", "==", "canned").get();
    const afterH = micDelayHours(settings.micCheck);
    const due = snap.docs
      .map((d) => ({ d, l: d.data() as Lineup }))
      .filter(({ l }) => !l.noAskedOn && !l.backfilled && l.date >= oldest && l.date <= local.date && shows.some((s) => s.id === l.showId))
      .filter(({ l }) => {
        const show = shows.find((s) => s.id === l.showId)!;
        const catchUp = !o.immediate && isCatchUp(l, micCheckDueAt(l.date, show.startTime, afterH), local, Date.now());
        return ratingAskGate({ time: local.time, nowMs: Date.now(), lastAskAt: mem.lastRatingAskAt, catchUp, quiet: settings.micCheck.quiet }) === "go";
      })
      .sort((a, b) => b.l.date.localeCompare(a.l.date))[0];
    if (!due) return;
    const { d, l } = due;
    const show = shows.find((s) => s.id === l.showId)!;
    await d.ref.update({ noAskedOn: local.date });
    await writeMemory(uid, { lastRatingAskAt: Date.now() });
    const usePolls = (await readSettings(uid)).agent?.agentPolls !== false;
    // The repeat question is skipped when it is already answered (in the app, or by the cleanup's keep/clear).
    const askRepeat = l.repeatNext == null && !l.cleanup;
    let sent = false;
    if (usePolls) sent = await sendPolls(uid, d.id, l, show, askRepeat);
    if (!sent) {
      const text = `${show.name} on ${formatDate(l.date)} didn't happen. What happened? Reply *note: …* with a few words.${askRepeat ? "\nRepeat this lineup next week? Reply *repeat*, *don't repeat* or *not decided*." : ""}`;
      sent = await sendToCurator(uid, text, { unprompted: true }).catch(() => false);
      if (sent) await writeMemory(uid, { noAsk: { lineupId: d.id, at: Date.now(), repeat: askRepeat } });
    }
    if (!sent) await d.ref.update({ noAskedOn: null });
  } finally {
    asking.delete(uid);
  }
}

async function sendPolls(uid: string, lineupId: string, l: Lineup, show: Show, askRepeat: boolean): Promise<boolean> {
  const intro = `Sorry ${show.name} on ${formatDate(l.date)} didn't happen. Tap what applies, or reply *note: …* with your own words.`;
  if (!(await sendToCurator(uid, intro, { unprompted: true }).catch(() => false))) return false;
  await writeMemory(uid, { noAsk: { lineupId, at: Date.now(), repeat: askRepeat } });
  const why = await sendRatingPoll(uid, whyPollSpec(show.name, await reasonOptions(uid, show, l.date)), true).catch(() => null);
  if (why) await rememberRatingPolls(uid, [{ id: why, kind: "why", lineupId, comicId: null, at: Date.now() }]);
  if (askRepeat) {
    const rep = await sendRatingPoll(uid, repeatPollSpec()).catch(() => null);
    if (rep) await rememberRatingPolls(uid, [{ id: rep, kind: "repeat", lineupId, comicId: null, at: Date.now() }]);
  }
  return true;
}

/** The reasons ticked on the poll (the whole set is read each time, so a changed vote replaces the earlier one). */
export async function setWhy(uid: string, lineupId: string, reasons: string[]): Promise<boolean> {
  const ref = col(uid, "lineups").doc(lineupId);
  const l = (await ref.get()).data() as Lineup | undefined;
  if (!l) return false;
  await ref.update({ noReasons: reasons, review: reviewWithNoNotes(l.review, reasons, l.noNote, Date.now()) });
  return true;
}

/** The curator's own words for why. */
export async function setNote(uid: string, lineupId: string, note: string): Promise<boolean> {
  const ref = col(uid, "lineups").doc(lineupId);
  const l = (await ref.get()).data() as Lineup | undefined;
  if (!l) return false;
  await ref.update({ noNote: note, review: reviewWithNoNotes(l.review, l.noReasons, note, Date.now()) });
  return true;
}

/** The answer to "Repeat this lineup next week?". Returns what to say, or null. Changeable at any time inside the poll's window. */
export async function answerRepeat(uid: string, lineupId: string, choice: "repeat" | "no" | "later"): Promise<string | null> {
  const ref = col(uid, "lineups").doc(lineupId);
  const l = (await ref.get()).data() as Lineup | undefined;
  if (!l) return null;
  if (choice === "repeat") {
    const n = await repeatLineup(uid, lineupId);
    // Keeping everyone in the group is the same answer as the day-after cleanup's "keep everyone?" for a show that didn't happen.
    const show = watchUser(uid).shows.find((s) => s.id === l.showId);
    if (show?.cleanup?.enabled && show.groupId && !l.cleanup) await ref.update({ cleanup: { status: "kept", at: Date.now() } });
    await resolvedInApp(uid, (p) => p.type === "cleanup" && p.lineupId === lineupId, "Got it, that answers the group question too: everyone stays.").catch(() => false);
    return n ? `Next week's lineup starts with the same ${n} ${n === 1 ? "comic" : "comics"} (repeat of ${formatDate(l.date)}).` : "Okay, repeating. Next week's lineup already has people, so I left it.";
  }
  if (choice === "no") {
    await ref.update({ repeatNext: false });
    return null;
  }
  if (l.repeatNext != null) await ref.update({ repeatNext: null });
  return null;
}

const WORD = /^(repeat|repeat it|same lineup|do repeat)$/i;
const NO = /^(don'?t repeat|do not repeat|no repeat|not repeating)$/i;
const LATER = /^(not decided|undecided|later|not sure)$/i;

/** A typed reply to the "didn't happen" questions: "note: rain", or "repeat" / "don't repeat" / "not decided". Null when it isn't one (or nothing is waiting). */
export async function answerNoText(uid: string, text: string, parseNote: (t: string) => string | null): Promise<string | null> {
  const wait = (await readMemory(uid)).noAsk;
  if (!wait || Date.now() - wait.at > 3 * 86_400_000) return null;
  const t = text.trim();
  const note = parseNote(t);
  if (note) return (await setNote(uid, wait.lineupId, note)) ? "Saved your note on the show." : null;
  if (!wait.repeat) return null;
  const choice = WORD.test(t) ? "repeat" : NO.test(t) ? "no" : LATER.test(t) ? "later" : null;
  if (!choice) return null;
  return (await answerRepeat(uid, wait.lineupId, choice)) ?? (choice === "no" ? "Okay, not repeating." : "Okay, I'll ask again in the morning.");
}

/** Morning message: a lineup answered "Not decided" is asked once more. One poll; skipped for a show whose group cleanup asks the same thing ("keep everyone?"). */
export async function askRepeatAgain(uid: string, today: string): Promise<boolean> {
  if (!(await agentOn(uid, "notify")) || (await readSettings(uid)).agent?.agentPolls === false) return false;
  const { shows } = watchUser(uid);
  const oldest = addDays(today, -RATING_ASK_DAYS);
  const snap = await col(uid, "lineups").where("outcome", "==", "canned").get();
  const hit = snap.docs
    .map((d) => ({ id: d.id, l: d.data() as Lineup }))
    .filter(({ l }) => l.noAskedOn && l.noAskedOn < today && l.repeatNext == null && !l.cleanup && l.date >= oldest && shows.some((s) => s.id === l.showId && !(s.cleanup?.enabled && s.groupId)))
    .sort((a, b) => b.l.date.localeCompare(a.l.date))[0];
  if (!hit) return false;
  const day = DAY_NAMES[new Date(`${hit.l.date}T00:00:00Z`).getUTCDay()];
  const id = await sendRatingPoll(uid, { ...repeatPollSpec(), question: `Repeat ${day}'s lineup (${shows.find((s) => s.id === hit.l.showId)!.name})?` }).catch(() => null);
  if (!id) return false;
  await rememberRatingPolls(uid, [{ id, kind: "repeat", lineupId: hit.id, comicId: null, at: Date.now() }]);
  await writeMemory(uid, { noAsk: { lineupId: hit.id, at: Date.now(), repeat: true } });
  return true;
}

export { composeNoNotes };
