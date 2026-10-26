// Putting a comic on a lineup (or taking them off) from the worker, with the same rules as the app's own placing
// (apps/web/src/lib/lineup.ts placeComic / unplaceComic): one show per week, an edit to a confirmed lineup records what was
// already sent first, the request moves to "assigned" and back. The agent number uses these; nothing here messages anyone.
import { dateInWeek, lineupId, movesOffOtherShows, planReconcilePlace, sentSnapshot, type Comic, type Lineup, type Show, type SpotRequest } from "@spot/shared";
import { watchUser } from "./userData.ts";
import { col, db } from "./firebase.ts";

const blank = (week: string, show: Show): Lineup => ({ id: lineupId(week, show.id), weekOf: week, showId: show.id, date: dateInWeek(week, show.weekday), slots: [], status: "draft", sentAt: null, groupSync: null });

/** Maybe asks and group members aren't comics yet; placing one makes them one. */
async function ensureComic(uid: string, week: string, person: { id: string; name: string; phone?: string }) {
  const ref = col(uid, "comics").doc(person.id);
  if ((await ref.get()).exists) return;
  const req = (await col(uid, "requests").doc(`${week}_${person.id}`).get()).data() as SpotRequest | undefined;
  const c: Comic = req
    ? { id: person.id, chatId: req.contact?.chatId ?? person.id, name: req.comicName, nameSource: req.contact?.nameSource ?? "whatsapp", phone: req.contact?.phone ?? person.id.split("@")[0], tier: "open", lastPerformedWeek: null, regularOf: [] }
    : { id: person.id, chatId: person.id, name: person.name, nameSource: "whatsapp", phone: person.phone ?? (person.id.endsWith("@c.us") ? person.id.split("@")[0] : ""), tier: "open", lastPerformedWeek: null, regularOf: [] };
  await ref.set(c, { merge: true });
}

async function markRequest(uid: string, week: string, comicId: string, placed: boolean) {
  const ref = col(uid, "requests").doc(`${week}_${comicId}`);
  const r = (await ref.get()).data() as SpotRequest | undefined;
  if (!r || r.status === "confirmed") return;
  await ref.update({ status: placed ? "assigned" : r.ackedAt ? "acked" : "new", updatedAt: Date.now() });
}

export type PlaceResult = { outcome: "placed" | "already" | "full" | "called_off"; movedFrom?: string };

/** Add a comic to `show`'s lineup for `week`. Refuses (writes nothing) when the show is full or called off. */
export async function placeOnLineup(uid: string, week: string, show: Show, shows: Show[], person: { id: string; name: string; phone?: string }): Promise<PlaceResult> {
  await ensureComic(uid, week, person);
  const now = Date.now();
  const res = await db.runTransaction(async (tx) => {
    const weekSnap = await tx.get(col(uid, "lineups").where("weekOf", "==", week));
    const lineups = weekSnap.docs.map((d) => ({ ...(d.data() as Lineup), id: d.id }));
    const cur = lineups.find((l) => l.showId === show.id);
    const plan = planReconcilePlace({ lineup: cur ?? null, show, comicId: person.id, markTold: false, now });
    if (plan.outcome === "full" || plan.outcome === "called_off") return { outcome: plan.outcome } as PlaceResult;
    let movedFrom: string | undefined;
    // With "One show per week" on, they come off their other show (POCs, regulars and co-hosts never do).
    const moveOff = movesOffOtherShows(watchUser(uid).settings.rules, show, person.id);
    for (const l of moveOff ? lineups : []) {
      if (l.showId === show.id || l.status === "cancelled" || l.status === "canned" || !l.slots.some((s) => s.comicId === person.id)) continue;
      const other = shows.find((s) => s.id === l.showId);
      const record = l.status === "confirmed" && !l.sent && other ? { sent: sentSnapshot(l.slots, other, l.sentAt ?? now) } : {};
      tx.update(col(uid, "lineups").doc(l.id), { ...record, slots: l.slots.filter((s) => s.comicId !== person.id) });
      movedFrom = other?.name;
    }
    if (plan.outcome === "placed") tx.set(col(uid, "lineups").doc(lineupId(week, show.id)), { ...(cur ?? blank(week, show)), slots: plan.slots, ...(plan.sent ? { sent: plan.sent } : {}) });
    return { outcome: plan.outcome, movedFrom } as PlaceResult;
  });
  if (res.outcome === "placed" || res.outcome === "already") await markRequest(uid, week, person.id, true);
  return res;
}

/** Take a comic off `show`'s lineup. True when they were on it. */
export async function removeFromLineup(uid: string, week: string, show: Show, comicId: string): Promise<boolean> {
  const ref = col(uid, "lineups").doc(lineupId(week, show.id));
  const now = Date.now();
  const removed = await db.runTransaction(async (tx) => {
    const cur = (await tx.get(ref)).data() as Lineup | undefined;
    if (!cur?.slots.some((s) => s.comicId === comicId)) return false;
    const record = cur.status === "confirmed" && !cur.sent ? { sent: sentSnapshot(cur.slots, show, cur.sentAt ?? now) } : {};
    tx.update(ref, { ...record, slots: cur.slots.filter((s) => s.comicId !== comicId) });
    return true;
  });
  if (removed) await markRequest(uid, week, comicId, false);
  return removed;
}
