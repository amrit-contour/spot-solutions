// What the Nothing BOT apps show about the shared WhatsApp link and server. Pure: Curate and Comedy read the same
// Firestore docs (users/{uid}/session/state, session/agent, fleet/lease) and must agree on what they mean.
import type { NetOutage, RestartMarker, SessionState } from "./types.ts";

/** session/state.lastSeen fresher than this counts as "the server is up" (same rule Curate uses). */
export const WORKER_STALE_MS = 90_000;

/** How long a planned restart or update may take before the app stops saying "back in a minute" and calls it offline. */
export const RESTART_GRACE_MS = 3 * 60_000;

/** The marker a worker writes on a planned shutdown. `until` is clamped so a bad clock can't hide an outage for long. */
export const restartMarker = (now: number, reason: RestartMarker["reason"]): RestartMarker => ({ at: now, reason, until: now + RESTART_GRACE_MS });

/**
 * Is the server in a planned restart or update right now? The marker counts until `until` passes, and only while no heartbeat has
 * arrived since it was written (a lastSeen after `at` means the server is back, even if the marker is still on the doc).
 */
export function restartingNow(marker: RestartMarker | null | undefined, lastSeen: number | null | undefined, now: number): RestartMarker | null {
  if (!marker || typeof marker.at !== "number" || typeof marker.until !== "number") return null;
  if (now >= marker.until || now >= marker.at + RESTART_GRACE_MS) return null;
  if (lastSeen && lastSeen > marker.at) return null;
  return marker;
}

/** Up (fresh heartbeat), restarting (planned, marker still valid) or offline (silent and not announced). */
export type ServerState = "up" | "restarting" | "offline";
export function serverState(s: SessionState | null | undefined, now: number): ServerState {
  if (isServerUp(s, now)) return "up";
  return restartingNow(s?.restarting, s?.lastSeen, now) ? "restarting" : "offline";
}

export const restartLabel = (reason: RestartMarker["reason"] | undefined) => (reason === "update" ? "Updating server… back in a minute" : "Restarting server… back in a minute");

export type LinkView = "connected" | "unresponsive" | "offline" | "restarting" | "qr" | "starting" | "unlinked" | "unknown";

/** One view for a WhatsApp session doc (the main number or the agent number). `now` lets a planned restart read as "restarting", not "offline". */
export function linkView(s: SessionState | null | undefined, serverUp: boolean, now?: number): LinkView {
  const status = s?.status ?? "idle";
  if (!serverUp && now !== undefined && restartingNow(s?.restarting, s?.lastSeen, now)) return "restarting";
  if (!serverUp && status !== "ready") return "offline";
  // Linked and the server is up, but its WhatsApp page stopped answering (health.ts in the worker): not "connected".
  if (status === "ready" && s?.health && s.health !== "ok") return "unresponsive";
  if (status === "ready") return "connected";
  if (status === "qr") return "qr";
  if (status === "starting" || status === "authenticated") return "starting";
  return "unlinked";
}

/** Anything that carries a server heartbeat: a session doc or a servers/{id} doc. */
export type Beat = Partial<SessionState>;

export const isServerUp = (s: Beat | null | undefined, now: number) => Boolean(s?.lastSeen && now - s.lastSeen < WORKER_STALE_MS);

/** When the server was last heard from (lastSeen is 0 after a clean shutdown; aliveAt survives it). */
export const serverLastSeen = (s: Beat | null | undefined): number | null => s?.lastSeen || s?.aliveAt || null;

/* ---------- The phone's own connection ----------
 * "Server offline" is only true when the heartbeat is old AND this phone is really talking to Firestore. When the phone lost Wi-Fi or is
 * showing cached snapshots, an old heartbeat means nothing: say so (neutral) instead of blaming the server. */

/** Cached snapshots shorter than this are a normal cold start, not a lost connection. */
export const CACHE_GRACE_MS = 6_000;
/** Still cached this long while the browser says it is online: the listeners are stuck, reconnect them. */
export const NUDGE_AFTER_MS = 20_000;

export interface PhoneLink {
  /** navigator.onLine. */
  online: boolean;
  /** The last snapshot of the status docs came from the local cache, not the server (metadata.fromCache). */
  fromCache: boolean;
  /** When snapshots started coming from the cache (null while live). */
  cachedSince: number | null;
  /** When a snapshot last came from the server: "as of" in the offline note. */
  liveAt: number | null;
}
export const PHONE_LIVE: PhoneLink = { online: true, fromCache: false, cachedSince: null, liveAt: null };

export type PhoneState = "ok" | "offline" | "reconnecting";
export function phoneState(p: PhoneLink | null | undefined, now: number): PhoneState {
  if (!p) return "ok";
  if (!p.online) return "offline";
  if (p.fromCache && now - (p.cachedSince ?? now) >= CACHE_GRACE_MS) return "reconnecting";
  return "ok";
}

/** Reconnect Firestore (disableNetwork, enableNetwork) only when snapshots have been cached for a while although the browser says it is online. */
export function shouldNudge(p: PhoneLink, now: number, lastNudgeAt: number | null): boolean {
  if (!p.online || !p.fromCache || p.cachedSince === null) return false;
  if (now - p.cachedSince < NUDGE_AFTER_MS) return false;
  return lastNudgeAt === null || now - lastNudgeAt >= NUDGE_AFTER_MS;
}

/** "Up", "restarting", "offline" (the server is silent and this phone is live) or "unknown" (this phone can't tell). */
export type Reach = ServerState | "unknown";

/** The one answer every page uses for "is the server alive", "restarting" and what to show. */
export interface Derived {
  reach: Reach;
  /** reach === "up". */
  up: boolean;
  restarting: RestartMarker | null;
  /** Last heartbeat. */
  lastSeen: number | null;
  phone: PhoneState;
  /** For "unknown": when this phone last had live data (falls back to the last heartbeat it holds). */
  asOf: number | null;
}

/** Server state from its heartbeat doc (session/state or servers/{id}) and the phone's own connection. */
export function deriveServer(beat: Beat | null | undefined, now: number, phone?: PhoneLink | null): Derived {
  const ph = phoneState(phone, now);
  const lastSeen = serverLastSeen(beat);
  if (ph !== "ok") return { reach: "unknown", up: false, restarting: null, lastSeen, phone: ph, asOf: phone?.liveAt ?? lastSeen };
  const state = serverState(beat as SessionState | null, now);
  return { reach: state, up: state === "up", restarting: state === "restarting" ? (beat?.restarting ?? null) : null, lastSeen, phone: ph, asOf: null };
}

/** The WhatsApp link (main or agent session doc) given the server derivation. A silent server is never "connected". */
export function deriveLink(s: SessionState | null | undefined, d: Derived): LinkView {
  if (d.reach === "unknown") return "unknown";
  if (d.reach === "restarting") return "restarting";
  if (d.reach === "offline") return "offline";
  return linkView(s, true);
}

/** "10:42" in the viewer's time zone. */
export const clock = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** The neutral line for a phone that can't tell: never says the server is down. */
export function phoneNotice(d: Pick<Derived, "phone" | "asOf">): string {
  const asOf = d.asOf ? ` (as of ${clock(d.asOf)})` : "";
  return d.phone === "offline" ? `You're offline: showing the last known status${asOf}` : `Reconnecting… showing the last known status${asOf}`;
}

/** "Server not reachable since 10:42" for a silent server. */
export const unreachableNotice = (d: Pick<Derived, "lastSeen">) => (d.lastSeen ? `Server not reachable since ${clock(d.lastSeen)}` : "Server not reachable");

/** How long after an outage ends the apps keep mentioning it. */
export const NET_NOTE_MS = 6 * 3600_000;
/** "Server lost internet 03:30–03:36", from what the server wrote when its internet came back. */
export function netNotice(net: NetOutage | null | undefined, now: number): string | null {
  if (!net || typeof net.since !== "number" || typeof net.downFrom !== "number" || net.downFrom >= net.since) return null;
  if (now - net.since > NET_NOTE_MS) return null;
  return `Server lost internet ${clock(net.downFrom)}–${clock(net.since)}`;
}

/** "+91 ••••• 12345": country code and the last five digits; the middle is hidden. */
export function maskPhoneTail(phone: string | null | undefined): string {
  const d = (phone ?? "").replace(/\D/g, "");
  if (!d) return "";
  const tail = d.slice(-5);
  // Country codes vary in length; 1 and 7 are one digit, most others two (91, 61, 44). Enough to say "which country", no more.
  const cc = d.length <= 5 ? "" : d[0] === "1" || d[0] === "7" ? d.slice(0, 1) : d.slice(0, 2);
  return `+${cc ? `${cc} ` : ""}••••• ${tail}`;
}
