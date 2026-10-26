// Invite-only access. The worker only serves curators whose access/{uid} is "approved",
// up to config/access.maxCurators. Admins (NBS_ADMIN_EMAILS) are approved automatically.
import type { AccessConfig, AccessEntry } from "@spot/shared";
import { getAuth } from "firebase-admin/auth";
import { db } from "./firebase.ts";

const ADMINS = (process.env.NBS_ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
const DEFAULT_MAX = Number(process.env.NBS_MAX_CURATORS || 6);

const configRef = db.collection("config").doc("access");
let maxCurators = DEFAULT_MAX;
const entries = new Map<string, AccessEntry>();

/** Approved uids, oldest approval first, capped at maxCurators. */
export function allowedUids() {
  return [...entries.values()]
    .filter((e) => e.status === "approved")
    .sort((a, b) => (a.decidedAt ?? a.requestedAt) - (b.decidedAt ?? b.requestedAt))
    .slice(0, maxCurators)
    .map((e) => e.uid);
}
export const isAllowed = (uid: string) => allowedUids().includes(uid);
export const isAdminEmail = (email?: string | null) => Boolean(email && ADMINS.includes(email.toLowerCase()));

const inviteChecks = new Set<string>();

/** The invited email for this account, if a verified sign-in matches an unexpired invites/{email}. Never trusts access.email. */
async function validInvite(uid: string) {
  const u = await getAuth().getUser(uid);
  if (!u.email || !u.emailVerified) return null;
  const email = u.email.toLowerCase();
  const snap = await db.collection("invites").doc(email).get();
  if (!snap.exists) return null;
  const exp = snap.data()?.expireAt;
  const expMs = typeof exp?.toMillis === "function" ? (exp.toMillis() as number) : typeof exp === "number" ? exp : 0;
  return expMs > Date.now() ? { email, ref: snap.ref } : null;
}

/** Approve a pending request that matches an invite, unless maxCurators is full (then it stays pending with a note). */
async function applyInvite(e: AccessEntry) {
  if (inviteChecks.has(e.uid)) return;
  inviteChecks.add(e.uid);
  try {
    const inv = await validInvite(e.uid);
    if (!inv) return;
    const ref = db.collection("access").doc(e.uid);
    const approved = [...entries.values()].filter((x) => x.status === "approved").length;
    if (approved >= maxCurators) {
      const note = `Invited, but the limit of ${maxCurators} curators is full. Raise the limit or remove someone, then approve.`;
      if (e.note !== note) await ref.update({ note });
      return;
    }
    await ref.update({ status: "approved", decidedAt: Date.now(), decidedBy: `invite (${inv.email})`, note: null });
    await inv.ref.delete().catch(() => undefined);
    console.log(`[access] ${inv.email} approved by invite`);
  } catch (err) {
    console.warn(`[access] invite check for ${e.uid} failed:`, (err as Error).message);
  } finally {
    inviteChecks.delete(e.uid);
  }
}

/**
 * Keep access in sync. `onChange` fires whenever the allowed set changes,
 * and `onPending` when someone new asks to join (to tell the admins).
 */
export async function startAccess(onChange: (allowed: Set<string>) => void, onPending: (e: AccessEntry) => void) {
  // Publish the admin list so the app (and the rules) know who can approve.
  const cur = (await configRef.get()).data() as AccessConfig | undefined;
  await configRef.set({ admins: ADMINS, maxCurators: cur?.maxCurators ?? DEFAULT_MAX }, { merge: true });

  configRef.onSnapshot((s) => {
    maxCurators = (s.data() as AccessConfig | undefined)?.maxCurators ?? DEFAULT_MAX;
    onChange(new Set(allowedUids()));
  });

  let first = true;
  db.collection("access").onSnapshot((q) => {
    for (const ch of q.docChanges()) {
      const e = { ...(ch.doc.data() as AccessEntry), uid: ch.doc.id };
      if (ch.type === "removed") {
        entries.delete(e.uid);
        continue;
      }
      entries.set(e.uid, e);
      // Admins never wait in the queue.
      if (e.status === "pending" && isAdminEmail(e.email)) {
        void ch.doc.ref.update({ status: "approved", decidedAt: Date.now(), decidedBy: "auto (admin)" });
      } else if (e.status === "pending") {
        void applyInvite(e);
        if (!first && ch.type === "added") onPending(e);
      }
    }
    first = false;
    onChange(new Set(allowedUids()));
  });
}
