// Community rosters, the Firestore side: published rosters, follows, suggestions, publishers, shares, and the one callable.
// The pure rules (what a push changes, applying a suggestion) are in @spot/shared (rosterCommunity.ts).
import { getApp } from "firebase/app";
import { onAuthStateChanged, type User } from "firebase/auth";
import {
  collection, deleteDoc, doc, getCountFromServer, onSnapshot, query, runTransaction, setDoc, updateDoc, where, writeBatch,
} from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { useEffect, useMemo, useState } from "react";
import {
  CHANGELOG_KEEP, applySuggestion, buildPushDoc, describeSuggestion, hasUpdate, shareableRoster, toSharedRoster,
  type PublishedRosterDoc, type Publisher, type Roster, type RosterChange, type RosterFollow, type RosterSuggestion, type SharedRoster, type SuggestionDraft,
} from "@spot/shared";
import { auth, db } from "@spot/ui/firebase";
import { useCollection, userDoc } from "./data";
import { plain } from "./roster";

export { hasUpdate };

// ---------------------------------------------------------------------------------------------------------------------------
// Who is signed in: allowed (approved or admin), and admin
// ---------------------------------------------------------------------------------------------------------------------------

export type Membership = { state: "loading" } | { state: "allowed"; admin: boolean } | { state: "pending" } | { state: "denied" };

/**
 * Published rosters are for approved members only (firestore.rules), so the pages check first instead of hitting a permission error.
 * Asks for access on first sign-in, the same way the curator app does; an admin approves it there.
 */
export function useMembership(user: User | null): Membership {
  const [entry, setEntry] = useState<{ status?: string } | null | undefined>(undefined);
  const [admins, setAdmins] = useState<string[] | undefined>(undefined);
  useEffect(() => {
    if (!user) return;
    const ref = doc(db, "access", user.uid);
    return onSnapshot(
      ref,
      (s) => {
        if (s.exists()) return setEntry(s.data() as { status?: string });
        setEntry(null);
        void setDoc(ref, { uid: user.uid, email: user.email?.toLowerCase() ?? null, name: user.displayName, photo: user.photoURL, status: "pending", requestedAt: Date.now() }).catch(() => undefined);
      },
      () => setEntry(null),
    );
  }, [user]);
  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "config", "access"), (s) => setAdmins(((s.data()?.admins as string[]) ?? []).map((a) => a.toLowerCase())), () => setAdmins([]));
  }, [user]);
  return useMemo<Membership>(() => {
    if (!user) return { state: "denied" };
    if (entry === undefined || admins === undefined) return { state: "loading" };
    const admin = Boolean(user.email && user.emailVerified && admins.includes(user.email.toLowerCase()));
    if (admin || entry?.status === "approved") return { state: "allowed", admin };
    return entry?.status === "removed" ? { state: "denied" } : { state: "pending" };
  }, [entry, admins, user]);
}

/** The signed-in user (null in the dev-only route that has no sign-in). */
export function useMe() {
  const [user, setUser] = useState<User | null>(auth.currentUser);
  useEffect(() => onAuthStateChanged(auth, setUser), []);
  return user;
}

/** For the Rooms page menu: may I share, may I publish. Both false without a sign-in or approval. */
export function useCommunity() {
  const user = useMe();
  const membership = useMembership(user);
  const allowed = membership.state === "allowed";
  const publishers = usePublishers(allowed);
  const admin = membership.state === "allowed" && membership.admin;
  return { user, membership, allowed, admin, canPublish: allowed && (admin || publishers.data.some((p) => p.uid === user?.uid)) };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Published rosters
// ---------------------------------------------------------------------------------------------------------------------------

const rosterRef = (id: string) => doc(db, "publishedRosters", id);

export function usePublishedRosters() {
  const [state, setState] = useState<{ data: PublishedRosterDoc[]; loading: boolean }>({ data: [], loading: true });
  useEffect(
    () =>
      onSnapshot(
        collection(db, "publishedRosters"),
        (q) => setState({ data: q.docs.map((d) => ({ ...(d.data() as PublishedRosterDoc), id: d.id })), loading: false }),
        (e) => {
          console.error("publishedRosters", e);
          setState({ data: [], loading: false });
        },
      ),
    [],
  );
  return state;
}

/** One roster, live. `null` once loaded and missing (or unreadable). */
export function usePublishedRoster(id: string | undefined) {
  const [state, setState] = useState<{ roster: PublishedRosterDoc | null; loading: boolean }>({ roster: null, loading: true });
  useEffect(() => {
    if (!id) return;
    setState((s) => ({ ...s, loading: true }));
    return onSnapshot(
      rosterRef(id),
      (s) => setState({ roster: s.exists() ? { ...(s.data() as PublishedRosterDoc), id: s.id } : null, loading: false }),
      () => setState({ roster: null, loading: false }),
    );
  }, [id]);
  return state;
}

/** How many follow each roster. Re-counted when `refreshKey` changes (my own follow, say). */
export function useFollowerCounts(ids: string[], refreshKey = "") {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const key = ids.join("|");
  useEffect(() => {
    let live = true;
    void Promise.all(
      ids.map(async (id) => {
        try {
          return [id, (await getCountFromServer(collection(db, "publishedRosters", id, "followers"))).data().count] as const;
        } catch (e) {
          console.warn("followers count", id, e);
          return [id, 0] as const;
        }
      }),
    ).then((rows) => live && setCounts(Object.fromEntries(rows)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshKey]);
  return counts;
}

/** One roster's follower count, live (the detail page: Follow shows up at once). */
export function useFollowerCount(id: string | undefined) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!id) return;
    return onSnapshot(collection(db, "publishedRosters", id, "followers"), (q) => setN(q.size), () => setN(0));
  }, [id]);
  return n;
}

export function useFollows(uid: string) {
  const { data, loading } = useCollection<RosterFollow & { id: string }>(uid, "rosterFollows");
  const byId = useMemo(() => new Map(data.map((f) => [f.id, f])), [data]);
  return { follows: byId, loading };
}

/** Follow: remember the version I have seen (so "update available" means newer than this) and be counted. */
export async function followRoster(user: User, roster: Pick<PublishedRosterDoc, "id" | "version">) {
  const batch = writeBatch(db);
  batch.set(userDoc(user.uid, "rosterFollows", roster.id), { rosterId: roster.id, seenVersion: roster.version, followedAt: Date.now() } satisfies RosterFollow);
  batch.set(doc(db, "publishedRosters", roster.id, "followers", user.uid), { uid: user.uid, name: user.displayName ?? user.email ?? "Comic", at: Date.now() });
  await batch.commit();
}
export async function unfollowRoster(uid: string, rosterId: string) {
  const batch = writeBatch(db);
  batch.delete(userDoc(uid, "rosterFollows", rosterId));
  batch.delete(doc(db, "publishedRosters", rosterId, "followers", uid));
  await batch.commit();
}
/** I have looked at this version (merged it or dismissed it): no more "update available" until the next one. */
export const markSeen = (uid: string, rosterId: string, version: number) => updateDoc(userDoc(uid, "rosterFollows", rosterId), { seenVersion: version });

// ---------------------------------------------------------------------------------------------------------------------------
// Publishing: push my rooms to a published roster
// ---------------------------------------------------------------------------------------------------------------------------

export class StaleRosterError extends Error {}

/**
 * Write the push. `basedOn` is the version the publisher reviewed; if the roster moved on since (a suggestion was approved),
 * nothing is written, so a review is never applied to a different roster than the one it was made for.
 */
export async function pushRoster(args: {
  id: string;
  basedOn: number | null;
  next: SharedRoster;
  changes: RosterChange[];
  picked: string[];
  title: string;
  city: string;
  user: User;
  note?: string;
}) {
  const ref = rosterRef(args.id);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists() ? ({ ...(snap.data() as PublishedRosterDoc), id: snap.id } as PublishedRosterDoc) : null;
    if ((current?.version ?? null) !== args.basedOn) throw new StaleRosterError();
    const body = buildPushDoc({
      current, next: args.next, changes: args.changes, picked: args.picked, title: args.title, city: args.city,
      ownerUid: args.user.uid, ownerName: args.user.displayName ?? undefined, note: args.note, now: Date.now(),
    });
    tx.set(ref, plain(body));
    return body.version;
  });
}

export const unpublishRoster = (id: string) => deleteDoc(rosterRef(id));

// ---------------------------------------------------------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------------------------------------------------------

/** Maintainers see every suggestion; everyone else only their own (the rules require the query to say so). */
export function useSuggestions(rosterId: string, uid: string, maintainer: boolean) {
  const [state, setState] = useState<{ data: RosterSuggestion[]; loading: boolean }>({ data: [], loading: true });
  useEffect(() => {
    const col = collection(db, "publishedRosters", rosterId, "suggestions");
    return onSnapshot(
      maintainer ? col : query(col, where("byUid", "==", uid)),
      (q) => setState({ data: q.docs.map((d) => ({ ...(d.data() as RosterSuggestion), id: d.id })).sort((a, b) => b.createdAt - a.createdAt), loading: false }),
      (e) => {
        console.error("suggestions", e);
        setState({ data: [], loading: false });
      },
    );
  }, [rosterId, uid, maintainer]);
  return state;
}

export async function sendSuggestion(roster: Pick<PublishedRosterDoc, "id" | "version">, draft: SuggestionDraft, user: User) {
  const ref = doc(collection(db, "publishedRosters", roster.id, "suggestions"));
  const body: Omit<RosterSuggestion, "id"> = {
    byUid: user.uid,
    ...(user.displayName ? { byName: user.displayName } : {}),
    ...plain(draft),
    baseVersion: roster.version,
    status: "pending",
    createdAt: Date.now(),
  };
  await setDoc(ref, plain(body));
}

/** Approve: apply it to the published roster, bump the version and add a changelog line, and mark it, all or nothing. */
export async function approveSuggestion(rosterId: string, suggestionId: string, user: User) {
  const rRef = rosterRef(rosterId);
  const sRef = doc(db, "publishedRosters", rosterId, "suggestions", suggestionId);
  return runTransaction(db, async (tx) => {
    const [rSnap, sSnap] = await Promise.all([tx.get(rRef), tx.get(sRef)]);
    if (!rSnap.exists() || !sSnap.exists()) throw new Error("That suggestion is gone.");
    const roster = rSnap.data() as PublishedRosterDoc;
    const s = { ...(sSnap.data() as RosterSuggestion), id: sSnap.id };
    if (s.status !== "pending") throw new Error("That suggestion was already decided.");
    const applied = applySuggestion(toSharedRoster(roster), s);
    if (!applied.ok) throw new Error(applied.reason);
    const version = roster.version + 1;
    const d = describeSuggestion(s, toSharedRoster(roster));
    const entry = { version, at: Date.now(), text: `${d.where}: ${d.what}${s.byName ? ` (suggested by ${s.byName})` : ""}`, by: user.displayName ?? "A maintainer" };
    tx.update(rRef, plain({ rooms: applied.roster.rooms, curators: applied.roster.curators, version, updatedAt: Date.now(), changelog: [entry, ...(roster.changelog ?? [])].slice(0, CHANGELOG_KEEP) }));
    tx.update(sRef, { status: "approved", decidedBy: user.uid, decidedAt: Date.now() });
    return version;
  });
}
export const rejectSuggestion = (rosterId: string, suggestionId: string, user: User) =>
  updateDoc(doc(db, "publishedRosters", rosterId, "suggestions", suggestionId), { status: "rejected", decidedBy: user.uid, decidedAt: Date.now() });
export const withdrawSuggestion = (rosterId: string, suggestionId: string) => deleteDoc(doc(db, "publishedRosters", rosterId, "suggestions", suggestionId));

// ---------------------------------------------------------------------------------------------------------------------------
// People: lookups by email, co-maintainers, publishers, shares
// ---------------------------------------------------------------------------------------------------------------------------

export interface Member {
  uid: string;
  email: string;
  name?: string;
}

/** Another approved member by email (a callable: the app can't read other people's access records). Throws with a message to show. */
export async function lookupMember(email: string): Promise<Member> {
  try {
    return (await httpsCallable<{ email: string }, Member>(getFunctions(getApp(), "asia-south1"), "lookupRosterUser")({ email })).data;
  } catch (e) {
    const msg = (e as { message?: string }).message;
    throw new Error(msg && !/^internal$/i.test(msg) ? msg : "Couldn't look that up. Check your connection and try again.");
  }
}

/** Owner only (the rules): who else approves suggestions. */
export function setCoMaintainers(roster: Pick<PublishedRosterDoc, "id">, uids: string[], names: Record<string, string>) {
  return updateDoc(rosterRef(roster.id), { coMaintainers: uids, maintainerNames: names });
}

export function usePublishers(enabled = true) {
  const [state, setState] = useState<{ data: Publisher[]; loading: boolean }>({ data: [], loading: true });
  useEffect(() => {
    if (!enabled) return;
    return onSnapshot(
      collection(db, "publishers"),
      (q) => setState({ data: q.docs.map((d) => ({ ...(d.data() as Publisher), uid: d.id })).sort((a, b) => a.addedAt - b.addedAt), loading: false }),
      () => setState({ data: [], loading: false }),
    );
  }, [enabled]);
  return state;
}
export const addPublisher = (m: Member, by: string) => setDoc(doc(db, "publishers", m.uid), plain({ uid: m.uid, email: m.email, name: m.name, addedBy: by, addedAt: Date.now() }));
export const removePublisher = (uid: string) => deleteDoc(doc(db, "publishers", uid));

export interface RosterShare {
  id: string;
  fromUid: string;
  fromName?: string;
  title: string;
  note?: string;
  rooms: SharedRoster["rooms"];
  curators: SharedRoster["curators"];
  createdAt: number;
}

export const useShares = (uid: string) => useCollection<RosterShare>(uid, "rosterShares");

/** A snapshot of the picked rooms (shareable fields only) into one member's inbox. */
export async function sendShare(to: Member, from: User, args: { title: string; note?: string; roster: Roster }) {
  const snap = shareableRoster(args.roster);
  await setDoc(
    doc(collection(db, "users", to.uid, "rosterShares")),
    plain({ fromUid: from.uid, fromName: from.displayName ?? from.email ?? undefined, title: args.title.trim(), note: args.note?.trim() || undefined, rooms: snap.rooms, curators: snap.curators, createdAt: Date.now() }),
  );
}
export const deleteShare = (uid: string, id: string) => deleteDoc(userDoc(uid, "rosterShares", id));
