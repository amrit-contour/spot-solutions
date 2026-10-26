// Pure rules for the always-on Google Contacts link: who may connect, and how comic edits are debounced into batches.
import { AppError } from "./core";

export const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts";

/** Wait this long after the latest edit before writing, so a burst of edits becomes one batch. */
export const DEBOUNCE_MS = 45_000;
/** ...but never hold the first edit longer than this. */
export const MAX_WAIT_MS = 5 * 60_000;
/** Up to this many comics are saved automatically. More at once (an import) is left for the reviewed "Sync all". */
export const AUTO_MAX = 25;
/** The queue document stops collecting ids past this and just remembers it overflowed. */
export const COLLECT_CAP = 200;
/** A run that crashes frees its lease after this. */
export const LEASE_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 5;

export interface QueueDoc {
  ids: string[];
  overflow: boolean;
  firstAt: number;
  dueAt: number;
  attempts: number;
  /** While in the future, a run owns this entry. */
  leaseUntil: number;
}

/** A comic edit arrived: add it and push the due time back (capped), without cancelling a run in flight. */
export function enqueue(prev: QueueDoc | undefined, id: string, now: number): QueueDoc {
  const firstAt = prev?.firstAt ?? now;
  const ids = prev?.ids ?? [];
  let overflow = prev?.overflow ?? false;
  const next = ids.includes(id) ? ids : [...ids, id];
  if (next.length > COLLECT_CAP) overflow = true;
  let dueAt = Math.min(now + DEBOUNCE_MS, firstAt + MAX_WAIT_MS);
  // Backing off after a failure: an edit must not make the retry earlier.
  if (prev && prev.attempts > 0) dueAt = Math.max(dueAt, prev.dueAt);
  return { ids: next.slice(0, COLLECT_CAP), overflow, firstAt, dueAt, attempts: prev?.attempts ?? 0, leaseUntil: prev?.leaseUntil ?? 0 };
}

export const isDue = (q: QueueDoc, now: number) => q.dueAt <= now && q.leaseUntil <= now;

/** Too many at once to save without the curator looking at the list. */
export const isBulk = (q: Pick<QueueDoc, "ids" | "overflow">) => q.overflow || q.ids.length > AUTO_MAX;

/** After a run finished `processed`: what is left (edits that arrived meanwhile), or null when the entry can go. */
export function afterRun(current: QueueDoc | undefined, processed: string[], now: number, clearOverflow = false): QueueDoc | null {
  if (!current) return null;
  const overflow = current.overflow && !clearOverflow;
  const done = new Set(processed);
  const ids = current.ids.filter((i) => !done.has(i));
  if (!ids.length && !overflow) return null;
  return { ...current, ids, overflow, attempts: 0, leaseUntil: 0, dueAt: Math.max(current.dueAt, now), firstAt: now };
}

export const retryDelayMs = (attempts: number) => Math.min(2 ** attempts * 60_000, 60 * 60_000);

/** After a failed run: try again later, or give up (null) once the attempts are used. */
export function afterFailure(current: QueueDoc | undefined, now: number): QueueDoc | null {
  if (!current) return null;
  const attempts = current.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) return null;
  return { ...current, attempts, leaseUntil: 0, dueAt: now + retryDelayMs(attempts) };
}

export interface ComicBits {
  name?: string;
  phone?: string;
  nameSource?: string;
}

/**
 * Should this write to a comic document reach Google? Only a manual name (typed by the curator) that is new or changed,
 * or a changed number. Names WhatsApp filled in are never pushed on their own.
 */
export function shouldQueueComic(before: ComicBits | undefined, after: ComicBits | undefined): boolean {
  if (!after || !after.name?.trim() || !after.phone) return false;
  if (after.nameSource !== undefined && after.nameSource !== "manual") return false;
  if (!before) return true;
  return before.name !== after.name || before.phone !== after.phone;
}

/** The Google account the curator picked must be the one they signed in to Spot Solutions with, and verified. */
export function checkAccountEmail(google: { email?: string; verified?: boolean }, firebase: { email?: string; verified: boolean }): { ok: true; email: string } | { ok: false; message: string } {
  const g = google.email?.trim().toLowerCase();
  const f = firebase.email?.trim().toLowerCase();
  if (!g || google.verified !== true) return { ok: false, message: "Google didn't confirm that email address. Try again." };
  if (!f || !firebase.verified) return { ok: false, message: "Your sign-in email isn't verified." };
  if (g !== f) return { ok: false, message: `Pick the Google account you signed in with (${f}). You picked ${g}.` };
  return { ok: true, email: g };
}

export const hasContactsScope = (scope: unknown) => typeof scope === "string" && scope.split(/\s+/).includes(CONTACTS_SCOPE);

/** Google says the refresh token is dead: the person removed access, or the grant expired. */
export const isInvalidGrant = (status: number, body: { error?: string } | null) => (status === 400 || status === 401) && body?.error === "invalid_grant";

export function requireCode(v: unknown): string {
  if (typeof v !== "string" || v.length < 10 || v.length > 2048 || /\s/.test(v)) throw new AppError("invalid-argument", "That sign-in didn't work. Try again.");
  return v;
}
