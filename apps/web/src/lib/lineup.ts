import { arrayRemove, arrayUnion, getDoc, runTransaction, setDoc, updateDoc } from "firebase/firestore";
import { dateInWeek, lineupId, planReconcilePlace, sentSnapshot, shiftWeek, withHistory, type Comic, type Lineup, type Show, type Slot, type SpotRequest } from "@spot/shared";
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

/**
 * Write a show's full slot list for the week. Moves between shows call this twice.
 * A confirmed lineup can be edited: the first edit records what was sent (lineups confirmed before that was tracked
 * have no record), so "Changed since confirmed" and Send updates always compare against what the comics were told.
 */
export async function setSlots(uid: string, week: string, show: Show, slots: Slot[]) {
  const ref = lineupRef(uid, week, show.id);
  await runTransaction(db, async (tx) => {
    const cur = (await tx.get(ref)).data() as Lineup | undefined;
    const record = cur?.status === "confirmed" && !cur.sent ? { sent: sentSnapshot(cur.slots, show, cur.sentAt ?? Date.now()) } : {};
    tx.set(ref, { ...(cur ?? blank(week, show)), ...record, slots });
  });
}

/** Maybe asks and group members aren't comics yet; placing one makes them one, from the request or the group list. */
async function ensureComic(uid: string, week: string, comicId: string, fallback?: { name: string }) {
  const ref = userDoc(uid, "comics", comicId);
  if ((await getDoc(ref)).exists()) return;
  const req = (await getDoc(userDoc(uid, "requests", `${week}_${comicId}`))).data() as SpotRequest | undefined;
  if (!req) {
    if (!fallback) return;
    const phone = comicId.endsWith("@c.us") ? comicId.split("@")[0] : "";
    const c: Comic = { id: comicId, chatId: comicId, name: fallback.name || (phone ? `+${phone}` : "Group member"), nameSource: "whatsapp", phone, tier: "open", lastPerformedWeek: null, regularOf: [] };
    await setDoc(ref, c, { merge: true });
    return;
  }
  const c: Comic = { id: comicId, chatId: req.contact?.chatId ?? comicId, name: req.comicName, nameSource: req.contact?.nameSource ?? "whatsapp", phone: req.contact?.phone ?? comicId.split("@")[0], tier: "open", lastPerformedWeek: null, regularOf: [] };
  await setDoc(ref, c, { merge: true });
}

export async function placeComic(uid: string, week: string, show: Show, comicId: string, lineups: Lineup[], shows: Show[] = [], seed?: { name: string }) {
  await ensureComic(uid, week, comicId, seed);
  // A comic sits in at most one show per week.
  for (const l of lineups) {
    if (l.showId !== show.id && l.slots.some((s) => s.comicId === comicId) && l.status !== "cancelled" && l.status !== "canned") {
      const other = shows.find((s) => s.id === l.showId);
      const rest = l.slots.filter((s) => s.comicId !== comicId);
      if (other) await setSlots(uid, week, other, rest);
      else await updateDoc(lineupRef(uid, week, l.showId), { slots: rest });
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

/** Change one comic's set length on a show's lineup. */
export function setMinutes(uid: string, week: string, show: Show, lineup: Lineup, comicId: string, minutes: number) {
  return setSlots(uid, week, show, lineup.slots.map((s) => (s.comicId === comicId ? { ...s, minutes } : s)));
}

/** Members marked to leave the group on the next sync, for this week's lineup. */
export async function setGroupLeaving(uid: string, week: string, show: Show, ids: string[]) {
  const ref = lineupRef(uid, week, show.id);
  const cur = (await getDoc(ref)).data() as Lineup | undefined;
  await setDoc(ref, { ...(cur ?? blank(week, show)), groupLeaving: ids });
}

/** Regular / Co-host tags live on the show. Taking someone out of the group drops both (`off`). */
export function tagMember(uid: string, show: Show, comicId: string, tag: "regulars" | "protected", on: boolean) {
  return updateDoc(userDoc(uid, "shows", show.id), { [tag]: on ? arrayUnion(comicId) : arrayRemove(comicId) });
}
export function untagMember(uid: string, show: Show, comicId: string) {
  return updateDoc(userDoc(uid, "shows", show.id), { regulars: arrayRemove(comicId), protected: arrayRemove(comicId) });
}

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

/** The mic was meant to happen but didn't: it shouldn't count as anyone's spot. */
export async function markCanned(uid: string, lineup: Lineup, show: Show, comics: Map<string, import("@spot/shared").Comic>) {
  const date = dateInWeek(lineup.weekOf, show.weekday);
  await updateDoc(lineupRef(uid, lineup.weekOf, show.id), { status: "canned" });
  await Promise.all(
    lineup.slots.map((s) => {
      const c = comics.get(s.comicId);
      const history = withHistory(c?.history, { date, showId: show.id, showName: show.name, status: "canned" });
      return setDoc(userDoc(uid, "comics", s.comicId), { history, ...(c?.lastPerformedWeek === lineup.weekOf ? { lastPerformedWeek: null } : {}) }, { merge: true });
    }),
  );
}

/**
 * The first time a week's lineup is opened, start it with the show's regulars, co-hosts and group admins.
 * Runs once per lineup (the doc then exists), so taking someone off for a night sticks.
 */
export async function seedDefaults(uid: string, week: string, show: Show, people: { id: string; name: string }[]) {
  if (!people.length) return 0;
  const ref = lineupRef(uid, week, show.id);
  const picked = people.slice(0, show.slotCount);
  const created = await runTransaction(db, async (tx) => {
    if ((await tx.get(ref)).exists()) return false;
    tx.set(ref, { ...blank(week, show), defaultsSeeded: true, slots: picked.map((p) => ({ comicId: p.id, minutes: show.includeSlotTime ? (show.defaultMinutes ?? null) : null })) });
    return true;
  });
  if (!created) return 0;
  await Promise.all(picked.map((p) => ensureComic(uid, week, p.id, { name: p.name })));
  return picked.length;
}

/**
 * Put someone on a lineup as already told: you gave them the spot yourself (and added them to the group),
 * so Confirm & send and Send updates won't message them. Records the spot in their history like a confirmation.
 */
export async function placeAsTold(uid: string, week: string, show: Show, comicId: string, lineups: Lineup[], name: string) {
  // Off any other show this week first, the same way placeComic does.
  for (const l of lineups) {
    if (l.showId !== show.id && l.slots.some((s) => s.comicId === comicId) && l.status !== "cancelled" && l.status !== "canned") {
      await updateDoc(lineupRef(uid, week, l.showId), { slots: l.slots.filter((s) => s.comicId !== comicId) });
    }
  }
  await ensureComic(uid, week, comicId, { name });
  const ref = lineupRef(uid, week, show.id);
  const outcome = await runTransaction(db, async (tx) => {
    const cur = (await tx.get(ref)).data() as Lineup | undefined;
    const plan = planReconcilePlace({ lineup: cur ?? null, show, comicId, markTold: true, now: Date.now() });
    if (plan.outcome === "full" || plan.outcome === "called_off") return plan.outcome;
    tx.set(ref, { ...(cur ?? blank(week, show)), slots: plan.slots, ...(plan.sent ? { sent: plan.sent } : {}) });
    const comicRef = userDoc(uid, "comics", comicId);
    const comic = (await tx.get(comicRef)).data() as Comic | undefined;
    tx.set(comicRef, { lastPerformedWeek: week, history: withHistory(comic?.history, { date: dateInWeek(week, show.weekday), showId: show.id, showName: show.name, status: "confirmed" }) }, { merge: true });
    return plan.outcome;
  });
  if (outcome === "full") throw new Error(`${show.name} is full`);
  if (outcome === "called_off") throw new Error(`${show.name} is called off this week`);
  // Their request (if any) is settled: you already told them.
  const req = await getDoc(requestRef(uid, week, comicId));
  if (req.exists() && ["new", "acked", "assigned"].includes((req.data() as SpotRequest).status)) await updateDoc(req.ref, { status: "confirmed", updatedAt: Date.now() });
}
