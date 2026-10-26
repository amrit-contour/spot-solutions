// Thin wrappers over vault.ts for the caller duties the vault documents.
import { adoptCloudGen, prepareLogin, uploadLogin, VaultFailure } from "./vault.ts";

type Source = "local" | "cloud" | "fresh";

/** Retries after the first attempt: 2, 4, 8, 16 s. */
export const PREPARE_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000];

/**
 * A failed restore is either deterministic (sha mismatch, undecryptable, object confirmed missing, no key, meta without an
 * object: retrying cannot help, so the account links again with a QR) or transient (network, Firestore, disk: retry,
 * and if it keeps failing do NOT show a QR, because the login is probably fine).
 */
export const classifyPrepareError = (e: unknown): "deterministic" | "transient" => (e instanceof VaultFailure ? "deterministic" : "transient");

/** Run `prepare`, retrying transient failures with backoff. Returns "fresh" only for deterministic failures; throws otherwise. */
export async function prepareWithRetry(
  prepare: () => Promise<Source>,
  o: { sleep?: (ms: number) => Promise<void>; backoffMs?: number[]; log?: (msg: string) => void } = {},
): Promise<Source> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoff = o.backoffMs ?? PREPARE_BACKOFF_MS;
  for (let i = 0; ; i++) {
    try {
      return await prepare();
    } catch (e) {
      if (classifyPrepareError(e) === "deterministic") {
        o.log?.(`login restore failed for good, starting fresh: ${(e as Error).message}`);
        return "fresh";
      }
      if (i >= backoff.length) throw e;
      o.log?.(`login restore failed (${(e as Error).message}); retry ${i + 1}/${backoff.length} in ${backoff[i] / 1000}s`);
      await sleep(backoff[i]);
    }
  }
}

/**
 * Which login to start from. Returns "fresh" (a QR) only when there is no cloud login or it is unusable for good. A transient
 * error (network, IO) is retried 4 times, then thrown: the caller schedules a restart and shows no QR or scan_needed push.
 * With `allowStaleLocal` (the caller has failed repeatedly) the local profile is used instead of throwing.
 */
export function prepareLoginSafe(uid: string, o: { allowStaleLocal?: boolean } = {}): Promise<Source> {
  return prepareWithRetry(() => prepareLogin(uid, o), { log: (m) => console.warn(`[fleet] ${uid} ${m}`) });
}

export { adoptCloudGen, uploadLogin };
