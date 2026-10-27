// Profile pictures, fetched lazily. WhatsApp's picture URLs expire and many people hide their photo, so each comic doc keeps
// `photoUrl` (a URL, or "none" when they hide it) and `photoAt` (when we last asked). Pure rules only; the worker owns the queue.

export const PHOTO_NONE = "none";
/** A photo (or a "none") is asked about again after this long. */
export const PHOTO_REFRESH_MS = 7 * 24 * 3600_000;
/** The app asking for a fresh URL because the image failed to load: not more often than this per comic. */
export const PHOTO_FORCE_MIN_MS = 5 * 60_000;
/** The worker asks WhatsApp for at most one picture per this long. */
export const PHOTO_INTERVAL_MS = 2000;
/** Most ids the app sends in one request. */
export const PHOTO_BATCH_MAX = 40;

export interface PhotoFields {
  photoUrl?: string | null;
  photoAt?: number | null;
}

/** Should the worker ask WhatsApp for this comic's picture now? `force` is the app saying the saved URL no longer loads. */
export function photoDue(c: PhotoFields, now: number, force = false): boolean {
  if (!c.photoAt) return true;
  const age = now - c.photoAt;
  return force ? age >= PHOTO_FORCE_MIN_MS : age >= PHOTO_REFRESH_MS;
}

/** The URL to show, or null (never asked, hidden, or not a web URL). */
export function photoSrc(c: PhotoFields): string | null {
  const u = c.photoUrl;
  return u && u !== PHOTO_NONE && /^https:\/\//.test(u) ? u : null;
}
