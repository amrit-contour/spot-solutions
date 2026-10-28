import { col, db } from "./firebase.ts";

export async function migrateExperience(uid: string): Promise<number> {
  const snap = await col(uid, "comics").get();
  let n = 0;
  const b = db.batch();
  for (const d of snap.docs) {
    const c = d.data() as any;
    const pinned = new Set<string>(c.tagsPinned ?? []);
    let changed = false;
    if (c.tier === "featured" && !pinned.has("Killer")) (pinned.add("Killer"), changed = true);
    // tier "regular" with regularOf stays as is; regularOf is kept. nothing to copy.
    if (changed) {
      b.update(d.ref, { tagsPinned: [...pinned] });
      n++;
    }
  }
  if (n) await b.commit();
  return n;
}
