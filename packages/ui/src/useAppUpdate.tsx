/// <reference path="./app-version.d.ts" />
import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { isTypingTarget, isUpdateAvailable, parseVersionInfo, shouldCheckNow, updatePromptDecision, type VersionInfo } from "@spot/shared";
import { Button } from "./ui";
import { IconRefresh } from "./icons";

// What is running, what is deployed, and how to switch. One shared store, so the Settings row and the toast agree.
const RUNNING: VersionInfo = {
  version: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev",
  builtAt: typeof __APP_BUILT_AT__ === "string" ? __APP_BUILT_AT__ : "",
};
const POLL_MS = 10 * 60_000;

export type UpdateStatus = "idle" | "checking" | "current" | "available";
interface State {
  running: VersionInfo;
  served: VersionInfo | null;
  /** A new service worker has already taken over; a reload runs the new release. */
  swReady: boolean;
  checking: boolean;
  lastCheckedAt: number | null;
  /** The last check could not reach the server. */
  failed: boolean;
}

let state: State = { running: RUNNING, served: null, swReady: false, checking: false, lastCheckedAt: null, failed: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));

const available = (s: State) => s.swReady || isUpdateAvailable(s.running, s.served);
const servedVersion = (s: State) => s.served?.version ?? (s.swReady ? "next" : null);

let registration: ServiceWorkerRegistration | undefined;
let started = false;

/** Asks the server which release is deployed. Never throws; offline or a non-JSON reply just leaves the state alone. */
export async function checkForUpdate(opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force && !shouldCheckNow({ lastCheckedAt: state.lastCheckedAt, now: Date.now(), checking: state.checking })) return;
  set({ checking: true });
  try {
    void registration?.update().catch(() => {});
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
    const served = res.ok ? parseVersionInfo(await res.json().catch(() => null)) : null;
    set({ served: served ?? state.served, failed: !served, lastCheckedAt: Date.now(), checking: false });
  } catch {
    set({ failed: true, lastCheckedAt: Date.now(), checking: false });
  }
}

/** Switches to the newest release: the waiting worker's reload if there is one, otherwise a clean reload (caches cleared). */
export async function updateNow(): Promise<void> {
  if (!state.swReady) {
    try {
      const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
      await Promise.all(regs.map((r) => r.unregister()));
      const keys = (await globalThis.caches?.keys?.()) ?? [];
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {
      /* reload anyway */
    }
  }
  location.reload();
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  const onResume = () => {
    if (document.visibilityState === "visible") void checkForUpdate();
  };
  window.addEventListener("focus", onResume);
  document.addEventListener("visibilitychange", onResume);
  window.setInterval(onResume, POLL_MS);
  void checkForUpdate({ force: true });
  if (import.meta.env.PROD) {
    // vite-plugin-pwa (autoUpdate): the new worker activates itself; onNeedReload replaces its automatic reload so a
    // release never reloads the page under someone who is typing.
    void import("virtual:pwa-register").then(({ registerSW }) =>
      registerSW({
        immediate: true,
        onRegisteredSW: (_url, r) => void (registration = r),
        onNeedReload: () => set({ swReady: true }),
      }),
    ).catch(() => {});
  }
}

export function useAppUpdate() {
  useEffect(start, []);
  const s = useSyncExternalStore(subscribe, () => state);
  const status: UpdateStatus = available(s) ? "available" : s.checking && !s.served ? "checking" : s.served ? "current" : "idle";
  return {
    running: s.running,
    served: s.served,
    status,
    checking: s.checking,
    failed: s.failed,
    updateAvailable: available(s),
    check: () => checkForUpdate({ force: true }),
    updateNow,
  };
}

let promptedFor: string | null = null;
const TOAST_ID = "app-update";

/** Mount once near the app root: tells the person a new release is ready, once per version, never while they type. */
export function UpdatePrompt() {
  const s = useSyncExternalStore(subscribe, () => state);
  useEffect(start, []);
  const version = servedVersion(s);
  const isAvailable = available(s);
  useEffect(() => {
    if (!isAvailable || !version) return;
    let cancelled = false;
    const attempt = () => {
      if (cancelled) return;
      const d = updatePromptDecision({ available: true, version, promptedFor, inputFocused: isTypingTarget(document.activeElement as HTMLElement | null) });
      if (d !== "show") return;
      promptedFor = version;
      toast(
        <div className="flex w-full items-center gap-3">
          <IconRefresh aria-hidden className="icon size-5 flex-none" />
          <span className="min-w-0 flex-1 type-body-m">A new version is ready</span>
          <Button size="sm" variant="tonal" onClick={() => void updateNow()}>Update</Button>
        </div>,
        { id: TOAST_ID, duration: Infinity, dismissible: true },
      );
    };
    attempt();
    // Typing right now: try again when the field loses focus.
    document.addEventListener("focusout", attempt, true);
    return () => {
      cancelled = true;
      document.removeEventListener("focusout", attempt, true);
    };
  }, [isAvailable, version]);
  return null;
}
