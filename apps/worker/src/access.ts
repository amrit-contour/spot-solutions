// Invite-only access. The worker only serves curators whose access/{uid} is "approved",
// up to config/access.maxCurators. Admins (SPOT_ADMIN_EMAILS) are approved automatically.
import type { AccessConfig, AccessEntry } from "@spot/shared";
import { db } from "./firebase.ts";

const ADMINS = (process.env.SPOT_ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
const DEFAULT_MAX = Number(process.env.SPOT_MAX_CURATORS || 6);

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
      } else if (e.status === "pending" && !first && ch.type === "added") {
        onPending(e);
      }
    }
    first = false;
    onChange(new Set(allowedUids()));
  });
}
