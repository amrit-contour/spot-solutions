// "How did they do?": after a show is confirmed as happened, the agent lists the lineup and the curator answers by text
// ("1 4, 2 5, 3 3"). Ratings go on the lineup slot and on each comic's spot history entry (so they outlive the lineup).
// Whatever isn't answered stays unrated and can be rated in the app (on the show, or in the comic's spot history).
// Parsing and wording are in packages/shared/src/showRatings.ts.
import {
  RATING_ASK_TTL_MS,
  applySlotRatings,
  formatRatingAsk,
  localNow,
  parseRatings,
  ratingAskDue,
  ratingReply,
  unrated,
  withRating,
  type Comic,
  type Lineup,
} from "@spot/shared";
import { col } from "./firebase.ts";
import { agentOn, readMemory, sendToCurator, writeMemory } from "./agentOutbox.ts";
import { loadComics } from "./commands.ts";
import { watchUser } from "./userData.ts";

const asking = new Set<string>();

/** Save ratings (comic id -> 1..5) on the lineup's slots and on those comics' history entries for that show. */
export async function rateLineup(uid: string, lineupId: string, ratings: Record<string, number>): Promise<boolean> {
  const ref = col(uid, "lineups").doc(lineupId);
  const lineup = (await ref.get()).data() as Lineup | undefined;
  if (!lineup) return false;
  await ref.update({ slots: applySlotRatings(lineup.slots, ratings) });
  for (const [comicId, rating] of Object.entries(ratings)) {
    const cref = col(uid, "comics").doc(comicId);
    const c = (await cref.get()).data() as Comic | undefined;
    const history = withRating(c?.history, lineup.date, lineup.showId, rating);
    if (history && history !== c?.history) await cref.set({ history }, { merge: true });
  }
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
    const due = snap.docs.filter((d) => ratingAskDue(d.data() as Lineup, today) && shows.some((s) => s.id === (d.data() as Lineup).showId)).sort((a, b) => ((b.data() as Lineup).date).localeCompare((a.data() as Lineup).date))[0];
    if (!due) return;
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
  const wait = mem.ratingAsk;
  if (!wait) return null;
  if (Date.now() - wait.at > RATING_ASK_TTL_MS) return void (await writeMemory(uid, { ratingAsk: null })), null;
  const ref = col(uid, "lineups").doc(wait.lineupId);
  const l = (await ref.get()).data() as Lineup | undefined;
  if (!l) return void (await writeMemory(uid, { ratingAsk: null })), null;
  const left = unrated(l.slots);
  const parsed = parseRatings(text, l.slots.length, left.map((x) => x.n));
  if (!parsed) return null;
  const names = await loadComics(uid, l.slots.map((s) => s.comicId));
  const nameAt = (n: number) => names.get(l.slots[n - 1]!.comicId)?.name ?? "A comic";
  if (parsed.skip) {
    await ref.update({ ratingsSkipped: true });
    await writeMemory(uid, { ratingAsk: null });
    return ratingReply({ saved: [], left: [], skipped: true });
  }
  const byId: Record<string, number> = {};
  const saved: { name: string; rating: number }[] = [];
  for (const [n, rating] of Object.entries(parsed.ratings)) {
    const slot = l.slots[Number(n) - 1];
    if (!slot) continue;
    byId[slot.comicId] = rating;
    saved.push({ name: nameAt(Number(n)), rating });
  }
  if (!saved.length) return null;
  await rateLineup(uid, wait.lineupId, byId);
  const after = unrated(applySlotRatings(l.slots, byId));
  if (!after.length) await writeMemory(uid, { ratingAsk: null });
  return ratingReply({ saved, left: after.map((x) => ({ n: x.n, name: nameAt(x.n) })) });
}
