// Firestore and FCM side of testPush.ts (Admin SDK).
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import type { TestPushPorts } from "./testPush";

const DEAD = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token", "messaging/invalid-argument"]);

export function firestoreTestPush(db = getFirestore(), messaging = getMessaging()): TestPushPorts {
  return {
    async comicTokens(uid) {
      const snap = await db.collection(`users/${uid}/devices`).where("app", "==", "comic").get();
      return snap.docs.map((d) => (d.data().token as string | undefined) ?? d.id).filter(Boolean);
    },
    async send(tokens, data) {
      const res = await messaging.sendEachForMulticast({ tokens, data, webpush: { headers: { Urgency: "high", TTL: "300" }, fcmOptions: { link: data.link } } });
      return { sent: res.successCount, dead: res.responses.flatMap((r, i) => (!r.success && r.error && DEAD.has(r.error.code) ? [tokens[i]!] : [])) };
    },
    async prune(uid, tokens) {
      await Promise.all(tokens.map((t) => db.doc(`users/${uid}/devices/${t}`).delete().catch(() => undefined)));
    },
  };
}
