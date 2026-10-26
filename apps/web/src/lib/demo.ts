// Demo mode for judges and visitors: anonymous sign-in, then a private copy of the demo account.
// Nothing here touches real curators, and the worker never serves anonymous users.
import { signInAnonymously } from "firebase/auth";
import { collection, doc, getDocFromServer, getDocsFromServer, writeBatch } from "firebase/firestore";
import { DEFAULT_SETTINGS, rolloverDayFor, shiftDemoData, weekOf, type DemoData, type Show } from "@spot/shared";
import { auth, db } from "./firebase";

export const DEMO_SOURCE = "demo-curator";
const COLLECTIONS = ["venues", "shows", "comics", "requests", "lineups", "actions", "notices"] as const;

export const isDemoUser = () => Boolean(auth.currentUser?.isAnonymous);

export async function startDemo() {
  await signInAnonymously(auth);
}

/** True for a sandbox whose copy never finished (or predates the marker): it needs cloning again. */
export const needsDemoClone = (data: { demo?: unknown; demoClonedAt?: unknown } | undefined) => data?.demo === true && !data.demoClonedAt;

/**
 * Give a demo visitor their own editable copy of the demo data, moved to the current week so it is always populated.
 * Reads straight from the server (never a stale cache) and writes everything, marker included, in one batch.
 */
export async function cloneDemo(uid: string) {
  const src = await getDocFromServer(doc(db, "users", DEMO_SOURCE));
  const data: DemoData = {};
  for (const c of COLLECTIONS) {
    const snap = await getDocsFromServer(collection(db, "users", DEMO_SOURCE, c));
    data[c] = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
  }
  const total = Object.values(data).reduce((n, docs) => n + docs.length, 0);
  if (!src.exists() || !total) throw new Error("The demo data isn't available right now.");
  if (total > 498) throw new Error("The demo data is too large to copy.");

  const settings = src.data().settings ?? {};
  const now = Date.now();
  const toWeek = weekOf(new Date(now), settings.timezone ?? DEFAULT_SETTINGS.timezone, rolloverDayFor(data.shows.map((d) => d.data as unknown as Show)));
  const shifted = shiftDemoData(data, { toWeek, now, templateAt: typeof src.data().createdAt === "number" ? src.data().createdAt : undefined });

  const batch = writeBatch(db);
  batch.set(doc(db, "users", uid), { settings, name: "Demo visitor", email: null, demo: true, demoClonedAt: now, createdAt: now });
  for (const c of COLLECTIONS) for (const d of shifted[c]) batch.set(doc(db, "users", uid, c, d.id), d.data);
  await batch.commit();
}
