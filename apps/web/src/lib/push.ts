// Web push (FCM): the app's own service worker shows notifications (public/fcm-sw.js, imported into the
// PWA worker), so there is one worker at the root scope. Tokens live at users/{uid}/devices/{token}.
import { useEffect, useState } from "react";
import { deleteDoc, doc, setDoc } from "firebase/firestore";
import { getApp } from "firebase/app";
import { toast } from "sonner";
import { db } from "@spot/ui/firebase";
import { isDemoUser } from "./demo";
import { isIOS, isStandalone } from "./install";

const KEY = "spot.pushToken";
const DAY = 86_400_000;

export type PushState = "on" | "off" | "denied" | "ios-install" | "unsupported";

const read = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const write = (v: string | null) => {
  try {
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: the toggle still works for this tab */
  }
};

/** What this browser can do right now, before anything is asked of the user. */
export function pushSupport(): "ok" | "ios-install" | "unsupported" {
  if (isIOS() && !isStandalone()) return "ios-install"; // iOS only allows push for sites added to the home screen
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return "ok";
}

async function messaging() {
  const m = await import("firebase/messaging");
  if (!(await m.isSupported())) throw new Error("This browser can't receive notifications.");
  return { m, msg: m.getMessaging(getApp()) };
}

/** The PWA service worker; in dev (no worker) this would wait forever, so give up after a few seconds. */
async function registration() {
  const reg = await Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
  if (!reg) throw new Error("The app isn't ready for notifications yet. Reload the page and try again.");
  return reg;
}

const tokenOptions = async () => ({ vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY || undefined, serviceWorkerRegistration: await registration() });

const platformLabel = () => (isIOS() ? "ios" : /android/i.test(navigator.userAgent) ? "android" : "web");

function saveDevice(uid: string, token: string, createdAt = Date.now()) {
  return setDoc(doc(db, "users", uid, "devices", token), { token, platform: platformLabel(), userAgent: navigator.userAgent.slice(0, 300), createdAt, lastSeen: Date.now() });
}

/** Ask permission (call this from a click, never on load), subscribe, and register the token. */
export async function enablePush(uid: string) {
  if (isDemoUser()) throw new Error("Notifications need a real account. Sign in with Google to turn them on.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error(perm === "denied" ? "Notifications are blocked for this site. Allow them in your browser's site settings, then try again." : "Notifications weren't allowed.");
  const { m, msg } = await messaging();
  const token = await m.getToken(msg, await tokenOptions());
  if (!token) throw new Error("Couldn't get a notification token from this browser.");
  await saveDevice(uid, token);
  write(token);
}

export async function disablePush(uid: string) {
  const token = read();
  write(null);
  if (token) await deleteDoc(doc(db, "users", uid, "devices", token)).catch(() => {});
  try {
    const { m, msg } = await messaging();
    await m.deleteToken(msg);
  } catch {
    /* the server prunes tokens that stop working */
  }
}

/** Keeps this device's token fresh (tokens rotate) and says whether notifications are on here. */
export function usePushState(uid: string) {
  const [state, setState] = useState<PushState>(() => {
    const s = pushSupport();
    if (s !== "ok") return s;
    if (Notification.permission === "denied") return "denied";
    return Notification.permission === "granted" && read() ? "on" : "off";
  });
  useEffect(() => {
    if (state !== "on" || isDemoUser()) return;
    void (async () => {
      try {
        const old = read();
        const { m, msg } = await messaging();
        const token = await m.getToken(msg, await tokenOptions());
        if (!token) return;
        if (token !== old) {
          if (old) await deleteDoc(doc(db, "users", uid, "devices", old)).catch(() => {});
          await saveDevice(uid, token);
          write(token);
        } else if (Date.now() - Number(sessionStorage.getItem("spot.pushSeen") ?? 0) > DAY) {
          sessionStorage.setItem("spot.pushSeen", String(Date.now()));
          await setDoc(doc(db, "users", uid, "devices", token), { lastSeen: Date.now() }, { merge: true });
        }
      } catch {
        /* offline or the worker isn't up; try again next visit */
      }
    })();
  }, [uid, state]);
  return [state, setState] as const;
}

/** App-wide: while the app is open and visible, the service worker hands pushes to the page and we show a toast. */
export function useForegroundPush() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const on = (e: MessageEvent) => {
      const d = e.data as { type?: string; title?: string; body?: string } | undefined;
      if (d?.type !== "spot-push") return;
      toast(d.title ?? "Nothing BOT Curate", { description: d.body });
    };
    navigator.serviceWorker.addEventListener("message", on);
    return () => navigator.serviceWorker.removeEventListener("message", on);
  }, []);
}
