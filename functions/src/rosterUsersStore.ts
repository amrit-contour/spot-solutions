// Firestore and Auth side of rosterUsers.ts (Admin SDK).
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import type { UserDirectory } from "./rosterUsers";

export function firestoreDirectory(db = getFirestore(), auth = getAuth()): UserDirectory {
  return {
    async byEmail(email) {
      try {
        const u = await auth.getUserByEmail(email);
        const access = (await db.doc(`access/${u.uid}`).get()).data();
        const name = (typeof access?.name === "string" && access.name) || u.displayName || undefined;
        return { uid: u.uid, email, ...(name ? { name } : {}) };
      } catch (e) {
        if ((e as { code?: string }).code === "auth/user-not-found") return null;
        throw e;
      }
    },
    async isAllowed(uid, email) {
      const admins = (await db.doc("config/access").get()).data()?.admins;
      if (Array.isArray(admins) && admins.map((a) => String(a).toLowerCase()).includes(email.toLowerCase())) return true;
      return (await db.doc(`access/${uid}`).get()).data()?.status === "approved";
    },
  };
}
