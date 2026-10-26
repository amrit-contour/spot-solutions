// Admin-only data tools, run from servers/{id}/commands (see stats.ts). They cross user
// boundaries, which the browser can't do, so they use the Admin SDK and re-check the requester here.
import type { CollectionReference, DocumentReference } from "firebase-admin/firestore";
import { DEMO_SOURCE_UID, collectionsForScope, demoSandboxIds, isDataScope, type AdminDataPayload, type AdminDataResult, type DataScope } from "@spot/shared";
import { col, db, userRef } from "./firebase.ts";
import { SERVER_ID } from "./serverIdentity.ts";
import { wipeLogin } from "./vault.ts";
import { isAdminEmail } from "./access.ts";

export const ADMIN_DATA_COMMANDS = new Set(["delete_user_data", "remove_user", "wipe_demo"]);

const BATCH = 450;
const PAR = 25;

/** Delete a collection and everything under its documents, in batches. Returns documents deleted. */
async function deleteCollection(ref: CollectionReference): Promise<number> {
  let n = 0;
  for (;;) {
    const snap = await ref.limit(BATCH).get();
    if (snap.empty) return n;
    for (let i = 0; i < snap.docs.length; i += PAR) {
      await Promise.all(snap.docs.slice(i, i + PAR).map((d) => deleteSubcollections(d.ref)));
    }
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    n += snap.size;
    if (snap.size < BATCH) return n;
  }
}

async function deleteSubcollections(ref: DocumentReference) {
  for (const sub of await ref.listCollections()) await deleteCollection(sub);
}

async function count(ref: CollectionReference) {
  return (await ref.count().get()).data().count;
}

/** "everything" also covers collections this code doesn't know about. */
async function collectionNames(uid: string, scope: DataScope) {
  if (scope !== "everything") return collectionsForScope(scope);
  // `fleet` is handled apart: its vault doc holds the logout tombstone, which must outlive the deletion.
  return [...new Set([...collectionsForScope("everything"), ...(await userRef(uid).listCollections()).map((c) => c.id)])].filter((n) => n !== "fleet");
}

/** Delete (or, with dryRun, count) a curator's data for a scope. "everything" includes the profile doc. */
async function userData(uid: string, scope: DataScope, dryRun: boolean): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const name of await collectionNames(uid, scope)) {
    const ref = userRef(uid).collection(name);
    const n = dryRun ? await count(ref) : await deleteCollection(ref);
    if (n) counts[name] = n;
  }
  if (scope === "everything") {
    // Lease and prefs go; the vault doc (tombstone) stays so a late upload from a holder can't resurrect the login.
    const docs = (await userRef(uid).collection("fleet").get()).docs.filter((d) => d.id !== "vault");
    if (docs.length) counts.fleet = docs.length;
    if (!dryRun) await Promise.all(docs.map((d) => d.ref.delete()));
  }
  if (scope === "everything" && (await userRef(uid).get()).exists) {
    counts.profile = 1;
    if (!dryRun) await userRef(uid).delete();
  }
  return counts;
}

const sum = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
const merge = (into: Record<string, number>, c: Record<string, number>) => Object.entries(c).forEach(([k, v]) => (into[k] = (into[k] ?? 0) + v));

/** The curator's email, for the typed confirmation. Prefers the access record. */
async function emailOf(uid: string) {
  const a = (await db.collection("access").doc(uid).get()).data();
  const email = a?.email ?? (await userRef(uid).get()).data()?.email;
  return String(email ?? "").toLowerCase() || null;
}

async function target(p: AdminDataPayload, by: string) {
  if (!p.uid || typeof p.uid !== "string" || p.uid.includes("/")) throw new Error("No curator chosen");
  if (p.uid === DEMO_SOURCE_UID) throw new Error("The demo template can't be deleted here");
  const email = await emailOf(p.uid);
  if (!email) throw new Error("That account has no email, so it isn't a curator. Use Wipe demo sandboxes for demo visitors.");
  if (!p.dryRun && String(p.confirmEmail ?? "").trim().toLowerCase() !== email) throw new Error("The email you typed doesn't match");
  return { uid: p.uid, email, self: email === by.toLowerCase() };
}

const UNLINK_WAIT_MS = 60_000;

/**
 * Unlink WhatsApp on the server that actually runs the account. Here if we hold the lease; otherwise ask the holder
 * with a `logout` command and wait for it. No holder: nothing is running, so there is nothing to unlink. Either way a
 * tombstone follows, so no holder can upload the login again later.
 */
async function logout(uid: string) {
  // Lazy: sessions pulls in the send queue, which imports stats, which imports this file.
  const { sessions } = await import("./sessions.ts");
  const { fleet } = await import("./fleet.ts");
  // Mid-handoff: the account is about to be run by another server. Wait for the move to land (up to the same budget),
  // then the holder branch below sends it the logout. Unlinking here now would miss the session the new holder starts.
  for (const end = Date.now() + UNLINK_WAIT_MS; fleet.isMoving(uid) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 1_000));
  if (fleet.holds(uid)) await sessions.logout(uid);
  else if (fleet.hasRemoteHolder(uid)) {
    const ref = await col(uid, "commands").add({ type: "logout", status: "pending", by: "admin-data-tool", createdAt: Date.now() });
    const end = Date.now() + UNLINK_WAIT_MS;
    let status = "pending";
    while (Date.now() < end && (status === "pending" || status === "running")) {
      await new Promise((r) => setTimeout(r, 1_000));
      status = String((await ref.get()).data()?.status ?? "done");
    }
    if (status !== "done") console.warn(`[admin] ${uid}: holder didn't confirm the unlink (${status}); wiping the vault anyway`);
  }
  await wipeLogin(uid, SERVER_ID);
}

/** Throws unless `by` is a server admin. The return value is stored as the command's result. */
export async function runAdminDataCommand(type: string, data: { by?: string; payload?: AdminDataPayload }): Promise<AdminDataResult> {
  const by = String(data.by ?? "");
  if (!isAdminEmail(by)) throw new Error("Only admins can do this");
  const p = data.payload ?? {};
  const dryRun = p.dryRun === true;

  if (type === "wipe_demo") {
    const snap = await db.collection("users").where("demo", "==", true).get();
    // The flag alone isn't enough: a real account (email on the doc, or an access request) is never a sandbox.
    const flagged = demoSandboxIds(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    const access = flagged.length ? await db.getAll(...flagged.map((id) => db.collection("access").doc(id))) : [];
    const real = new Set(access.filter((a) => a.exists).map((a) => a.id));
    const uids = flagged.filter((id) => !real.has(id));
    const counts: Record<string, number> = {};
    for (const uid of uids) merge(counts, await userData(uid, "everything", dryRun));
    if (!dryRun) console.log(`[admin] ${by} wiped ${uids.length} demo sandbox(es), ${sum(counts)} docs`);
    return { counts, total: sum(counts), users: uids.length, dryRun };
  }

  if (type === "delete_user_data") {
    if (!isDataScope(p.scope)) throw new Error("Pick what to delete");
    const t = await target(p, by);
    if (t.self || isAdminEmail(t.email)) throw new Error("Admins' data can't be deleted here");
    // Everything also unlinks WhatsApp. Logout rewrites the user doc, so it runs before the delete.
    if (!dryRun && p.scope === "everything") await logout(t.uid);
    const counts = await userData(t.uid, p.scope, dryRun);
    if (!dryRun) {
      if (p.scope === "everything") await userData(t.uid, "everything", false); // late heartbeat writes
      console.log(`[admin] ${by} deleted ${p.scope} for ${t.email}: ${sum(counts)} docs`);
    }
    return { counts, total: sum(counts), users: 1, dryRun };
  }

  if (type === "remove_user") {
    const t = await target(p, by);
    if (t.self || isAdminEmail(t.email)) throw new Error("Admins can't be removed here");
    if (!dryRun) {
      // Unlink before revoking: revoking also stops the session, and logout needs the live client.
      await logout(t.uid);
      await db.collection("access").doc(t.uid).set({ status: "removed", decidedAt: Date.now(), decidedBy: by }, { merge: true });
    }
    const counts = await userData(t.uid, "everything", dryRun);
    if (!dryRun) {
      await userData(t.uid, "everything", false);
      console.log(`[admin] ${by} removed ${t.email}: ${sum(counts)} docs deleted`);
    }
    return { counts, total: sum(counts), users: 1, dryRun };
  }

  throw new Error(`Unknown ${type}`);
}
