// Profile pictures, fetched lazily. WhatsApp's picture URLs expire and many people hide their photo, so each comic doc keeps
// `photoUrl` (a URL, or "none" when they hide it) and `photoAt` (when we last asked). Pure rules only; the worker owns the queue.

import { comicIdForPhone, normalizePhone } from "./people.ts";

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

// Pictures of things that are not a comic doc: WhatsApp groups (both apps) and a Comedy comic's curators. They live in
// users/{uid}/waPhotos/{jid}, one doc per WhatsApp id, with the same two fields. The worker writes them and the owner reads them, so a
// Comedy comic only ever has photos for the curators and groups they asked about.
export const WA_PHOTOS = "waPhotos";
/** Most ids a worker sweep puts back in the queue per kind, so a big account never makes a burst of WhatsApp calls. */
export const PHOTO_SWEEP_MAX = 30;
/** A sweep for one account runs about this often (the worker adds jitter). */
export const PHOTO_SWEEP_EVERY_MS = 6 * 3600_000;

/** A WhatsApp id a picture can be asked for: a person (c.us / lid) or a group (g.us). Anything else is ignored. */
export const isWaJid = (id: unknown): id is string => typeof id === "string" && id.length < 80 && /^[\d-]{5,40}@(c\.us|g\.us|lid)$/.test(id);

/** The WhatsApp id for a typed phone number (any format), or null when it isn't one. */
export const jidForPhone = (phone: string | undefined): string | null => {
  const d = phone ? normalizePhone(phone) : "";
  return d ? comicIdForPhone(d) : null;
};

/** One saved picture of a WhatsApp id (users/{uid}/waPhotos/{id}). */
export interface WaPhoto extends PhotoFields {
  id: string;
}
