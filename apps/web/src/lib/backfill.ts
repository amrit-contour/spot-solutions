// Backfill: record who actually performed on a show date that has already happened. Writes only history (the lineup record,
// each comic's history and lastPerformedWeek, a matching request). It creates no command, so the worker never sends,
// syncs a group, asks or posts anything for it. The pure rules are in @spot/shared backfill.ts.
import { runTransaction } from "firebase/firestore";
import { backfillAddSlot, backfillBase, backfillPatch, dateInWeek, lineupId, requestAfterBackfill, rolloverDayFor, toldAfterBackfill, waitingStatus, withHistory, type Comic, type Lineup, type Show, type SpotKind, type SpotRequest } from "@spot/shared";
import { db } from "@spot/ui/firebase";
import { userDoc } from "./data";
import { ensureComic } from "./lineup";

const ref = (uid: string, week: string, show: Show) => userDoc(uid, "lineups", lineupId(week, show.id));
const blank = (week: string, show: Show): Lineup => ({ id: lineupId(week, show.id), weekOf: week, showId: show.id, date: dateInWeek(week, show.weekday), slots: [], status: "draft", sentAt: null, groupSync: null });

/**
 * A past lineup that was never sent turns into a record the first time it's edited here. Slots it already had (placed before
 * the show, never confirmed) are recorded as regular spots too, so what's shown is what's in everyone's history. Reads first.
 */
async function readConversion(tx: import("firebase/firestore").Transaction, uid: string, cur: Lineup | undefined) {
  const out = new Map<string, Comic | undefined>();
  if (!cur || cur.status !== "draft") return out;
  for (const s of cur.slots) out.set(s.comicId, (await tx.get(userDoc(uid, "comics", s.comicId))).data() as Comic | undefined);
  return out;
}
function writeConversion(tx: import("firebase/firestore").Transaction, uid: string, cur: Lineup | undefined, olds: Map<string, Comic | undefined>, o: { date: string; week: string; show: Show; rolloverDay: ReturnType<typeof rolloverDayFor>; skip?: string }) {
  for (const s of cur?.slots ?? []) {
    if (s.comicId === o.skip) continue;
    tx.set(userDoc(uid, "comics", s.comicId), backfillPatch(olds.get(s.comicId), { date: o.date, weekOf: o.week, show: o.show, kind: s.adhoc ? "adhoc" : "regular", rolloverDay: o.rolloverDay }), { merge: true });
  }
}
const flagged = (slots: Lineup["slots"]) => slots.map((s) => ({ ...s, backfill: true }));

/** Put a comic on a past show as a regular or an ad hoc spot (or switch which). `shows` decides the week rollover. */
export async function backfillAdd(uid: string, week: string, show: Show, shows: Show[], comicId: string, kind: SpotKind, seed?: { name: string }) {
  await ensureComic(uid, week, comicId, seed);
  const date = dateInWeek(week, show.weekday);
  const rolloverDay = rolloverDayFor(shows);
  const lref = ref(uid, week, show);
  const cref = userDoc(uid, "comics", comicId);
  const rref = userDoc(uid, "requests", `${week}_${comicId}`);
  await runTransaction(db, async (tx) => {
    const cur = (await tx.get(lref)).data() as Lineup | undefined;
    const olds = await readConversion(tx, uid, cur);
    const comic = olds.has(comicId) ? olds.get(comicId) : ((await tx.get(cref)).data() as Comic | undefined);
    const req = (await tx.get(rref)).data() as SpotRequest | undefined;
    if (cur?.status === "cancelled" || cur?.status === "canned") throw new Error("This show didn't happen. Set it to \"Happened\" first.");
    const base = cur ?? blank(week, show);
    const converting = Object.keys(backfillBase(cur)).length > 0;
    const slots = backfillAddSlot(converting ? flagged(base.slots) : base.slots, comicId, kind, show);
    const sent = toldAfterBackfill(base, slots, show, comicId, Date.now());
    tx.set(lref, { ...base, ...backfillBase(cur), slots, ...(sent ? { sent } : {}) });
    if (converting) writeConversion(tx, uid, cur, olds, { date, week, show, rolloverDay, skip: comicId });
    tx.set(cref, backfillPatch(comic, { date, weekOf: week, show, kind, rolloverDay }), { merge: true });
    if (req && requestAfterBackfill(req)) tx.update(rref, { status: "confirmed", updatedAt: Date.now(), backfilledAt: Date.now() });
  });
}

/** Take a comic off a past show and out of their record. */
export async function backfillRemove(uid: string, week: string, show: Show, shows: Show[], comicId: string) {
  const date = dateInWeek(week, show.weekday);
  const rolloverDay = rolloverDayFor(shows);
  const lref = ref(uid, week, show);
  const cref = userDoc(uid, "comics", comicId);
  const rref = userDoc(uid, "requests", `${week}_${comicId}`);
  await runTransaction(db, async (tx) => {
    const cur = (await tx.get(lref)).data() as Lineup | undefined;
    const olds = await readConversion(tx, uid, cur);
    const comic = olds.has(comicId) ? olds.get(comicId) : ((await tx.get(cref)).data() as Comic | undefined);
    const req = (await tx.get(rref)).data() as SpotRequest | undefined;
    if (!cur?.slots.some((s) => s.comicId === comicId)) return;
    const converting = Object.keys(backfillBase(cur)).length > 0;
    const rest = cur.slots.filter((s) => s.comicId !== comicId);
    const slots = converting ? flagged(rest) : rest;
    const sent = toldAfterBackfill(cur, slots, show, comicId, Date.now());
    tx.update(lref, { slots, ...backfillBase(cur), ...(sent ? { sent } : {}) });
    if (converting) writeConversion(tx, uid, cur, olds, { date, week, show, rolloverDay, skip: comicId });
    if (comic) tx.set(cref, backfillPatch(comic, { date, weekOf: week, show, kind: null, rolloverDay }), { merge: true });
    // Only a request this backfill settled is reopened.
    if (req?.backfilledAt) tx.update(rref, { status: waitingStatus(req), updatedAt: Date.now(), backfilledAt: null });
  });
}

/** Did the past show happen? Setting "didn't happen" keeps the comics on it but stops it counting for anyone. */
export async function backfillOutcome(uid: string, week: string, show: Show, shows: Show[], outcome: "happened" | "canned") {
  const date = dateInWeek(week, show.weekday);
  const rolloverDay = rolloverDayFor(shows);
  const lref = ref(uid, week, show);
  const cur = await runTransaction(db, async (tx) => {
    const l = (await tx.get(lref)).data() as Lineup | undefined;
    const base = l ?? blank(week, show);
    const comics = new Map<string, Comic | undefined>();
    for (const s of base.slots) comics.set(s.comicId, (await tx.get(userDoc(uid, "comics", s.comicId))).data() as Comic | undefined);
    const flag = l && l.status !== "draft" && !l.backfilled ? {} : { backfilled: true, sentAt: null, groupSync: null };
    if (outcome === "canned") {
      tx.set(lref, { ...base, ...flag, ...(flag.backfilled ? { slots: flagged(base.slots) } : {}), status: "canned", outcome });
      for (const s of base.slots) {
        const c = comics.get(s.comicId);
        tx.set(userDoc(uid, "comics", s.comicId), { history: withHistory(c?.history, { date, showId: show.id, showName: show.name, status: "canned" }), ...(c?.lastPerformedWeek === week ? { lastPerformedWeek: null } : {}) }, { merge: true });
      }
    } else {
      tx.set(lref, { ...base, ...flag, ...(flag.backfilled ? { slots: flagged(base.slots) } : {}), status: "confirmed", outcome });
      for (const s of base.slots) tx.set(userDoc(uid, "comics", s.comicId), backfillPatch(comics.get(s.comicId), { date, weekOf: week, show, kind: s.adhoc ? "adhoc" : "regular", rolloverDay }), { merge: true });
    }
    return base;
  });
  return cur;
}

