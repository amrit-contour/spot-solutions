// The phone's own connection to Firestore, shared by both apps: navigator.onLine plus whether the status listeners are getting
// server data or only the local cache (snapshot metadata.fromCache). Pure rules live in @spot/shared connection.ts (deriveServer).
// Imported as "@spot/ui/phoneLink" (it starts Firestore through ./firebase.ts), never from the barrel.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { disableNetwork, enableNetwork, getDocFromServer, type DocumentReference } from "firebase/firestore";
import { PHONE_LIVE, RESUME_RECHECK_MS, knownLinksKey, parseKnownLinks, shouldNudge, type KnownLinks, type LinkView, type PhoneLink } from "@spot/shared";
import { db } from "./firebase.ts";

const onLine = () => (typeof navigator === "undefined" ? true : navigator.onLine);
const sources = new Map<string, boolean>(); // listener name -> its last snapshot came from the cache
const subs = new Set<() => void>();
// A fresh open starts "awaiting live": until a snapshot comes from the server, the apps show the last known status, not a verdict.
let state: PhoneLink = { ...PHONE_LIVE, online: onLine(), awaitingLive: true, awaitingSince: Date.now() };
const probes = new Map<string, DocumentReference>(); // status docs re-read from the server on resume
let lastNudgeAt: number | null = null;
let watcher: ReturnType<typeof setInterval> | undefined;

function recompute(freshLive = false) {
  const now = Date.now();
  const cached = [...sources.values()].some(Boolean);
  const online = onLine();
  // A snapshot the server just served proves the connection is live (one stuck on cache must not keep the others waiting).
  const gotLive = online && freshLive;
  const next: PhoneLink = {
    online,
    fromCache: cached,
    cachedSince: cached ? state.cachedSince ?? now : null,
    // Live = the server answered and the browser agrees it is online.
    liveAt: !cached && online && sources.size > 0 ? now : state.liveAt,
    awaitingLive: gotLive ? false : state.awaitingLive,
    awaitingSince: gotLive ? null : state.awaitingSince,
  };
  if (next.online !== state.online || next.fromCache !== state.fromCache || next.cachedSince !== state.cachedSince || next.liveAt !== state.liveAt || next.awaitingSince !== state.awaitingSince || next.awaitingLive !== state.awaitingLive) {
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
  recompute(!fromCache);
}
export function forgetSource(source: string) {
  sources.delete(source);
  recompute();
}

/** Register a status doc to re-read from the server when the app resumes after a while, so a quiet doc can't leave "Checking…" hanging. */
export function registerProbe(source: string, ref: DocumentReference): () => void {
  probes.set(source, ref);
  return () => void (probes.get(source) === ref && probes.delete(source));
}

/** Back on screen after a while: the cached values are history until the server confirms them again. */
function recheck() {
  if (state.awaitingLive) return;
  state = { ...state, awaitingLive: true, awaitingSince: Date.now() };
  subs.forEach((f) => f());
  probes.forEach((ref, source) => void getDocFromServer(ref).then(() => reportSnapshot(source, false)).catch(() => undefined));
}

/** Per-account last known link views (main and agent numbers), kept in localStorage so even the first paint can show them. */
export function recallLinks(uid: string): KnownLinks | null {
  try {
    return parseKnownLinks(localStorage.getItem(knownLinksKey(uid)));
  } catch {
    return null;
  }
}
/** Save the link views once they come from live data (never while checking, never "unknown"). */
export function rememberLinks(uid: string, links: KnownLinks) {
  try {
    const prev = recallLinks(uid) ?? {};
    const next: KnownLinks = { main: links.main && links.main !== "unknown" ? links.main : prev.main ?? null, agent: links.agent && links.agent !== "unknown" ? links.agent : prev.agent ?? null };
    if (next.main !== prev.main || next.agent !== prev.agent) localStorage.setItem(knownLinksKey(uid), JSON.stringify(next));
  } catch {
    /* private window or blocked storage: the app just starts without a last known status */
  }
}
/** Remember one slot's view when it is live; returns the stored value to hand to deriveServer as `known` (read once per account). */
export function useKnownLinks(uid: string): KnownLinks | null {
  return useMemo(() => recallLinks(uid), [uid]);
}
export function useRememberLink(uid: string, slot: keyof KnownLinks, link: LinkView, checking: boolean) {
  useEffect(() => {
    if (!checking && link !== "unknown") rememberLinks(uid, { [slot]: link });
  }, [uid, slot, link, checking]);
}

let hiddenAt: number | null = null;
if (typeof window !== "undefined") {
  // Back online or back on screen: re-evaluate now (the SDK reconnects by itself; check() only steps in if it stays stuck).
  const wake = () => {
    recompute();
    check();
  };
  window.addEventListener("online", wake);
  window.addEventListener("offline", () => recompute());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hiddenAt = Date.now();
    else if (document.visibilityState === "visible") {
      if (hiddenAt !== null && Date.now() - hiddenAt >= RESUME_RECHECK_MS) recheck();
      hiddenAt = null;
      wake();
    }
  });
}

const subscribe = (f: () => void) => (subs.add(f), () => subs.delete(f));
export const usePhoneLink = (): PhoneLink => useSyncExternalStore(subscribe, () => state, () => PHONE_LIVE);
