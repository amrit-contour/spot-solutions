// Firestore side of the handlers (Admin SDK, so the rules that deny clients don't apply).
import { getFirestore } from "firebase-admin/firestore";
import { rateLimit } from "./logic";
import { CLAIM_STALE_MS, MAX_DELIVERIES, REDELIVER_MS } from "./link";
import type { ApproveResult, ClaimLinkResult, JoinCodeDoc, LinkDoc, LinkStore, ServerInfo, ServerKeyDoc, Store } from "./ports";

export function firestoreStore(db = getFirestore()): Store {
  const codes = db.collection("joinCodes");
  return {
    async isAdmin(email) {
      const admins = (await db.doc("config/access").get()).data()?.admins;
      return Array.isArray(admins) && admins.map((a) => String(a).toLowerCase()).includes(email.toLowerCase());
    },
    async putCode(hash, doc) {
      await codes.doc(hash).create(doc);
    },
    async claimCode(hash, now) {
      return db.runTransaction(async (tx) => {
        const ref = codes.doc(hash);
        const snap = await tx.get(ref);
        const d = snap.data() as JoinCodeDoc | undefined;
        if (!d || d.used || now >= d.expiresAt) return { ok: false } as const;
        tx.update(ref, { used: true, usedAt: now });
        return { ok: true, code: d } as const;
      });
    },
    async releaseCode(hash) {
      const ref = codes.doc(hash);
      await db.runTransaction(async (tx) => {
        const d = (await tx.get(ref)).data() as JoinCodeDoc | undefined;
        if (d && d.used && Date.now() < d.expiresAt) tx.update(ref, { used: false, usedAt: null });
      });
    },
    async finishCode(hash, serviceAccount) {
      await codes.doc(hash).update({ serviceAccount });
    },
    async allowAttempt(key, now, limit, windowMs) {
      const ref = db.collection("joinAttempts").doc(key);
      return db.runTransaction(async (tx) => {
        const prev = (await tx.get(ref)).data() as { start: number; count: number } | undefined;
        const r = rateLimit(prev, now, limit, windowMs);
        tx.set(ref, r.state);
        return r.allowed;
      });
    },
    async putServerKey(email, doc) {
      await db.collection("serverKeys").doc(email).set(doc);
    },
    async findServerKeys(slugs) {
      if (!slugs.length) return [];
      const q = await db.collection("serverKeys").where("deviceSlug", "in", slugs).get();
      return q.docs.map((d) => ({ email: d.id, doc: d.data() as ServerKeyDoc }));
    },
    async hasServerKey(email) {
      return (await db.collection("serverKeys").doc(email).get()).exists;
    },
    async deleteServerKey(email) {
      await db.collection("serverKeys").doc(email).delete();
    },
    async getServer(id): Promise<ServerInfo | null> {
      const [s, f] = await Promise.all([db.collection("servers").doc(id).get(), db.collection("fleetServers").doc(id).get()]);
      if (!s.exists && !f.exists) return null;
      const d = (s.data() ?? f.data()) as { hostname?: string; lastSeen?: number; serviceAccount?: string | null };
      return { hostname: d.hostname, lastSeen: d.lastSeen, serviceAccount: s.data()?.serviceAccount ?? null };
    },
    async leaseHolders(serverId) {
      const access = await db.collection("access").get();
      if (access.empty) return [];
      const snaps = await db.getAll(...access.docs.map((a) => db.doc(`users/${a.id}/fleet/lease`)));
      return snaps.filter((s) => s.exists && s.data()?.server === serverId && s.data()?.state !== "released").map((s) => s.ref.parent.parent?.id ?? "");
    },
    async deleteServerDocs(id) {
      await db.recursiveDelete(db.collection("servers").doc(id));
      await db.collection("fleetServers").doc(id).delete();
    },
    async sweepCodes(now) {
      const old = await codes.where("expiresAt", "<", now - 24 * 3_600_000).limit(50).get();
      if (old.empty) return;
      const batch = db.batch();
      old.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    },
  };
}

/** deviceLinks: closed to every client in firestore.rules. Each change is one transaction. */
export function firestoreLinkStore(db = getFirestore()): LinkStore {
  const links = db.collection("deviceLinks");
  return {
    async putLink(hash, doc) {
      await links.doc(hash).create(doc);
    },
    async getLink(hash) {
      return ((await links.doc(hash).get()).data() as LinkDoc | undefined) ?? null;
    },
    async approveLink(hash, email, now): Promise<ApproveResult> {
      return db.runTransaction(async (tx) => {
        const ref = links.doc(hash);
        const d = (await tx.get(ref)).data() as LinkDoc | undefined;
        if (!d) return "missing";
        if (now >= d.expiresAt) return "expired";
        if (d.status !== "pending") return "already";
        tx.update(ref, { status: "approved", approvedBy: email, approvedAt: now });
        return "ok";
      });
    },
    async claimLink(hash, now): Promise<ClaimLinkResult> {
      return db.runTransaction(async (tx) => {
        const ref = links.doc(hash);
        const d = (await tx.get(ref)).data() as LinkDoc | undefined;
        if (!d) return { ok: false, reason: "missing" } as const;
        if (d.status === "pending") return { ok: false, reason: "pending" } as const;
        if (d.status === "redeeming" && now - (d.claimedAt ?? 0) < CLAIM_STALE_MS) return { ok: false, reason: "busy" } as const;
        if (d.status === "done" && !(now - (d.doneAt ?? 0) < REDELIVER_MS && (d.deliveries ?? 0) < MAX_DELIVERIES)) return { ok: false, reason: "done" } as const;
        tx.update(ref, { status: "redeeming", claimedAt: now });
        return { ok: true, link: d } as const;
      });
    },
    async finishLink(hash, serviceAccount, now) {
      const ref = links.doc(hash);
      await db.runTransaction(async (tx) => {
        const d = (await tx.get(ref)).data() as LinkDoc | undefined;
        tx.update(ref, { status: "done", serviceAccount, doneAt: now, deliveries: (d?.deliveries ?? 0) + 1 });
      });
    },
    async releaseLink(hash) {
      await links.doc(hash).update({ status: "approved" });
    },
    async sweepLinks(now) {
      const old = await links.where("expiresAt", "<", now - 24 * 3_600_000).limit(50).get();
      if (old.empty) return;
      const batch = db.batch();
      old.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    },
  };
}
