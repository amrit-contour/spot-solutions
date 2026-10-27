// Did this server's own internet go down? Firestore calls fail with UNAVAILABLE / EHOSTUNREACH while it is, and nothing can be written
// then, so the outage is reported once writes work again: servers/{id}.net and each held session's net ("Server lost internet 03:30-03:36").
import type { NetOutage } from "@spot/shared";

/** Shorter than this is a blip, not worth telling anyone about. */
export const MIN_OUTAGE_MS = 45_000;

const NET_ERROR = /UNAVAILABLE|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|DEADLINE_EXCEEDED|\b14 UNAVAILABLE/i;

/** A gRPC / socket failure that means "can't reach Google", as opposed to a bug or a permission error. */
export function isNetError(e: unknown): boolean {
  const x = e as { code?: unknown; message?: unknown } | null;
  return NET_ERROR.test(`${x?.code ?? ""} ${x?.message ?? ""}`) || x?.code === 14 || x?.code === 4;
}

export function createNetWatch() {
  let downFrom: number | null = null;
  return {
    /** A Firestore call failed. Only network-looking errors start an outage. */
    fail(e: unknown, now: number) {
      if (downFrom === null && isNetError(e)) downFrom = now;
    },
    /** The outage to report now that a write succeeded, if there was a long enough one. Call `clear` once it has been written. */
    pending(now: number): NetOutage | null {
      return downFrom !== null && now - downFrom >= MIN_OUTAGE_MS ? { ok: true, since: now, downFrom } : null;
    },
    clear: () => void (downFrom = null),
    get down() {
      return downFrom;
    },
  };
}
