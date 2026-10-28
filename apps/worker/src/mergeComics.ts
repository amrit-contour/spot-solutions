// Merge duplicate comic docs (the same person stored under a phone id and an @lid) into the one WhatsApp reaches.
// The plan lives in @spot/shared (mergeComics, remapLineup, remapShow); this applies it with the Admin SDK, since offers can't be
// written from the app. Nothing is sent to anyone.
import { findDuplicateComics, linksFromMembers, memberKeySet, mergeComics, remapLineup, remapShow, requestIdFor, type Comic, type Lineup, type Show, type SpotRequest } from "@spot/shared";
import { col, db } from "./firebase.ts";

type Write = (b: FirebaseFirestore.WriteBatch) => void;

async function commit(writes: Write[]) {
  for (let i = 0; i < writes.length; i += 400) {
    const b = db.batch();
    writes.slice(i, i + 400).forEach((w) => w(b));
    await b.commit();
  }
}

export async function mergeComicDocs(uid: string, { keepId, dropIds }: Record<string, unknown>): Promise<{ merged: number; moved: { requests: number; lineups: number; shows: number; offers: number; actions: number } }> {
  const keepKey = String(keepId ?? "");
  const drops = [...new Set(Array.isArray(dropIds) ? dropIds.map(String) : [])].filter((id) => id && id !== keepKey);
  if (!keepKey || !drops.length) throw new Error("Pick a comic to keep and at least one to merge into it");
  const snaps = await db.getAll(...[keepKey, ...drops].map((id) => col(uid, "comics").doc(id)));
  const keep = snaps[0].exists ? ({ ...(snaps[0].data() as Comic), id: snaps[0].id } as Comic) : undefined;
  if (!keep) throw new Error("The comic to keep is gone. Refresh and try again.");
  const others = snaps.slice(1).filter((s) => s.exists).map((s) => ({ ...(s.data() as Comic), id: s.id }));
  const moved = { requests: 0, lineups: 0, shows: 0, offers: 0, actions: 0 };
  if (!others.length) return { merged: 0, moved };
  const from = new Set(others.map((o) => o.id));
  const writes: Write[] = [];
  // The doc that survives, with the best name: requests, offers and actions carry its name.
  const merged = mergeComics(keep, others);

  // Requests are named `${week}_${comicId}`: they move to the kept comic. If both already asked that week, the newer one wins.
  // Several dropped docs can ask the same week, so the winner per week is tracked across all of them, not just against what is stored.
  const best = new Map<string, number>();
  const setFor = new Map<string, Write>();
  for (const id of from) {
    for (const d of (await col(uid, "requests").where("comicId", "==", id).get()).docs) {
      const r = d.data() as SpotRequest;
      const target = col(uid, "requests").doc(requestIdFor(r.weekOf, keep.id));
      if (!best.has(target.id)) best.set(target.id, ((await target.get()).data() as SpotRequest | undefined)?.updatedAt ?? -1);
      moved.requests++;
      if ((best.get(target.id) as number) < (r.updatedAt ?? 0)) {
        best.set(target.id, r.updatedAt ?? 0);
        setFor.set(target.id, (b) => b.set(target, { ...r, id: target.id, comicId: keep.id, comicName: merged.name }));
      }
      writes.push((b) => b.delete(d.ref));
    }
  }
  writes.push(...setFor.values());
  for (const d of (await col(uid, "lineups").get()).docs) {
    const patch = remapLineup(d.data() as Lineup, from, keep.id);
    if (patch) (moved.lineups++, writes.push((b) => b.update(d.ref, patch as Record<string, unknown>)));
  }
  for (const d of (await col(uid, "shows").get()).docs) {
    const patch = remapShow(d.data() as Show, from, keep.id);
    if (patch) (moved.shows++, writes.push((b) => b.update(d.ref, patch as Record<string, unknown>)));
  }
  for (const name of ["offers", "actions"] as const) {
    for (const id of from) {
      for (const d of (await col(uid, name).where("comicId", "==", id).get()).docs) {
        moved[name]++;
        writes.push((b) => b.update(d.ref, { comicId: keep.id, comicName: merged.name }));
      }
    }
  }
  writes.push((b) => b.set(col(uid, "comics").doc(keep.id), merged));
  for (const o of others) writes.push((b) => b.delete(col(uid, "comics").doc(o.id)));
  await commit(writes);
  return { merged: others.length, moved };
}

// ---- Automatic merge of the safe cases ----
// The same phone number, or a phone id and the @lid of the same WhatsApp account, are one person by definition: merged without asking.
// Nothing is sent to anyone. (Two different numbers with the same name are only a suggestion in the app: "Same person".)
const running = new Set<string>();
const timers = new Map<string, NodeJS.Timeout>();

export async function autoMergeDuplicates(uid: string): Promise<number> {
  if (running.has(uid)) return 0;
  running.add(uid);
  let merged = 0;
  try {
    const comics = (await col(uid, "comics").get()).docs.map((d) => ({ ...(d.data() as Comic), id: d.id }));
    const members = (await col(uid, "shows").get()).docs.flatMap((d) => (d.data() as Show).groupMembers?.members ?? []);
    for (const set of findDuplicateComics(comics, linksFromMembers(members), memberKeySet(members))) {
      const r = await mergeComicDocs(uid, { keepId: set.keep.id, dropIds: set.others.map((o) => o.id) });
      merged += r.merged;
    }
    if (merged) console.log(`[merge] ${uid}: merged ${merged} duplicate contact${merged === 1 ? "" : "s"} (same number or same WhatsApp account)`);
  } catch (e) {
    console.warn("[merge] automatic merge failed", (e as Error).message);
  } finally {
    running.delete(uid);
  }
  return merged;
}

/** Look for duplicates a little after a roster change (a new contact, a member refresh), once per burst. */
export function scheduleAutoMerge(uid: string, delayMs = 4000) {
  clearTimeout(timers.get(uid));
  const t = setTimeout(() => {
    timers.delete(uid);
    void autoMergeDuplicates(uid);
  }, delayMs);
  t.unref();
  timers.set(uid, t);
}
