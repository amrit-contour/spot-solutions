// The comic's group alerts: live data from Firestore (users/{uid}/spotAlerts, groupUpdates, watchedGroups, groups) and what the
// comic does with it. The worker writes alerts and updates; the comic clears them. Pure rules live in @spot/shared (groupAlerts.ts).
import { useEffect, useState } from "react";
import { deleteDoc, deleteField, doc, onSnapshot, setDoc, updateDoc } from "firebase/firestore";
import { db } from "@spot/ui/firebase";
import {
  DEFAULT_SETTINGS,
  type StoredAlertRules,
  alertState,
  applyClosureToRoom,
  applyScheduleToRoom,
  type Curator,
  type GroupInfo,
  type GroupUpdate,
  type MySpot,
  type Room,
  type SpotAlert,
  type WatchedGroup,
} from "@spot/shared";
import { useCollection, userDoc } from "./data";
import { plain } from "./roster";

/** The comic's time zone for "today" and offer times. */
export const TZ = DEFAULT_SETTINGS.timezone;

export const useSpotAlerts = (uid: string) => useCollection<SpotAlert>(uid, "spotAlerts");
export const useGroupUpdates = (uid: string) => useCollection<GroupUpdate>(uid, "groupUpdates");
export const useWatchedGroups = (uid: string) => useCollection<WatchedGroup>(uid, "watchedGroups");
/** Every WhatsApp group on the comic's account, as the server last listed them (list_groups). */
export const useAllGroups = (uid: string) => useCollection<GroupInfo>(uid, "groups");
export const useMySpotList = (uid: string) => useCollection<MySpot>(uid, "mySpots");

/** A clock that ticks, so "34 min left" counts down. */
export function useClock(everyMs = 20_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

export interface ComicSettings {
  /** Closures and curator schedules read from groups are applied by themselves; off: they wait in Alerts for a tap. */
  autoApplyGroupUpdates?: boolean;
  /** Edits to the rules that decide which group messages push at once (only what differs from the defaults). */
  alertRules?: StoredAlertRules;
}

/** users/{uid}.comicSettings, live. `set` merges a change. */
export function useComicSettings(uid: string) {
  const [settings, setSettings] = useState<ComicSettings>({});
  const [loading, setLoading] = useState(true);
  useEffect(
    () =>
      onSnapshot(
        doc(db, "users", uid),
        (s) => {
          setSettings((s.data()?.comicSettings as ComicSettings | undefined) ?? {});
          setLoading(false);
        },
        () => setLoading(false),
      ),
    [uid],
  );
  const set = (patch: ComicSettings) => setDoc(doc(db, "users", uid), { comicSettings: patch }, { merge: true });
  return { settings, loading, set };
}

/** Save the alert rules (only the changes); an empty object puts everything back to the defaults. */
export const saveAlertRules = (uid: string, stored: StoredAlertRules) =>
  setDoc(doc(db, "users", uid), { comicSettings: { alertRules: Object.keys(stored).length ? stored : deleteField() } }, { merge: true });

/** Only the groups switched on are read by the server. Off removes the document, and with it the permission. */
export async function setWatched(uid: string, group: { id: string; name: string }, on: boolean) {
  const ref = userDoc(uid, "watchedGroups", group.id);
  if (on) await setDoc(ref, { id: group.id, name: group.name, addedAt: Date.now() } satisfies WatchedGroup);
  else await deleteDoc(ref);
}

export const dismissAlert = (uid: string, id: string) => updateDoc(userDoc(uid, "spotAlerts", id), { status: "dismissed" });

/** "I got it": the spot goes into My spots, from a group offer. */
export async function gotTheSpot(uid: string, a: SpotAlert, time: string | undefined) {
  const id = `alert_${a.id}`.slice(0, 200);
  const spot: MySpot = plain({ id, date: a.date, time, roomId: a.roomId, roomName: a.roomName, showId: a.showId, source: "group_offer", alertId: a.id, happened: null, status: "booked", createdAt: Date.now() });
  const { id: _id, ...rest } = spot;
  await setDoc(userDoc(uid, "mySpots", id), rest);
}

export const dismissUpdate = (uid: string, id: string) => updateDoc(userDoc(uid, "groupUpdates", id), { status: "dismissed" });

/** Applies a closure or curator schedule the comic reviewed, to their own roster only (never a published one). */
export async function applyUpdate(
  uid: string,
  u: GroupUpdate,
  roster: { rooms: Room[]; curators: Curator[]; saveRoom(r: Room): Promise<void>; saveCurator(c: Curator): Promise<void> },
) {
  const room = roster.rooms.find((r) => r.id === u.roomId);
  if (!room) throw new Error("That room isn't in your list any more.");
  if (u.kind === "closure" && u.closure) {
    await roster.saveRoom(applyClosureToRoom(room, u.closure.ranges, { groupId: u.groupId, messageId: u.messageId, at: Date.now(), showId: u.closure.showId }));
  } else if (u.kind === "schedule" && u.schedule) {
    const out = applyScheduleToRoom(room, roster.curators, u.schedule.entries);
    const known = new Set(roster.curators.map((c) => c.id));
    await roster.saveRoom(out.room);
    for (const c of out.curators) if (!known.has(c.id)) await roster.saveCurator(c);
  }
  await updateDoc(userDoc(uid, "groupUpdates", u.id), { status: "applied", appliedAt: Date.now(), auto: false });
}

/** What the lists show. Dismissed ones go; closed, ended and asked ones stay a while as history. */
export function splitAlerts(alerts: SpotAlert[], now: number) {
  const open = alerts.filter((a) => ["open", "asked"].includes(alertState(a, now))).sort((a, b) => a.expiresAt - b.expiresAt);
  const earlier = alerts.filter((a) => ["closed", "expired"].includes(alertState(a, now))).sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 15);
  return { open, earlier };
}
