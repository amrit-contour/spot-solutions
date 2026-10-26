// Firestore side of googleContacts.ts (Admin SDK). Everything here except googleLink/status is closed to clients.
//   users/{uid}/private/google          { enc, email, since }    refresh token, encrypted. No rule lets a client read it.
//   users/{uid}/googleLink/status       { state, email, since }  what the app shows. Owner can read, nobody can write.
//   googleSyncQueue/{uid}               QueueDoc                  comic edits waiting to be written. Closed to clients.
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import type { SyncComic } from "./contactsShared";
import type { GcStore, LinkRecord } from "./googleContacts";
import { LEASE_MS, afterFailure, afterRun, enqueue, isDue, nextTaskAt, type QueueDoc } from "./googleLogic";

const NOTICE_TTL_MS = 30 * 24 * 3_600_000;

export function firestoreGcStore(db = getFirestore()): GcStore {
  const tokenDoc = (uid: string) => db.doc(`users/${uid}/private/google`);
  const statusDoc = (uid: string) => db.doc(`users/${uid}/googleLink/status`);
  const queue = db.collection("googleSyncQueue");
  return {
    async getLink(uid) {
      return ((await tokenDoc(uid).get()).data() as LinkRecord | undefined) ?? null;
    },
    async putLink(uid, rec) {
      const batch = db.batch();
      batch.set(tokenDoc(uid), rec);
      batch.set(statusDoc(uid), { state: "connected", email: rec.email, since: rec.since });
      await batch.commit();
    },
    async removeLink(uid, why) {
      const prev = (await statusDoc(uid).get()).data() as { email?: string } | undefined;
      const batch = db.batch();
      batch.delete(tokenDoc(uid));
      batch.delete(queue.doc(uid));
      if (why === "user") batch.delete(statusDoc(uid));
      else batch.set(statusDoc(uid), { state: "disconnected", reason: "revoked", email: prev?.email ?? null, at: Date.now() });
      await batch.commit();
    },
    async autoSyncOn(uid) {
      const [s, u] = await db.getAll(statusDoc(uid), db.doc(`users/${uid}`));
      return s?.data()?.state === "connected" && u?.data()?.settings?.googleContacts?.enabled === true;
    },
    async ownPhones(uid) {
      const snaps = await db.getAll(db.doc(`users/${uid}/session/state`), db.doc(`users/${uid}/session/agent`));
      return snaps.map((x) => String(x.data()?.phone ?? "")).filter(Boolean);
    },
    async getComics(uid, ids) {
      const col = db.collection(`users/${uid}/comics`);
      const snaps = ids ? (ids.length ? await db.getAll(...ids.map((i) => col.doc(i))) : []) : (await col.limit(5000).get()).docs;
      return snaps.filter((s) => s.exists).map((s) => ({ id: s.id, name: String(s.data()?.name ?? ""), phone: String(s.data()?.phone ?? "") }) satisfies SyncComic);
    },
    async notice(uid, level, text) {
      await db.collection(`users/${uid}/notices`).add({ level, text, createdAt: Date.now(), read: false, expireAt: Timestamp.fromMillis(Date.now() + NOTICE_TTL_MS) });
    },
    async enqueue(uid, id, now) {
      const ref = queue.doc(uid);
      await db.runTransaction(async (tx) => {
        const prev = (await tx.get(ref)).data() as QueueDoc | undefined;
        tx.set(ref, enqueue(prev, id, now));
      });
    },
    async claimDue(now, limit) {
      const snap = await queue.where("dueAt", "<=", now).limit(limit).get();
      const out: { uid: string; q: QueueDoc }[] = [];
      for (const doc of snap.docs) {
        const claimed = await db.runTransaction(async (tx) => {
          const q = (await tx.get(doc.ref)).data() as QueueDoc | undefined;
          if (!q || !isDue(q, now)) return null;
          tx.update(doc.ref, { leaseUntil: now + LEASE_MS });
          return q;
        });
        if (claimed) out.push({ uid: doc.id, q: claimed });
      }
      return out;
    },
    async claimOne(uid, now) {
      const ref = queue.doc(uid);
      return db.runTransaction(async (tx) => {
        const q = (await tx.get(ref)).data() as QueueDoc | undefined;
        if (!q || !isDue(q, now)) return null;
        tx.update(ref, { leaseUntil: now + LEASE_MS });
        return q;
      });
    },
    async armTask(uid, now, force) {
      const ref = queue.doc(uid);
      return db.runTransaction(async (tx) => {
        const at = nextTaskAt((await tx.get(ref)).data() as QueueDoc | undefined, now, force);
        if (at !== null) tx.update(ref, { taskAt: at });
        return at;
      });
    },
    async finish(uid, processed, now, clearOverflow) {
      const ref = queue.doc(uid);
      await db.runTransaction(async (tx) => {
        const next = afterRun((await tx.get(ref)).data() as QueueDoc | undefined, processed, now, clearOverflow);
        if (next) tx.set(ref, next);
        else tx.delete(ref);
      });
    },
    async fail(uid, now) {
      const ref = queue.doc(uid);
      return db.runTransaction(async (tx) => {
        const next = afterFailure((await tx.get(ref)).data() as QueueDoc | undefined, now);
        if (next) tx.set(ref, next);
        else tx.delete(ref);
        return next === null;
      });
    },
    async drop(uid) {
      await queue.doc(uid).delete();
    },
  };
}


