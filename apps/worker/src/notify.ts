// Push notifications to a curator's devices (docs/fleet.md, "Push notifications").
// Sends to every FCM token in users/{uid}/devices and prunes the ones Google says are dead.
import { getMessaging } from "firebase-admin/messaging";
import type { PushKind } from "@spot/shared";
import { col } from "./firebase.ts";

const APP_URL = "https://nothingbotcurating.web.app/settings#whatsapp";
const TITLES: Record<PushKind, string> = {
  account_moved: "Your account moved",
  scan_needed: "WhatsApp needs a scan",
  server_offline: "A server went offline",
  new_request: "New spot request",
  ask_open: "Time to ask for a spot",
  ask_closing: "An ask is closing soon",
  ask_reply: "A curator replied",
};
/** Nothing BOT Comedy's own address, for the pushes that belong to that app. */
const COMEDY_URL = "https://nothingbotcomedy.web.app/asks";
const LINKS: Partial<Record<PushKind, string>> = { ask_open: COMEDY_URL, ask_closing: COMEDY_URL, ask_reply: COMEDY_URL };
/** Error codes that mean the token will never work again. */
const DEAD = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token", "messaging/invalid-argument"]);

export async function notify(uid: string, kind: PushKind, text: string): Promise<void> {
  try {
    const snap = await col(uid, "devices").get();
    // The comic app registers its own devices (app: "comic", its own origin and worker): they never get the curator app's pushes.
    const tokens = snap.docs.filter((d) => d.data().app !== "comic").map((d) => (d.data().token as string | undefined) ?? d.id).filter(Boolean);
    if (!tokens.length) return;

    // Data-only: the app's service worker (public/fcm-sw.js) builds the notification, or hands it to an open tab as a toast.
    const res = await getMessaging().sendEachForMulticast({
      tokens,
      data: { kind, title: TITLES[kind], body: text, link: LINKS[kind] ?? APP_URL },
      webpush: { headers: { Urgency: kind === "new_request" || kind === "ask_open" ? "normal" : "high", TTL: "86400" }, fcmOptions: { link: LINKS[kind] ?? APP_URL } },
    });

    const dead = res.responses.flatMap((r, i) => (!r.success && r.error && DEAD.has(r.error.code) ? [tokens[i]] : []));
    await Promise.all(dead.map((t) => col(uid, "devices").doc(t).delete().catch(() => {})));
    if (dead.length) console.log(`[notify] ${uid}: pruned ${dead.length} dead device token(s)`);
  } catch (e) {
    // A failed push must never break the caller (a failover, a QR, a request).
    console.warn(`[notify] ${kind} for ${uid} failed:`, (e as Error).message);
  }
}

const COMIC_URL = (process.env.NBS_COMIC_URL ?? "https://nothingbotcomedy.web.app").replace(/\/$/, "");

/**
 * A push to the comic app's devices only (Nothing BOT Comedy), data-only like the curator's: its service worker (apps/comic/public/fcm-sw.js)
 * builds the notification. `path` is where a tap lands, e.g. "/alerts?alert=ID"; `ttlSec` stops a stale offer arriving late.
 */
export async function notifyComic(uid: string, msg: { kind: string; title: string; body: string; path: string; alertId?: string; ttlSec?: number }): Promise<number> {
  try {
    const snap = await col(uid, "devices").where("app", "==", "comic").get();
    const tokens = snap.docs.map((d) => (d.data().token as string | undefined) ?? d.id).filter(Boolean);
    if (!tokens.length) return 0;
    const link = `${COMIC_URL}${msg.path}`;
    const res = await getMessaging().sendEachForMulticast({
      tokens,
      data: { kind: msg.kind, title: msg.title, body: msg.body, link, ...(msg.alertId ? { alertId: msg.alertId } : {}) },
      webpush: { headers: { Urgency: "high", TTL: String(Math.max(60, Math.min(86_400, Math.floor(msg.ttlSec ?? 3600)))) }, fcmOptions: { link } },
    });
    const dead = res.responses.flatMap((r, i) => (!r.success && r.error && DEAD.has(r.error.code) ? [tokens[i]] : []));
    await Promise.all(dead.map((t) => col(uid, "devices").doc(t).delete().catch(() => {})));
    return res.successCount;
  } catch (e) {
    console.warn(`[notify] comic push for ${uid} failed:`, (e as Error).message);
    return 0;
  }
}
