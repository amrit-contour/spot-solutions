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
import { agentOn, readMemory, sendToCurator, writeMemory } from "./agentOutbox.ts";
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

/** Ask for ratings for the newest happened show that hasn't been asked about. Once per show; only when the agent is linked. */
export async function askRatings(uid: string): Promise<void> {
  if (asking.has(uid) || !(await agentOn(uid, "notify"))) return;
  const { settings, shows } = watchUser(uid);
  if (settings.micCheck.rate === false || !settings.micCheck.enabled) return;
  asking.add(uid);
  try {
    const today = localNow(new Date(), settings.timezone).date;
    const snap = await col(uid, "lineups").where("outcome", "==", "happened").get();
    const mine = (d: { data: () => unknown }) => shows.some((sh) => sh.id === (d.data() as Lineup).showId);
    const newest = (a: { data: () => unknown }, b: { data: () => unknown }) => (b.data() as Lineup).date.localeCompare((a.data() as Lineup).date);
    const due = snap.docs.filter((d) => ratingAskDue(d.data() as Lineup, today) && mine(d)).sort(newest)[0];
    if (!due) {
      // Every comic already rated (in the app, say): the overall question can still be asked, once.
      const reviewDue = snap.docs.filter((d) => reviewAskDue(d.data() as Lineup, today) && mine(d)).sort(newest)[0];
      if (!reviewDue) return;
      const rl = reviewDue.data() as Lineup;
      await reviewDue.ref.update({ reviewAskedOn: today });
      const sentReview = await sendToCurator(uid, formatReviewAsk(shows.find((s) => s.id === rl.showId)!.name), { unprompted: true }).catch(() => false);
      if (sentReview) await writeMemory(uid, { reviewAsk: { lineupId: reviewDue.id, at: Date.now() } });
      else await reviewDue.ref.update({ reviewAskedOn: null });
      return;
    }
    const l = due.data() as Lineup;
    const show = shows.find((s) => s.id === l.showId)!;
    const names = await loadComics(uid, l.slots.map((s) => s.comicId));
    const text = formatRatingAsk({ showName: show.name, date: l.date, rows: l.slots.map((s) => ({ name: names.get(s.comicId)?.name ?? "A comic", rating: s.rating })) });
    await due.ref.update({ ratingAskedOn: today });
    // A send that didn't go out (rate limit, WhatsApp down) is asked again on a later tick.
    const sent = await sendToCurator(uid, text, { unprompted: true }).catch(() => false);
    if (sent) await writeMemory(uid, { ratingAsk: { lineupId: due.id, at: Date.now() } });
    else await due.ref.update({ ratingAskedOn: null });
  } finally {
    asking.delete(uid);
  }
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
  const left = unrated(l.slots);
  // "2 no show, 3 late" (and "1 4, 2 no show": the rest is read as number-and-rating pairs only, never "one each in order").
  const att = parseAttendanceMarks(text, l.slots.length);
  const parsed = att ? (att.rest ? parseRatings(att.rest, l.slots.length, []) : { ratings: {}, skip: false }) : parseRatings(text, l.slots.length, left.map((x) => x.n));
  if (!parsed) return null;
  const names = await loadComics(uid, l.slots.map((s) => s.comicId));
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
