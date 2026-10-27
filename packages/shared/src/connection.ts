// What the Nothing BOT apps show about the shared WhatsApp link and server. Pure: Curate and Comedy read the same
// Firestore docs (users/{uid}/session/state, session/agent, fleet/lease) and must agree on what they mean.
import type { RestartMarker, SessionState } from "./types.ts";

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

export type LinkView = "connected" | "unresponsive" | "offline" | "restarting" | "qr" | "starting" | "unlinked";

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

export const isServerUp = (s: SessionState | null | undefined, now: number) => Boolean(s?.lastSeen && now - s.lastSeen < WORKER_STALE_MS);

/** When the server was last heard from (lastSeen is 0 after a clean shutdown; aliveAt survives it). */
export const serverLastSeen = (s: SessionState | null | undefined): number | null => s?.lastSeen || s?.aliveAt || null;

/** "+91 ••••• 12345": country code and the last five digits; the middle is hidden. */
export function maskPhoneTail(phone: string | null | undefined): string {
  const d = (phone ?? "").replace(/\D/g, "");
  if (!d) return "";
  const tail = d.slice(-5);
  // Country codes vary in length; 1 and 7 are one digit, most others two (91, 61, 44). Enough to say "which country", no more.
  const cc = d.length <= 5 ? "" : d[0] === "1" || d[0] === "7" ? d.slice(0, 1) : d.slice(0, 2);
  return `+${cc ? `${cc} ` : ""}••••• ${tail}`;
}
