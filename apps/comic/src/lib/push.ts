// Web push for Nothing BOT Comedy (FCM). This site has its own origin and service worker (public/fcm-sw.js, pulled into the generated
// PWA worker), so its tokens are separate from the curator app's: each device doc is tagged app: "comic" and the server sends spot
// alerts only to those. Tokens live at users/{uid}/devices/{token}.
import { useEffect, useState } from "react";
import { deleteDoc, doc, setDoc } from "firebase/firestore";
import { getApp } from "firebase/app";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";
import { toast } from "sonner";
import { db } from "@spot/ui/firebase";
import { isStandalone } from "./install";

const KEY = "nbc.pushToken";
const DAY = 86_400_000;

export type PushState = "on" | "off" | "denied" | "ios-install" | "unsupported";

const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
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
  if (isIOS() && !isStandalone()) return "ios-install"; // iOS only allows push for apps added to the Home Screen
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return "ok";
}

async function messaging() {
  const m = await import("firebase/messaging");
  if (!(await m.isSupported())) throw new Error("This browser can't receive notifications.");
  return { m, msg: m.getMessaging(getApp()) };
}

/** The PWA service worker. In dev there is none, so give up after a few seconds instead of waiting forever. */
async function registration() {
  const reg = await Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
  if (!reg) throw new Error("The app isn't ready for notifications yet. Reload the page and try again.");
  return reg;
}

const tokenOptions = async () => ({ vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY || undefined, serviceWorkerRegistration: await registration() });
const platformLabel = () => (isIOS() ? "ios" : /android/i.test(navigator.userAgent) ? "android" : "web");

const saveDevice = (uid: string, token: string, createdAt = Date.now()) =>
  setDoc(doc(db, "users", uid, "devices", token), { token, platform: platformLabel(), userAgent: navigator.userAgent.slice(0, 300), createdAt, lastSeen: Date.now(), app: "comic" });

/** Ask permission (call this from a tap, never on load), subscribe, and register the token. */
export async function enablePush(uid: string) {
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

/** Keeps this device's token fresh (tokens rotate) and says whether alerts are on here. */
export function usePushState(uid: string) {
  const [state, setState] = useState<PushState>(() => {
    const s = pushSupport();
    if (s !== "ok") return s;
    if (Notification.permission === "denied") return "denied";
    return Notification.permission === "granted" && read() ? "on" : "off";
  });
  useEffect(() => {
    if (state !== "on") return;
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
        } else if (Date.now() - Number(sessionStorage.getItem("nbc.pushSeen") ?? 0) > DAY) {
          sessionStorage.setItem("nbc.pushSeen", String(Date.now()));
          await setDoc(doc(db, "users", uid, "devices", token), { lastSeen: Date.now() }, { merge: true });
        }
      } catch {
        /* offline, or the worker isn't up: try again next visit */
      }
    })();
  }, [uid, state]);
  return [state, setState] as const;
}

/**
 * While the app is open and in front, the service worker hands a push to the page and we show a toast instead of a system
 * notification. A spot alert's toast has "Ask for it", which opens the ask ready to send.
 */
export function useForegroundPush(openAsk: (alertId: string) => void) {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const on = (e: MessageEvent) => {
      const d = e.data as { type?: string; kind?: string; title?: string; body?: string; alertId?: string } | undefined;
      if (d?.type !== "nbc-push") return;
      const alertId = d.alertId;
      toast(d.title ?? "Nothing BOT Comedy", {
        description: d.body,
        duration: d.kind === "spot_alert" ? 30_000 : 6000,
        action: d.kind === "spot_alert" && alertId ? { label: "Ask for it", onClick: () => openAsk(alertId) } : undefined,
      });
    };
    navigator.serviceWorker.addEventListener("message", on);
    return () => navigator.serviceWorker.removeEventListener("message", on);
  }, [openAsk]);
}

let emulatorConnected = false;

/** "Send test push": a notification from the server to this account's Comedy devices (a Cloud Function, so it needs no WhatsApp server). */
export async function sendTestPush(): Promise<{ sent: number; devices: number }> {
  const fns = getFunctions(getApp(), "asia-south1");
  if (import.meta.env.DEV && import.meta.env.VITE_USE_EMULATORS === "1" && !emulatorConnected) {
    emulatorConnected = true;
    connectFunctionsEmulator(fns, "127.0.0.1", 5001);
  }
  try {
    return (await httpsCallable<unknown, { sent: number; devices: number }>(fns, "sendComicTestPush")({})).data;
  } catch (e) {
    const m = (e as { message?: string }).message;
    throw new Error(m && !/^internal$/i.test(m) ? m : "Couldn't send the test. Check your connection and try again.");
  }
}
