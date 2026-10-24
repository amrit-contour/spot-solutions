import { getDoc, runTransaction, setDoc, updateDoc } from "firebase/firestore";
import { dateInWeek, lineupId, shiftWeek, type Lineup, type Show, type Slot, type SpotRequest } from "@spot/shared";
import { db } from "./firebase";
import { userDoc } from "./data";

const lineupRef = (uid: string, week: string, showId: string) => userDoc(uid, "lineups", lineupId(week, showId));
const requestRef = (uid: string, week: string, comicId: string) => userDoc(uid, "requests", `${week}_${comicId}`);

function blank(week: string, show: Show): Lineup {
  return { id: lineupId(week, show.id), weekOf: week, showId: show.id, date: dateInWeek(week, show.weekday), slots: [], status: "draft", sentAt: null, groupSync: null };
}

async function markRequest(uid: string, week: string, comicId: string, placed: boolean) {
  const ref = requestRef(uid, week, comicId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const r = snap.data() as SpotRequest;
  if (r.status === "confirmed") return;
  await updateDoc(ref, { status: placed ? "assigned" : r.ackedAt ? "acked" : "new", updatedAt: Date.now() });
}

/** Write a show's full slot list for the week. Moves between shows call this twice. */
export async function setSlots(uid: string, week: string, show: Show, slots: Slot[]) {
  const ref = lineupRef(uid, week, show.id);
  await runTransaction(db, async (tx) => {
    const cur = (await tx.get(ref)).data() as Lineup | undefined;
    tx.set(ref, { ...(cur ?? blank(week, show)), slots });
  });
}

export async function placeComic(uid: string, week: string, show: Show, comicId: string, lineups: Lineup[]) {
  // A comic sits in at most one show per week.
  for (const l of lineups) {
    if (l.showId !== show.id && l.slots.some((s) => s.comicId === comicId) && l.status !== "confirmed") {
      await updateDoc(lineupRef(uid, week, l.showId), { slots: l.slots.filter((s) => s.comicId !== comicId) });
    }
  }
  const cur = lineups.find((l) => l.showId === show.id);
  if (cur?.slots.some((s) => s.comicId === comicId)) return;
  await setSlots(uid, week, show, [...(cur?.slots ?? []), { comicId, minutes: show.includeSlotTime ? (show.defaultMinutes ?? null) : null }]);
  await markRequest(uid, week, comicId, true);
}

export async function unplaceComic(uid: string, week: string, show: Show, comicId: string, lineup: Lineup | undefined) {
  if (!lineup) return;
  await setSlots(uid, week, show, lineup.slots.filter((s) => s.comicId !== comicId));
  await markRequest(uid, week, comicId, false);
}

export { markRequest };

/** Mic got cancelled last week? Bring the same lineup back. */
export async function repeatLastWeek(uid: string, week: string, show: Show) {
  const prev = (await getDoc(lineupRef(uid, shiftWeek(week, -1), show.id))).data() as Lineup | undefined;
  if (!prev?.slots.length) return 0;
  await setSlots(uid, week, show, prev.slots);
  await Promise.all(prev.slots.map((s) => markRequest(uid, week, s.comicId, true)));
  return prev.slots.length;
}

export async function setLineupStatus(uid: string, week: string, show: Show, status: Lineup["status"]) {
  const ref = lineupRef(uid, week, show.id);
  const cur = (await getDoc(ref)).data() as Lineup | undefined;
  await setDoc(ref, { ...(cur ?? blank(week, show)), status });
}
