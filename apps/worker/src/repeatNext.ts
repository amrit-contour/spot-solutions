// "Repeat this lineup next week": mark the lineup as repeating (post criteria read repeatNext) and, when next week's lineup for the
// show doesn't exist yet or is empty, seed it from this one's comics, tagged "Repeat of <date>" (lineup.repeatOf). Idempotent.
import { dateInWeek, lineupId, repeatSlots, shiftWeek, type Lineup } from "@spot/shared";
import { col } from "./firebase.ts";
import { watchUser } from "./userData.ts";

/** Returns how many comics were put on next week's lineup (0 when it already had people, or this one had none). */
export async function repeatLineup(uid: string, id: string): Promise<number> {
  const ref = col(uid, "lineups").doc(id);
  const l = (await ref.get()).data() as Lineup | undefined;
  if (!l) return 0;
  await ref.update({ repeatNext: true });
  const show = watchUser(uid).shows.find((s) => s.id === l.showId);
  if (!show) return 0;
  const nextWeek = shiftWeek(l.weekOf, 1);
  const nextRef = col(uid, "lineups").doc(lineupId(nextWeek, show.id));
  const next = (await nextRef.get()).data() as Lineup | undefined;
  const slots = repeatSlots(l, next);
  if (!slots) return 0;
  const base: Lineup = next ?? { id: nextRef.id, weekOf: nextWeek, showId: show.id, date: dateInWeek(nextWeek, show.weekday), slots: [], status: "draft", sentAt: null, groupSync: null };
  await nextRef.set({ ...base, slots, repeatOf: l.date });
  return slots.length;
}

/** The curator kept the group for a show that didn't happen (cleanup's "keep everyone" sets repeatNext): bring next week's lineup along too. */
export async function seedAfterKeep(uid: string, id: string): Promise<void> {
  const l = (await col(uid, "lineups").doc(id).get()).data() as Lineup | undefined;
  if (l?.repeatNext === true && !l.backfilled) await repeatLineup(uid, id);
}
