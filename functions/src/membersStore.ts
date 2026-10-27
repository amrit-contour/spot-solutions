// Firestore and Auth side of members.ts (Admin SDK).
import { getAuth, type UserIdentifier } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import type { MemberSource } from "./members";

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export function firestoreMembers(db = getFirestore(), auth = getAuth()): MemberSource {
  const adminEmails = async () => {
    const admins = (await db.doc("config/access").get()).data()?.admins;
    return Array.isArray(admins) ? admins.map((a) => String(a).trim().toLowerCase()).filter(Boolean) : [];
  };
  return {
    async isAllowed(uid, email) {
      if ((await adminEmails()).includes(email.toLowerCase())) return true;
      return (await db.doc(`access/${uid}`).get()).data()?.status === "approved";
    },
    adminEmails,
    async approvedAccess() {
      const snap = await db.collection("access").where("status", "==", "approved").get();
      return snap.docs.map((d) => ({ uid: d.id, email: str(d.data().email), name: str(d.data().name), photo: str(d.data().photo) }));
    },
    async authProfiles(ids) {
      const out: Awaited<ReturnType<MemberSource["authProfiles"]>> = [];
      for (let i = 0; i < ids.length; i += 100) {
        const r = await auth.getUsers(ids.slice(i, i + 100) as UserIdentifier[]);
        for (const u of r.users) out.push({ uid: u.uid, email: u.email, displayName: u.displayName, photoURL: u.photoURL, disabled: u.disabled });
      }
      return out;
    },
  };
}
