// Demo mode for judges and visitors: anonymous sign-in, then a private copy of the demo account.
// Nothing here touches real curators, and the worker never serves anonymous users.
import { signInAnonymously } from "firebase/auth";
import { collection, doc, getDoc, getDocs, writeBatch } from "firebase/firestore";
import { auth, db } from "./firebase";

export const DEMO_SOURCE = "demo-curator";
const COLLECTIONS = ["venues", "shows", "comics", "requests", "lineups", "actions", "notices"] as const;

export const isDemoUser = () => Boolean(auth.currentUser?.isAnonymous);

export async function startDemo() {
  await signInAnonymously(auth);
}

/** Give a fresh demo visitor their own editable copy of the demo data. */
export async function cloneDemo(uid: string) {
  const src = await getDoc(doc(db, "users", DEMO_SOURCE));
  const batch = writeBatch(db);
  batch.set(doc(db, "users", uid), { settings: src.data()?.settings ?? {}, name: "Demo visitor", email: null, demo: true, createdAt: Date.now() });
  for (const c of COLLECTIONS) {
    const snap = await getDocs(collection(db, "users", DEMO_SOURCE, c));
    snap.docs.forEach((d) => batch.set(doc(db, "users", uid, c, d.id), d.data()));
  }
  await batch.commit();
}
