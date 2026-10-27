// Firestore and Auth side of admins.ts (Admin SDK).
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import type { AdminPorts, Activity } from "./admins";

export function firestoreAdmins(db = getFirestore(), auth = getAuth()): AdminPorts {
  const ref = db.doc("config/access");
  const clean = (v: unknown) => (Array.isArray(v) ? v.map((a) => String(a).trim().toLowerCase()).filter(Boolean) : []);
  const has = async (path: string) => !(await db.collection(path).limit(1).get()).empty;
  return {
    async adminEmails() {
      return clean((await ref.get()).data()?.admins);
    },
    async updateAdmins(next) {
      return db.runTransaction(async (tx) => {
        const list = next(clean((await tx.get(ref)).data()?.admins));
        tx.set(ref, { admins: list }, { merge: true });
        return list;
      });
    },
    async isApprovedEmail(email) {
      return !(await db.collection("access").where("email", "==", email).where("status", "==", "approved").limit(1).get()).empty;
    },
    async accessUids() {
      return (await db.collection("access").select().get()).docs.map((d) => d.id);
    },
    async activity(uids) {
      const out: Record<string, Activity> = {};
      for (let i = 0; i < uids.length; i += 100) {
        const chunk = uids.slice(i, i + 100);
        const seen = new Map<string, number>();
        const r = await auth.getUsers(chunk.map((uid) => ({ uid })));
        for (const u of r.users) {
          const t = Date.parse(u.metadata.lastRefreshTime ?? u.metadata.lastSignInTime ?? "");
          if (Number.isFinite(t)) seen.set(u.uid, t);
        }
        // Curating keeps shows and lineups; Comedy keeps rooms and its own settings on the user doc.
        for (let j = 0; j < chunk.length; j += 20) {
          await Promise.all(
            chunk.slice(j, j + 20).map(async (uid) => {
              const [shows, lineups, rooms, user] = await Promise.all([has(`users/${uid}/shows`), has(`users/${uid}/lineups`), has(`users/${uid}/rooms`), db.doc(`users/${uid}`).get()]);
              out[uid] = { curating: shows || lineups, comedy: rooms || user.data()?.comicSettings != null, lastSeen: seen.get(uid) ?? null };
            }),
          );
        }
      }
      return out;
    },
  };
}
