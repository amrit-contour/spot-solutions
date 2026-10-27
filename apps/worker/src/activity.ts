// What the server did for a lineup, appended to the lineup's `activity` (capped, newest last) so its card can list it.
// Best effort: a failed write here must never break the send, sync or post it describes.
import { appendActivity, type ActivityEntry, type Lineup } from "@spot/shared";
import { col, db } from "./firebase.ts";

export async function logActivity(uid: string, lineupId: string, entry: Omit<ActivityEntry, "at"> & { at?: number }): Promise<void> {
  try {
    const ref = col(uid, "lineups").doc(lineupId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const cur = (snap.data() as Lineup).activity;
      tx.update(ref, { activity: appendActivity(cur, { at: Date.now(), ...entry }) });
    });
  } catch (e) {
    console.warn(`[activity] ${lineupId}: ${(e as Error).message}`);
  }
}
