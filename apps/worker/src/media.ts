// Pictures in messages, the server's side (docs/architecture.md, "Pictures in messages"). Storage is touched only through the small
// `MediaStore` below, so the rules are tested with a fake. Real Storage is the Admin SDK (rules don't apply to it), which is why every
// path is checked against the account the command belongs to before anything is read, sent or deleted.
import {
  ATTACHMENT_ORPHAN_MS,
  MEDIA_CACHE_TTL_MS,
  MEDIA_FETCH_MAX_BYTES,
  OUTBOX_TTL_MS,
  attachmentsPrefix,
  checkFetchedMedia,
  cleanFileName,
  expiredFiles,
  imagePathsInUse,
  mediaCachePath,
  mediaCachePrefix,
  outboxPrefix,
  parseImagePath,
  sendImageProblem,
  type FetchMediaResult,
} from "@spot/shared";

export interface MediaStore {
  /** Size and type as stored, or null when there's no such file. */
  meta(path: string): Promise<{ size: number; contentType: string } | null>;
  read(path: string): Promise<Buffer>;
  write(path: string, data: Buffer, contentType: string): Promise<void>;
  remove(path: string): Promise<void>;
  list(prefix: string): Promise<{ name: string; createdAt: number }[]>;
}

/** The real store: the project's default bucket through the Admin SDK. */
export const storageStore: MediaStore = {
  async meta(path) {
    const f = (await bucket()).file(path);
    const [exists] = await f.exists();
    if (!exists) return null;
    const [m] = await f.getMetadata();
    return { size: Number(m.size ?? 0), contentType: String(m.contentType ?? "") };
  },
  async read(path) {
    const [data] = await (await bucket()).file(path).download();
    return data;
  },
  async write(path, data, contentType) {
    await (await bucket()).file(path).save(data, { resumable: false, contentType, metadata: { cacheControl: "private, no-store" } });
  },
  async remove(path) {
    await (await bucket()).file(path).delete({ ignoreNotFound: true });
  },
  async list(prefix) {
    const [files] = await (await bucket()).getFiles({ prefix });
    return files.map((f) => ({ name: f.name, createdAt: Date.parse(String(f.metadata.timeCreated ?? "")) || Date.now() }));
  },
};
const bucket = async () => (await import("firebase-admin/storage")).getStorage().bucket();

export interface LoadedImage {
  mime: string;
  /** Base64, no prefix: what whatsapp-web.js MessageMedia takes. */
  data: string;
  name: string;
}

/**
 * A picture the app uploaded, ready to send. The path must be one of this account's own upload paths (never another account's,
 * whatever a settings document says), and the stored file must be a small picture. The error text is for the curator.
 */
export async function loadOutImage(uid: string, image: { path: string; name?: string }, store: MediaStore = storageStore): Promise<LoadedImage> {
  if (!parseImagePath(uid, image.path)) throw new Error("That picture isn't available to send. Pick it again.");
  const meta = await store.meta(image.path);
  if (!meta) throw new Error("The picture is no longer there. Attach it again.");
  const problem = sendImageProblem(meta);
  if (problem) throw new Error(problem);
  const data = await store.read(image.path);
  return { mime: meta.contentType.toLowerCase(), data: data.toString("base64"), name: cleanFileName(image.name ?? "") };
}

/** After a send: delete a one-time upload. A kept picture (a template's or a scheduled post's) is never deleted here. */
export async function dropSentImage(uid: string, path: string, store: MediaStore = storageStore): Promise<void> {
  const p = parseImagePath(uid, path);
  if (p?.scope === "outbox") await store.remove(path).catch(() => undefined);
}

/**
 * fetch_media's second half: a picture WhatsApp handed over (or nothing: expired) goes into this account's cache folder, and the
 * app is told where. Too big or not a picture: nothing is stored.
 */
export async function cachePicture(uid: string, messageId: string, media: { mimetype?: string; data?: string } | null | undefined, store: MediaStore = storageStore, now = Date.now()): Promise<FetchMediaResult> {
  const bytes = media?.data ? Math.floor((media.data.length * 3) / 4) : 0;
  const bad = checkFetchedMedia(media?.data ? { mime: media.mimetype, bytes } : null);
  if (bad) return { path: null, reason: bad };
  const path = mediaCachePath(uid, messageId);
  const buf = Buffer.from(media!.data!, "base64");
  const mime = String(media!.mimetype).toLowerCase();
  await store.write(path, buf, mime);
  return { path, mime, bytes: buf.length, expiresAt: now + MEDIA_CACHE_TTL_MS };
}

/** Size known before downloading (WhatsApp's own figure): too big is answered without fetching a thing. */
export const knownTooBig = (size: number | undefined) => Boolean(size && size > MEDIA_FETCH_MAX_BYTES);

/**
 * The backstop: fetched pictures older than an hour and uploads that were never sent (older than OUTBOX_TTL_MS) are deleted. With
 * `inUse` (the kept pictures templates and scheduled posts still point at), a kept picture nothing uses for a day is deleted too.
 */
export async function sweepMedia(uid: string, store: MediaStore = storageStore, now = Date.now(), inUse?: Set<string>): Promise<number> {
  const orphans = inUse ? expiredFiles(await store.list(attachmentsPrefix(uid)), now, ATTACHMENT_ORPHAN_MS).filter((n) => !inUse.has(n)) : [];
  const gone = [...expiredFiles(await store.list(mediaCachePrefix(uid)), now, MEDIA_CACHE_TTL_MS), ...expiredFiles(await store.list(outboxPrefix(uid)), now, OUTBOX_TTL_MS), ...orphans];
  await Promise.all(gone.map((name) => store.remove(name).catch(() => undefined)));
  return gone.length;
}

const lastSweep = new Map<string, number>();
const lastOrphanCheck = new Map<string, number>();
const SWEEP_EVERY_MS = 10 * 60_000;
const ORPHAN_CHECK_EVERY_MS = 60 * 60_000;

/** The kept pictures this account's messages still use, read fresh (not from the cache: a half-loaded cache would call everything an orphan). */
async function pictureRefs(uid: string): Promise<Set<string>> {
  const { col, userRef } = await import("./firebase.ts"); // not at the top: this file is tested without Firebase
  const [user, shows] = await Promise.all([userRef(uid).get(), col(uid, "shows").get()]);
  return imagePathsInUse(uid, user.data()?.settings, shows.docs.map((d) => d.data()));
}

/** Scheduler hook: sweep each account about every ten minutes (orphaned kept pictures hourly). Errors are logged, never thrown. */
export async function maybeSweepMedia(uid: string, now = Date.now()): Promise<void> {
  if (now - (lastSweep.get(uid) ?? 0) < SWEEP_EVERY_MS) return;
  lastSweep.set(uid, now);
  let inUse: Set<string> | undefined;
  if (now - (lastOrphanCheck.get(uid) ?? 0) >= ORPHAN_CHECK_EVERY_MS) {
    lastOrphanCheck.set(uid, now);
    inUse = await pictureRefs(uid);
  }
  const n = await sweepMedia(uid, storageStore, now, inUse);
  if (n) console.log(`[media] ${uid}: ${n} expired picture${n === 1 ? "" : "s"} deleted`);
}
