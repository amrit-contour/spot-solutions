// The phone's own connection to Firestore, shared by both apps: navigator.onLine plus whether the status listeners are getting
// server data or only the local cache (snapshot metadata.fromCache). Pure rules live in @spot/shared connection.ts (deriveServer).
// Imported as "@spot/ui/phoneLink" (it starts Firestore through ./firebase.ts), never from the barrel.
import { useSyncExternalStore } from "react";
import { disableNetwork, enableNetwork } from "firebase/firestore";
import { PHONE_LIVE, shouldNudge, type PhoneLink } from "@spot/shared";
import { db } from "./firebase.ts";

const onLine = () => (typeof navigator === "undefined" ? true : navigator.onLine);
const sources = new Map<string, boolean>(); // listener name -> its last snapshot came from the cache
const subs = new Set<() => void>();
let state: PhoneLink = { ...PHONE_LIVE, online: onLine() };
let lastNudgeAt: number | null = null;
let watcher: ReturnType<typeof setInterval> | undefined;

function recompute() {
  const now = Date.now();
  const cached = [...sources.values()].some(Boolean);
  const online = onLine();
  const next: PhoneLink = {
    online,
    fromCache: cached,
    cachedSince: cached ? state.cachedSince ?? now : null,
    // Live = the server answered and the browser agrees it is online.
    liveAt: !cached && online && sources.size > 0 ? now : state.liveAt,
  };
  if (next.online !== state.online || next.fromCache !== state.fromCache || next.cachedSince !== state.cachedSince || next.liveAt !== state.liveAt) {
    state = next;
    subs.forEach((f) => f());
  }
  // While stuck on the cache, check every few seconds whether a reconnect is due.
  if (cached && !watcher) watcher = setInterval(check, 5_000);
  if (!cached && watcher) (clearInterval(watcher), (watcher = undefined));
}

/** A reconnect (disableNetwork, enableNetwork) is only for listeners stuck on the cache for 20 s+ while the browser says it is online. */
function check() {
  const now = Date.now();
  if (!shouldNudge(state, now, lastNudgeAt)) return;
  lastNudgeAt = now;
  void disableNetwork(db).then(() => enableNetwork(db)).catch(() => undefined);
}

/** A status listener reports every snapshot (use includeMetadataChanges: true so the cache-to-server flip arrives too). */
export function reportSnapshot(source: string, fromCache: boolean) {
  sources.set(source, fromCache);
  recompute();
}
export function forgetSource(source: string) {
  sources.delete(source);
  recompute();
}

if (typeof window !== "undefined") {
  // Back online or back on screen: re-evaluate now (the SDK reconnects by itself; check() only steps in if it stays stuck).
  const wake = () => {
    recompute();
    check();
  };
  window.addEventListener("online", wake);
  window.addEventListener("offline", recompute);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && wake());
}

const subscribe = (f: () => void) => (subs.add(f), () => subs.delete(f));
export const usePhoneLink = (): PhoneLink => useSyncExternalStore(subscribe, () => state, () => PHONE_LIVE);
