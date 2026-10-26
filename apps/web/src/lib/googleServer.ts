// Always-on Google Contacts, browser side. One consent (Google Identity Services, authorization-code flow) hands a
// one-time code to the connectGoogleContacts Cloud Function, which keeps the long-lived access encrypted on the server
// (functions/src/googleContacts.ts). This file never sees a refresh token. The in-memory path in ./googleContacts stays
// as the fallback for curators who haven't connected.
import { getApp } from "firebase/app";
import { doc, getDoc, onSnapshot } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
import { useSyncExternalStore } from "react";
import type { ContactPlan } from "@spot/shared";
import { auth, db } from "./firebase";

const fns = () => getFunctions(getApp(), "asia-south1");
const CLIENT_ID = import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID as string | undefined;
// openid + email so the server can check the picked account is the signed-in one; contacts is the only sensitive scope.
const SCOPE = "openid email https://www.googleapis.com/auth/contacts";

interface CodeClient {
  requestCode(): void;
}
interface CodeResponse {
  code?: string;
  error?: string;
  error_description?: string;
}
declare global {
  interface Window {
    google?: { accounts?: { oauth2?: { initCodeClient(cfg: Record<string, unknown>): CodeClient } } };
  }
}

let gis: Promise<void> | null = null;
function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  gis ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gis = null;
      reject(new Error("Couldn't load Google's sign-in. Check your connection or ad blocker."));
    };
    document.head.append(s);
  });
  return gis;
}

/** The popup, from a click: resolves with Google's one-time code. */
async function requestOfflineCode(loginHint: string): Promise<string> {
  if (!CLIENT_ID) throw new Error("This build has no Google client id (VITE_GOOGLE_OAUTH_CLIENT_ID).");
  await loadGis();
  return new Promise<string>((resolve, reject) => {
    const client = window.google!.accounts!.oauth2!.initCodeClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      ux_mode: "popup",
      // Always show the consent step, so Google issues a refresh token even if this app was allowed before.
      prompt: "consent",
      include_granted_scopes: true,
      login_hint: loginHint,
      callback: (r: CodeResponse) => (r.code ? resolve(r.code) : reject(new Error(r.error_description || r.error || "Google didn't return a code"))),
      error_callback: (e: { type?: string }) => reject(Object.assign(new Error(e.type === "popup_closed" ? "Closed before finishing." : "Google's popup was blocked. Allow popups and try again."), { cancelled: e.type === "popup_closed" })),
    });
    client.requestCode();
  });
}

export const wasCancelled = (e: unknown) => Boolean((e as { cancelled?: boolean })?.cancelled);

/** The message the function wrote for the person. */
export const callableMessage = (e: unknown) => ((e as { message?: string }).message ?? "Something went wrong").replace(/^functions\/[a-z-]+:\s*/i, "");

/** Consent once; the server keeps the access. Call from a click. */
export async function keepGoogleConnected(): Promise<{ email: string; since: number }> {
  const user = auth.currentUser;
  if (!user || user.isAnonymous) throw new Error("Sign in with Google first");
  const code = await requestOfflineCode(user.email ?? "");
  return (await httpsCallable<{ code: string }, { email: string; since: number }>(fns(), "connectGoogleContacts")({ code })).data;
}

export async function disconnectGoogleServer(): Promise<void> {
  await httpsCallable(fns(), "disconnectGoogleContacts")({});
}

export async function planGoogleServer(ids: string[]): Promise<ContactPlan> {
  return (await httpsCallable<{ ids: string[] }, ContactPlan>(fns(), "planGoogleContacts", { timeout: 130_000 })({ ids })).data;
}

export async function runGoogleServer(ids: string[]): Promise<{ created: number; updated: number; failed: number }> {
  return (await httpsCallable<{ ids: string[] }, { created: number; updated: number; failed: number }>(fns(), "runGoogleContacts", { timeout: 550_000 })({ ids })).data;
}

// ---- the link's status (users/{uid}/googleLink/status: the server writes it, the owner reads it, never the token) ----

export interface ServerLink {
  /** unknown: still loading. none: never connected, or the curator disconnected. */
  state: "unknown" | "none" | "connected" | "revoked";
  email?: string;
  since?: number;
}

let cached: { uid: string; at: number; on: boolean } | null = null;
let link: ServerLink = { state: "unknown" };
let linkUid = "";
let unsub: (() => void) | null = null;
const subs = new Set<() => void>();
const set = (l: ServerLink) => {
  link = l;
  cached = null;
  subs.forEach((s) => s());
};

function watch(uid: string) {
  unsub?.();
  linkUid = uid;
  set({ state: "unknown" });
  unsub = onSnapshot(
    doc(db, "users", uid, "googleLink", "status"),
    (s) => {
      const d = s.data() as { state?: string; email?: string; since?: number } | undefined;
      set(!d ? { state: "none" } : d.state === "connected" ? { state: "connected", email: d.email, since: d.since } : { state: "revoked", email: d.email });
    },
    () => set({ state: "none" }),
  );
}

function subscribe(cb: () => void) {
  subs.add(cb);
  const uid = auth.currentUser?.uid;
  if (uid && (uid !== linkUid || !unsub)) watch(uid);
  return () => {
    subs.delete(cb);
    if (!subs.size) {
      unsub?.();
      unsub = null;
      linkUid = "";
      link = { state: "unknown" };
    }
  };
}

/** Live status of the server-side Google link for the signed-in curator. */
export const useServerLink = (): ServerLink => useSyncExternalStore(subscribe, () => link);

/** One-off check (cached a minute) used when a comic is saved: if the server owns the sync, the browser stays out of it. */
export async function serverLinkActive(): Promise<boolean> {
  const uid = auth.currentUser?.uid;
  if (!uid) return false;
  if (cached && cached.uid === uid && Date.now() - cached.at < 60_000) return cached.on;
  let on = false;
  try {
    on = (await getDoc(doc(db, "users", uid, "googleLink", "status"))).data()?.state === "connected";
  } catch {
    on = false;
  }
  cached = { uid, at: Date.now(), on };
  return on;
}
