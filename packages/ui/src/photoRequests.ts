// Shared by both apps' profile pictures: ask for a photo only once its avatar is on screen, batch the asks into one quiet command,
// and never ask twice per page load (a forced ask, for a picture that stopped loading, is allowed once more).
import { PHOTO_BATCH_MAX } from "@spot/shared";

const watchers = new Map<Element, () => void>();
let io: IntersectionObserver | undefined;

/** Runs `fn` once when `el` first scrolls into view (at once where IntersectionObserver is missing). Returns a cleanup. One observer serves every avatar. */
export function whenVisible(el: Element, fn: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") return fn(), () => undefined;
  io ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io?.unobserve(e.target);
      const f = watchers.get(e.target);
      watchers.delete(e.target);
      f?.();
    }
  });
  watchers.set(el, fn);
  io.observe(el);
  return () => (watchers.delete(el), io?.unobserve(el));
}

/**
 * A batching requester. `send` gets up to PHOTO_BATCH_MAX ids at a time, about 1.5 s after the first one is asked for.
 * `request(uid, id, force)` is safe to call from every avatar: duplicates are dropped.
 */
export function createPhotoRequester(send: (uid: string, ids: string[], force: boolean) => void, waitMs = 1500) {
  const asked = new Set<string>();
  const refreshed = new Set<string>();
  let pending: { uid: string; ids: Set<string>; force: boolean }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const batches = pending;
    pending = [];
    for (const b of batches) {
      const ids = [...b.ids];
      for (let i = 0; i < ids.length; i += PHOTO_BATCH_MAX) send(b.uid, ids.slice(i, i + PHOTO_BATCH_MAX), b.force);
    }
  };
  return (uid: string, id: string, force: boolean) => {
    const key = `${uid}|${id}`;
    const seen = force ? refreshed : asked;
    if (seen.has(key)) return;
    seen.add(key);
    let b = pending.find((x) => x.uid === uid && x.force === force);
    if (!b) pending.push((b = { uid, ids: new Set(), force }));
    b.ids.add(id);
    timer ??= setTimeout(flush, waitMs);
  };
}
