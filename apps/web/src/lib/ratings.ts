// Rate how a comic did on a night (1-5), or clear it. Kept in two places so it outlives the lineup: the lineup's slot, and the comic's
// spot-history entry for that show and date (that's what the spot history lists). Either can be missing; the other still gets it.
import { runTransaction } from "firebase/firestore";
import { applySlotRatings, lineupId, weekOfDate, withRating, type Comic, type Lineup } from "@spot/shared";
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
