// Rate how a comic did on a night (1-5), or clear it. Kept in two places so it outlives the lineup: the lineup's slot, and the comic's
// spot-history entry for that show and date (that's what the spot history lists). Either can be missing; the other still gets it.
import { runTransaction } from "firebase/firestore";
import { applySlotRatings, applySlotReviews, lineupId, mergeReview, weekOfDate, withRating, withSpotReview, type Comic, type Lineup, type ReviewPatch, type SpotReview } from "@spot/shared";
import { db } from "@spot/ui/firebase";
import { userDoc } from "./data";

export async function rateSpot(uid: string, o: { comicId: string; showId: string; date: string; lineupId?: string }, rating: number | null) {
  const lref = userDoc(uid, "lineups", o.lineupId ?? lineupId(weekOfDate(o.date), o.showId));
  const cref = userDoc(uid, "comics", o.comicId);
  await runTransaction(db, async (tx) => {
    const lineup = (await tx.get(lref)).data() as Lineup | undefined;
    const comic = (await tx.get(cref)).data() as Comic | undefined;
    if (lineup?.slots.some((s) => s.comicId === o.comicId)) tx.update(lref, { slots: applySlotRatings(lineup.slots, { [o.comicId]: rating }) });
    const history = withRating(comic?.history, o.date, o.showId, rating);
    if (history && history !== comic?.history) tx.set(cref, { history }, { merge: true });
  });
}

/** One comic's note on a night (set or clear), kept like the rating: on the lineup slot and in their spot history. */
export function noteSpot(uid: string, o: { comicId: string; showId: string; date: string; lineupId?: string }, note: string | null) {
  return reviewSpots(uid, { showId: o.showId, date: o.date, lineupId: o.lineupId }, undefined, { [o.comicId]: { note } });
}

/**
 * Save a whole post-show review in one go: the show's own review (rating, crowd, notes) on the lineup, and each comic's rating and
 * note on their slot and in their spot history. Only the comics given are touched; a key left out of a comic's review stays as is.
 */
export async function reviewSpots(uid: string, o: { showId: string; date: string; lineupId?: string }, review: ReviewPatch | undefined, spots: Record<string, SpotReview>) {
  const lref = userDoc(uid, "lineups", o.lineupId ?? lineupId(weekOfDate(o.date), o.showId));
  const ids = Object.keys(spots);
  await runTransaction(db, async (tx) => {
    const lineup = (await tx.get(lref)).data() as Lineup | undefined;
    const refs = ids.map((id) => userDoc(uid, "comics", id));
    const comics = await Promise.all(refs.map((r) => tx.get(r)));
    if (lineup) {
      const patch: Record<string, unknown> = {};
      if (ids.some((id) => lineup.slots.some((s) => s.comicId === id))) patch.slots = applySlotReviews(lineup.slots, spots);
      if (review) patch.review = mergeReview(lineup.review, review, Date.now());
      if (Object.keys(patch).length) tx.update(lref, patch);
    }
    ids.forEach((id, i) => {
      const comic = comics[i]!.data() as Comic | undefined;
      const history = withSpotReview(comic?.history, o.date, o.showId, spots[id]!);
      if (history && history !== comic?.history) tx.set(refs[i]!, { history }, { merge: true });
    });
  });
}
