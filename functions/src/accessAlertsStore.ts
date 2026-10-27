// Firestore, Auth and push side of accessAlerts.ts (Admin SDK).
import { getAuth } from "firebase-admin/auth";
import { Timestamp, getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import type { AccessAlertPorts } from "./accessAlerts";

const NOTICE_TTL_MS = 30 * 86_400_000;
/** Error codes that mean the token will never work again. */
const DEAD = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token", "messaging/invalid-argument"]);

export function firestoreAccessAlerts(db = getFirestore(), auth = getAuth(), messaging = () => getMessaging()): AccessAlertPorts {
  return {
    async claim(key) {
      try {
        await db.doc(`accessAlerts/${key}`).create({ at: Date.now(), expireAt: Timestamp.fromMillis(Date.now() + NOTICE_TTL_MS) });
        return true;
      } catch (e) {
        if ((e as { code?: number | string }).code === 6 || (e as { code?: string }).code === "already-exists") return false;
        throw e;
      }
    },
    async admins() {
      const emails = ((await db.doc("config/access").get()).data()?.admins as unknown[] | undefined) ?? [];
      const list = emails.map((a) => String(a).trim().toLowerCase()).filter(Boolean);
      const out: { uid: string; email: string }[] = [];
      for (let i = 0; i < list.length; i += 100) {
        const r = await auth.getUsers(list.slice(i, i + 100).map((email) => ({ email })));
        for (const u of r.users) if (u.email && !u.disabled) out.push({ uid: u.uid, email: u.email.toLowerCase() });
      }
      return out;
    },
    async putNotice(uid, id, notice) {
      await db.doc(`users/${uid}/notices/${id}`).set({ ...notice, expireAt: Timestamp.fromMillis(notice.createdAt + NOTICE_TTL_MS) });
    },
    async closeNotice(uid, id, at) {
      try {
        await db.doc(`users/${uid}/notices/${id}`).update({ read: true, dismissedAt: at });
      } catch (e) {
        if ((e as { code?: number | string }).code !== 5 && (e as { code?: string }).code !== "not-found") throw e;
      }
    },
    async push(uid, p) {
      const snap = await db.collection(`users/${uid}/devices`).get();
      const devices = snap.docs.map((d) => ({ token: (d.data().token as string | undefined) ?? d.id, comic: d.data().app === "comic" })).filter((d) => d.token);
      for (const comic of [false, true]) {
        const tokens = devices.filter((d) => d.comic === comic).map((d) => d.token);
        if (!tokens.length) continue;
        const link = comic ? p.links.comic : p.links.curate;
        const res = await messaging().sendEachForMulticast({
          tokens,
          // Data-only, like the worker's pushes: each app's service worker builds the notification.
          data: { kind: "access_request", title: p.title, body: p.body, link },
          webpush: { headers: { Urgency: "normal", TTL: "86400" }, fcmOptions: { link } },
        });
        const dead = res.responses.flatMap((r, i) => (!r.success && r.error && DEAD.has(r.error.code) ? [tokens[i]!] : []));
        await Promise.all(dead.map((t) => db.doc(`users/${uid}/devices/${t}`).delete().catch(() => undefined)));
      }
    },
    now: Date.now,
    log: (m) => console.log(`[access-alert] ${m}`),
  };
}
