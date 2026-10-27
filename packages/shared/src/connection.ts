// What the Nothing BOT apps show about the shared WhatsApp link and server. Pure: Curating and Comedy read the same
// Firestore docs (users/{uid}/session/state, session/agent, fleet/lease) and must agree on what they mean.
import type { SessionState } from "./types.ts";

/** session/state.lastSeen fresher than this counts as "the server is up" (same rule Curating uses). */
export const WORKER_STALE_MS = 90_000;

export type LinkView = "connected" | "offline" | "qr" | "starting" | "unlinked";

/** One view for a WhatsApp session doc (the main number or the agent number). */
export function linkView(s: SessionState | null | undefined, serverUp: boolean): LinkView {
  const status = s?.status ?? "idle";
  if (!serverUp && status !== "ready") return "offline";
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
