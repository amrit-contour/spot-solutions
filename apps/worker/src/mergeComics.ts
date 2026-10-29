// Merge duplicate comic docs (the same person stored under a phone id and an @lid) into the one WhatsApp reaches.
// The plan lives in @spot/shared (mergeComics, remapLineup, remapShow); this applies it with the Admin SDK, since offers can't be
// written from the app. Nothing is sent to anyone.
//
// Cost: only the docs that can mention the dropped ids are read, in two rounds of parallel queries (requests, offers and actions by
// comicId; lineups of the weeks and show dates the dropped docs appear in, plus every lineup from a few weeks back on), then one
// batch. It used to read every lineup and run each query one after another: 15 sequential round trips and ~500 docs on a busy
// account (~630 ms at 40 ms a trip); now 10 round trips in 4 sequential rounds and ~140 docs (~170 ms).
import { findDuplicateComics, linksFromMembers, memberKeySet, mergeComics, remapLineup, remapShow, requestIdFor, shiftWeek, TTL_DAYS, weekOfDate, type Comic, type Lineup, type Settings, type Show, type SpotRequest } from "@spot/shared";
import { col, db, expireAt, userRef } from "./firebase.ts";

type Write = (b: FirebaseFirestore.WriteBatch) => void;
type Doc = FirebaseFirestore.QueryDocumentSnapshot;

export interface MergeResult {
  merged: number;
  /** The name the kept contact ends up with (the best-sourced one). */
  name?: string;
  moved: { requests: number; lineups: number; shows: number; offers: number; actions: number };
}

/** Lineups from this many weeks back on are always checked: drafts, invites and group syncs mention people with no history entry yet. */
const RECENT_WEEKS = 4;
/** Firestore's limit on values in one `in` filter. */
const IN_MAX = 30;

async function commit(writes: Write[]) {
  for (let i = 0; i < writes.length; i += 400) {
    const b = db.batch();
    writes.slice(i, i + 400).forEach((w) => w(b));
    await b.commit();
  }
}

/** Docs whose `field` is one of `values`, in parallel `in` queries of at most 30 values. */
async function whereIn(c: FirebaseFirestore.CollectionReference, field: string, values: Iterable<string>): Promise<Doc[]> {
  const vs = [...new Set([...values].filter(Boolean))];
  const parts: string[][] = [];
  for (let i = 0; i < vs.length; i += IN_MAX) parts.push(vs.slice(i, i + IN_MAX));
  return (await Promise.all(parts.map((p) => c.where(field, "in", p).get()))).flatMap((q) => q.docs);
}

export async function mergeComicDocs(uid: string, { keepId, dropIds }: Record<string, unknown>): Promise<MergeResult> {
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
  // The doc that survives, with the best name: requests, offers and actions carry its name.
  const merged = mergeComics(keep, others);

  // Round 1, all at once: what points at the dropped ids by comicId, the shows (a handful), and the lineups they can be on.
  const since = shiftWeek(weekOfDate(new Date().toISOString().slice(0, 10)), -RECENT_WEEKS);
  const oldDates = others.flatMap((o) => (o.history ?? []).map((h) => h.date)).filter((d) => d && weekOfDate(d) < since);
  const [reqDocs, offerDocs, actionDocs, showDocs, recent, dated] = await Promise.all([
    whereIn(col(uid, "requests"), "comicId", from),
    whereIn(col(uid, "offers"), "comicId", from),
    whereIn(col(uid, "actions"), "comicId", from),
    col(uid, "shows").get().then((q) => q.docs),
    col(uid, "lineups").where("weekOf", ">=", since).get().then((q) => q.docs),
    whereIn(col(uid, "lineups"), "date", oldDates),
  ]);

  // Round 2: lineups of older weeks they asked for or last played, and the requests already stored under the kept id.
  const reqs = reqDocs.map((d) => ({ d, r: d.data() as SpotRequest, target: col(uid, "requests").doc(requestIdFor((d.data() as SpotRequest).weekOf, keep.id)) }));
  const oldWeeks = [...reqs.map((x) => x.r.weekOf), ...others.map((o) => o.lastPerformedWeek ?? "")].filter((w) => w && w < since);
  const targets = [...new Map(reqs.map((x) => [x.target.id, x.target])).values()];
  const [weekly, stored] = await Promise.all([whereIn(col(uid, "lineups"), "weekOf", oldWeeks), targets.length ? db.getAll(...targets) : Promise.resolve([])]);

  const writes: Write[] = [];
  // Requests are named `${week}_${comicId}`: they move to the kept comic. If both already asked that week, the newer one wins.
  // Several dropped docs can ask the same week, so the winner per week is tracked across all of them, not just against what is stored.
  const best = new Map<string, number>(stored.map((s) => [s.id, (s.data() as SpotRequest | undefined)?.updatedAt ?? -1]));
  const setFor = new Map<string, Write>();
  for (const { d, r, target } of reqs) {
    moved.requests++;
    if ((best.get(target.id) ?? -1) < (r.updatedAt ?? 0)) {
      best.set(target.id, r.updatedAt ?? 0);
      setFor.set(target.id, (b) => b.set(target, { ...r, id: target.id, comicId: keep.id, comicName: merged.name }));
    }
    writes.push((b) => b.delete(d.ref));
  }
  writes.push(...setFor.values());
  for (const d of new Map([...recent, ...dated, ...weekly].map((x) => [x.id, x])).values()) {
    const patch = remapLineup(d.data() as Lineup, from, keep.id);
    if (patch) (moved.lineups++, writes.push((b) => b.update(d.ref, patch as Record<string, unknown>)));
  }
  for (const d of showDocs) {
    const patch = remapShow(d.data() as Show, from, keep.id);
    if (patch) (moved.shows++, writes.push((b) => b.update(d.ref, patch as Record<string, unknown>)));
  }
  for (const [name, docs] of [["offers", offerDocs], ["actions", actionDocs]] as const) {
    for (const d of docs) {
      moved[name]++;
      writes.push((b) => b.update(d.ref, { comicId: keep.id, comicName: merged.name }));
    }
  }
  writes.push((b) => b.set(col(uid, "comics").doc(keep.id), merged));
  for (const o of others) writes.push((b) => b.delete(col(uid, "comics").doc(o.id)));
  await commit(writes);
  return { merged: others.length, name: merged.name, moved };
}

// ---- Automatic merge of the safe cases ----
// The same phone number, or a phone id and the @lid of the same WhatsApp account, are one person by definition: merged without asking.
// Nothing is sent to anyone. (Two different numbers with the same name are only a suggestion in the app: "Same person".)
const running = new Set<string>();
const again = new Set<string>();
const timers = new Map<string, NodeJS.Timeout>();

/** An Updates card, the same shape commands.ts `notice` writes (not imported: that module pulls in the whole WhatsApp side). */
const notice = (uid: string, text: string) => col(uid, "notices").add({ level: "info", text, createdAt: Date.now(), read: false, expireAt: expireAt(TTL_DAYS.notices) });

export async function autoMergeDuplicates(uid: string): Promise<number> {
  if (running.has(uid)) {
    again.add(uid); // a roster change while this runs: look once more when it is done
    return 0;
  }
  running.add(uid);
  let merged = 0;
  try {
    const [comicDocs, showDocs, user] = await Promise.all([col(uid, "comics").get(), col(uid, "shows").get(), userRef(uid).get()]);
    const comics = comicDocs.docs.map((d) => ({ ...(d.data() as Comic), id: d.id }));
    const members = showDocs.docs.flatMap((d) => (d.data() as Show).groupMembers?.members ?? []);
    // Pairs the curator said are different people are never merged, whatever links them.
    const dismissed = new Set(((user.data()?.settings as Settings | undefined)?.dupDismissed ?? []).filter((k): k is string => typeof k === "string"));
    for (const set of findDuplicateComics(comics, linksFromMembers(members), memberKeySet(members), dismissed)) {
      try {
        merged += (await mergeComicDocs(uid, { keepId: set.keep.id, dropIds: set.others.map((o) => o.id) })).merged;
      } catch (e) {
        console.warn(`[merge] ${uid}: automatic merge into ${set.keep.id} failed`, (e as Error).message);
      }
    }
    if (merged) {
      console.log(`[merge] ${uid}: merged ${merged} duplicate contact${merged === 1 ? "" : "s"} (same number or same WhatsApp account)`);
      await notice(uid, `Merged ${merged} duplicate contact${merged === 1 ? "" : "s"} automatically (same WhatsApp account)`);
    }
  } catch (e) {
    console.warn("[merge] automatic merge failed", (e as Error).message);
  } finally {
    running.delete(uid);
    if (again.delete(uid)) scheduleAutoMerge(uid);
  }
  return merged;
}

/** Look for duplicates a little after a roster change (a new contact, a member refresh, the session coming up), once per burst. */
export function scheduleAutoMerge(uid: string, delayMs = 4000) {
  clearTimeout(timers.get(uid));
  const t = setTimeout(() => {
    timers.delete(uid);
    void autoMergeDuplicates(uid);
  }, delayMs);
  t.unref();
  timers.set(uid, t);
}
