// Reset and clean-up writes for the signed-in curator. Plain Firestore writes, all within what the rules allow.
import { getCountFromServer, getDocs, query, where, writeBatch, type DocumentReference } from "firebase/firestore";
import { CLOSED_STATUSES, type LineupResetPlan } from "@spot/shared";
import { db } from "./firebase";
import { userCol, userDoc } from "./data";

const BATCH = 450;

async function commit(ops: ((b: ReturnType<typeof writeBatch>) => void)[]) {
  for (let i = 0; i < ops.length; i += BATCH) {
    const b = writeBatch(db);
    ops.slice(i, i + BATCH).forEach((op) => op(b));
    await b.commit();
  }
}

/** Clear the planned lineups, put their requests back to waiting and undo confirmed comics' performed marks. Sends nothing. */
export function applyResets(uid: string, plans: LineupResetPlan[]) {
  const now = Date.now();
  return commit(
    plans.flatMap((p) => [
      (b: ReturnType<typeof writeBatch>) => b.update(userDoc(uid, "lineups", p.lineupId), p.lineupPatch),
      ...p.requestResets.map((r) => (b: ReturnType<typeof writeBatch>) => b.update(userDoc(uid, "requests", r.id), { status: r.status, updatedAt: now })),
      ...p.comicPatches.map((c) => (b: ReturnType<typeof writeBatch>) => b.set(userDoc(uid, "comics", c.id), c.patch, { merge: true })),
    ]),
  );
}

const olderThan = (uid: string, beforeWeek: string) => query(userCol(uid, "requests"), where("weekOf", "<", beforeWeek));

export async function countOldRequests(uid: string, beforeWeek: string) {
  return (await getCountFromServer(olderThan(uid, beforeWeek))).data().count;
}

export async function deleteOldRequests(uid: string, beforeWeek: string) {
  const refs: DocumentReference[] = (await getDocs(olderThan(uid, beforeWeek))).docs.map((d) => d.ref);
  await commit(refs.map((r) => (b) => b.delete(r)));
  return refs.length;
}

/** Everything the Requests page shows under "Closed" (dismissed, and turned down with a regret), whatever the week. */
const closed = (uid: string) => query(userCol(uid, "requests"), where("status", "in", [...CLOSED_STATUSES]));

export async function countClosedRequests(uid: string) {
  return (await getCountFromServer(closed(uid))).data().count;
}

export async function deleteClosedRequests(uid: string) {
  const refs: DocumentReference[] = (await getDocs(closed(uid))).docs.map((d) => d.ref);
  await commit(refs.map((r) => (b) => b.delete(r)));
  return refs.length;
}
