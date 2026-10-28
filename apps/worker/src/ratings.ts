// "How did they do?": after a show is confirmed as happened, the agent lists the lineup and the curator answers by text
// ("1 4, 2 5, 3 3"). Ratings go on the lineup slot and on each comic's spot history entry (so they outlive the lineup).
// Once every comic is rated, the same flow asks once how the show was overall ("4 great crowd, sound was bad"); that goes on the
// lineup's `review`. Whatever isn't answered stays unrated and can be rated in the app (on the show, or in the comic's spot history).
// Parsing and wording are in packages/shared/src/showRatings.ts.
import {
  RATING_ASK_TTL_MS,
  applySlotReviews,
  parseAttendanceMarks,
  withSpotReview,
  type Attendance,
  type SpotReview,
  formatRatingAsk,
  formatReviewAsk,
  localNow,
  formatDate,
  richReply,
  overallPollSpec,
  ratingAskGate,
  isCatchUp,
  micCheckDueAt,
  micDelayHours,
  ratingHeader,
  ratingPollSpec,
  slotsToRate,
  mergeReview,
  parseRatings,
  parseShowReview,
  ratingAskDue,
  ratingReply,
  reviewAskDue,
  reviewReply,
  unrated,
  type Comic,
  type Lineup,
} from "@spot/shared";
import { col } from "./firebase.ts";
import { agentOn, readMemory, readSettings, rememberRatingPolls, sendRatingPoll, sendToCurator, writeMemory } from "./agentOutbox.ts";
import { loadComics } from "./commands.ts";
import { watchUser } from "./userData.ts";

const asking = new Set<string>();

/** Save comics' reviews (rating, attendance, note, tags) on the lineup's slots and on those comics' history entries for that show. */
export async function reviewComics(uid: string, lineupId: string, reviews: Record<string, SpotReview>): Promise<boolean> {
  const ref = col(uid, "lineups").doc(lineupId);
  const lineup = (await ref.get()).data() as Lineup | undefined;
  if (!lineup) return false;
  await ref.update({ slots: applySlotReviews(lineup.slots, reviews) });
  for (const [comicId, r] of Object.entries(reviews)) {
    const cref = col(uid, "comics").doc(comicId);
    const c = (await cref.get()).data() as Comic | undefined;
    const history = withSpotReview(c?.history, lineup.date, lineup.showId, r);
    if (history && history !== c?.history) await cref.set({ history }, { merge: true });
  }
  return true;
}

/** Save ratings (comic id -> 1..5). */
export const rateLineup = (uid: string, lineupId: string, ratings: Record<string, number>) => reviewComics(uid, lineupId, Object.fromEntries(Object.entries(ratings).map(([id, rating]) => [id, { rating }])));

/** Save the show's overall review (rating and/or notes) on the lineup, merged with what is there. */
export async function reviewLineup(uid: string, lineupId: string, patch: { rating?: number | null; notes?: string | null }): Promise<boolean> {
  const ref = col(uid, "lineups").doc(lineupId);
  const lineup = (await ref.get()).data() as Lineup | undefined;
  if (!lineup) return false;
  await ref.update({ review: mergeReview(lineup.review, patch, Date.now()) });
  return true;
}

/**
 * Ask for ratings for the newest happened show that hasn't been asked about. Once per show (ratingAskedOn); only when the agent is linked.
 * Triggered by the yes (in the agent chat, or in the app, which the scheduler picks up): the header and polls go out right away.
 * Only a backlog (a yes more than 12 h old, e.g. found after a restart) waits out quiet hours and goes one show at a time with a
 * gap, so it never bursts. Each comic is a tap-to-answer poll; typing works too.
 */
export async function askRatings(uid: string, o: { immediate?: boolean } = {}): Promise<void> {
  if (asking.has(uid) || !(await agentOn(uid, "notify"))) return;
  const { settings, shows } = watchUser(uid);
  if (settings.micCheck.rate === false || !settings.micCheck.enabled) return;
  asking.add(uid);
  try {
    const local = localNow(new Date(), settings.timezone);
    const today = local.date;
    const mem = await readMemory(uid);
    const afterH = micDelayHours(settings.micCheck);
    // May this lineup's question go out now? A fresh yes always does. A backlog (answered long ago, found after a restart) waits out
    // quiet hours and goes one show at a time, so it never bursts.
    const ready = (l: Lineup): boolean => {
      const show = shows.find((sh) => sh.id === l.showId);
      if (!show) return false;
      const catchUp = !o.immediate && isCatchUp(l, micCheckDueAt(l.date, show.startTime, afterH), local, Date.now());
      return ratingAskGate({ time: local.time, nowMs: Date.now(), lastAskAt: mem.lastRatingAskAt, catchUp, quiet: settings.micCheck.quiet }) === "go";
    };
    const snap = await col(uid, "lineups").where("outcome", "==", "happened").get();
    const mine = (d: { data: () => unknown }) => shows.some((sh) => sh.id === (d.data() as Lineup).showId);
    const newest = (a: { data: () => unknown }, b: { data: () => unknown }) => (b.data() as Lineup).date.localeCompare((a.data() as Lineup).date);
    let due: (typeof snap.docs)[number] | undefined;
    let rows: ReturnType<typeof slotsToRate> = [];
    let names = new Map<string, Comic>();
    for (const d of snap.docs.filter((x) => ratingAskDue(x.data() as Lineup, today) && mine(x) && ready(x.data() as Lineup)).sort(newest)) {
      const l = d.data() as Lineup;
      const got = await loadComics(uid, l.slots.map((s) => s.comicId));
      const r = slotsToRate(l, got).map((x) => ({ ...x, id: got.get(x.comicId)?.chatId ?? (x.comicId.includes("@") ? x.comicId : undefined) }));
      // Nobody left to rate: nothing to ask, and it must not hold up the next show.
      if (!r.length) continue;
      due = d;
      rows = r;
      names = got;
      break;
    }
    if (!due) {
      // Every comic already rated (in the app, say): the overall question can still be asked, once.
      const reviewDue = snap.docs.filter((d) => reviewAskDue(d.data() as Lineup, today) && mine(d) && ready(d.data() as Lineup)).sort(newest)[0];
      if (!reviewDue) return;
      const rl = reviewDue.data() as Lineup;
      const showName = shows.find((s) => s.id === rl.showId)!.name;
      await reviewDue.ref.update({ reviewAskedOn: today });
      await writeMemory(uid, { lastRatingAskAt: Date.now() });
      const sentReview = await askOverall(uid, reviewDue.id, showName, (await readSettings(uid)).agent?.agentPolls !== false);
      if (!sentReview) await reviewDue.ref.update({ reviewAskedOn: null });
      return;
    }
    const l = due.data() as Lineup;
    const show = shows.find((s) => s.id === l.showId)!;
    const usePolls = (await readSettings(uid)).agent?.agentPolls !== false;
    await due.ref.update({ ratingAskedOn: today });
    await writeMemory(uid, { lastRatingAskAt: Date.now() });
    let sent: boolean | null = false;
    if (usePolls) sent = await sendRatingPolls(uid, due.id, l, show.name, rows, today);
    if (!usePolls || sent === null) {
      const text = formatRatingAsk({ showName: show.name, date: l.date, rows: l.slots.map((s) => ({ name: names.get(s.comicId)?.name ?? "A comic", rating: s.rating })) });
      sent = await sendToCurator(uid, text, { unprompted: true }).catch(() => false);
      if (sent) await writeMemory(uid, { ratingAsk: { lineupId: due.id, at: Date.now() } });
    }
    // A send that didn't go out (rate limit, WhatsApp down) is asked again on a later tick.
    if (!sent) await due.ref.update({ ratingAskedOn: null });
  } finally {
    asking.delete(uid);
  }
}

/**
 * The header, then one poll per comic, then the overall poll. Polls go out through the send queue, a few seconds apart with jitter.
 * Each poll is remembered the moment it is sent, so a tap that comes in while later ones are still going out is not lost.
 * true: sent; false: the header never went out; null: the first poll failed (the caller asks in text instead).
 */
async function sendRatingPolls(uid: string, lineupId: string, l: Lineup, showName: string, rows: { n: number; comicId: string; name: string; id?: string }[], today: string): Promise<boolean | null> {
  // The comics are @mentioned where they have a WhatsApp id (a poll title can't carry a mention); plain names otherwise, and the send falls back to plain names by itself if mentions fail.
  const rich = richReply(rows.map((r) => ({ name: r.name, id: r.id })), (labels) => ratingHeader({ showName, dateLabel: formatDate(l.date), rows: rows.map((r, i) => ({ n: r.n, label: labels[i]! })) }));
  if (!(await sendToCurator(uid, rich.text, { unprompted: true, mentions: { ids: rich.mentions, plain: rich.plain } }).catch(() => false))) return false;
  await writeMemory(uid, { ratingAsk: { lineupId, at: Date.now() } });
  let first = true;
  for (const r of rows) {
    const id = await sendRatingPoll(uid, ratingPollSpec(r.name), true).catch((e) => {
      console.warn(`[ratings] ${uid} poll for ${r.name} failed:`, (e as Error).message);
      return null;
    });
    if (!id) {
      if (first) return null;
      continue; // typed answers still reach this one ("2 4")
    }
    first = false;
    await rememberRatingPolls(uid, [{ id, lineupId, comicId: r.comicId, at: Date.now(), label: r.name }]);
  }
  const fresh = (await col(uid, "lineups").doc(lineupId).get()).data() as Lineup | undefined;
  if (fresh && !fresh.reviewAskedOn && !fresh.review) {
    await col(uid, "lineups").doc(lineupId).update({ reviewAskedOn: today });
    if (!(await askOverall(uid, lineupId, showName, true, false))) await col(uid, "lineups").doc(lineupId).update({ reviewAskedOn: null });
  }
  return true;
}

/** "How was the show overall?" as a poll (or as the old text when polls are off or fail). `withText`: say what it is about first (a lone overall question). */
async function askOverall(uid: string, lineupId: string, showName: string, usePolls: boolean, withText = true): Promise<boolean> {
  if (usePolls) {
    if (withText) await sendToCurator(uid, `🎤 One more: how was *${showName}* overall?`, { unprompted: true }).catch(() => false);
    const id = await sendRatingPoll(uid, overallPollSpec(showName)).catch(() => null);
    if (id) {
      await rememberRatingPolls(uid, [{ id, lineupId, comicId: null, at: Date.now(), label: `${showName} overall` }]);
      await writeMemory(uid, { reviewAsk: { lineupId, at: Date.now() } });
      return true;
    }
  }
  if (!(await sendToCurator(uid, formatReviewAsk(showName), { unprompted: true }).catch(() => false))) return false;
  await writeMemory(uid, { reviewAsk: { lineupId, at: Date.now() } });
  return true;
}

/**
 * A message that may answer the rating question. Returns what to say back, or null when it isn't a rating reply (or nothing is
 * waiting for one), so the message goes on to be read as anything else.
 */
export async function answerRatings(uid: string, text: string): Promise<string | null> {
  const mem = await readMemory(uid);
  // The comics' ratings come first when both are waiting (a rating pair would otherwise read as an overall rating).
  return (await answerComicRatings(uid, text, mem.ratingAsk)) ?? (await answerReview(uid, text, mem.reviewAsk));
}

async function answerComicRatings(uid: string, text: string, wait: { lineupId: string; at: number } | null | undefined): Promise<string | null> {
  if (!wait) return null;
  if (Date.now() - wait.at > RATING_ASK_TTL_MS) return void (await writeMemory(uid, { ratingAsk: null })), null;
  const ref = col(uid, "lineups").doc(wait.lineupId);
  const l = (await ref.get()).data() as Lineup | undefined;
  if (!l) return void (await writeMemory(uid, { ratingAsk: null })), null;
  const names = await loadComics(uid, l.slots.map((s) => s.comicId));
  const left = unrated(l.slots);
  // "2 no show, 3 late" (and "1 4, 2 no show": the rest is read as number-and-rating pairs only, never "one each in order").
  const att = parseAttendanceMarks(text, l.slots.length);
  const parsed = att ? (att.rest ? parseRatings(att.rest, l.slots.length, []) : { ratings: {}, skip: false }) : parseRatings(text, l.slots.length, left.map((x) => x.n));
  if (!parsed) return null;
  const nameAt = (n: number) => names.get(l.slots[n - 1]!.comicId)?.name ?? "A comic";
  if (parsed.skip) {
    await ref.update({ ratingsSkipped: true });
    await writeMemory(uid, { ratingAsk: null });
    return ratingReply({ saved: [], left: [], skipped: true });
  }
  const byId: Record<string, SpotReview> = {};
  const saved: { name: string; rating: number }[] = [];
  const marked: { name: string; attendance: Attendance }[] = [];
  for (const [n, attendance] of Object.entries(att?.marks ?? {})) {
    const slot = l.slots[Number(n) - 1];
    if (!slot) continue;
    byId[slot.comicId] = { attendance };
    marked.push({ name: nameAt(Number(n)), attendance });
  }
  for (const [n, rating] of Object.entries(parsed.ratings)) {
    const slot = l.slots[Number(n) - 1];
    if (!slot) continue;
    byId[slot.comicId] = { ...byId[slot.comicId], rating };
    saved.push({ name: nameAt(Number(n)), rating });
  }
  if (!saved.length && !marked.length) return null;
  await reviewComics(uid, wait.lineupId, byId);
  const after = unrated(applySlotReviews(l.slots, byId));
  const reply = ratingReply({ saved, marked, left: after.map((x) => ({ n: x.n, name: nameAt(x.n) })) });
  if (after.length) return reply;
  // That was everyone: ask once how the show was overall, in the same message.
  await writeMemory(uid, { ratingAsk: null });
  const latest = (await ref.get()).data() as Lineup | undefined;
  const showName = watchUser(uid).shows.find((s) => s.id === l.showId)?.name;
  if (!latest || !showName || latest.reviewAskedOn || latest.review) return reply;
  await ref.update({ reviewAskedOn: localNow(new Date(), watchUser(uid).settings.timezone).date });
  await writeMemory(uid, { reviewAsk: { lineupId: wait.lineupId, at: Date.now() } });
  return `${reply}\n\n${formatReviewAsk(showName)}`;
}

/** A message that may answer "how was the show overall?": a rating then notes ("4 great crowd, sound was bad"), or skip. */
async function answerReview(uid: string, text: string, wait: { lineupId: string; at: number } | null | undefined): Promise<string | null> {
  if (!wait) return null;
  if (Date.now() - wait.at > RATING_ASK_TTL_MS) return void (await writeMemory(uid, { reviewAsk: null })), null;
  const parsed = parseShowReview(text);
  if (!parsed) return null;
  if (parsed.skip) {
    await writeMemory(uid, { reviewAsk: null });
    return reviewReply({ rating: null, notes: null, skipped: true });
  }
  if (!(await reviewLineup(uid, wait.lineupId, { rating: parsed.rating, notes: parsed.notes }))) return void (await writeMemory(uid, { reviewAsk: null })), null;
  await writeMemory(uid, { reviewAsk: null });
  return reviewReply({ rating: parsed.rating, notes: parsed.notes });
}
