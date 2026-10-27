// Pictures in messages. Sending: the app squeezes a picture to a JPEG, puts it in Firebase Storage under the curator's own folder,
// and tells the server where it is (send_image, or an `image` on a message). Viewing: nothing is downloaded until the curator taps
// View; the server then fetches that one message's picture from WhatsApp into a short-lived cache file and tells the app where
// it is (fetch_media). Pure rules only here (paths, limits, validation), so the app, the server and the tests agree.

/** The longest side of a picture the app sends, in pixels. */
export const IMAGE_MAX_EDGE = 1600;
/** JPEG quality the app starts at. */
export const IMAGE_JPEG_QUALITY = 0.8;
/** The biggest file the app will open to prepare (a phone camera photo is typically 3 to 12 MB). */
export const IMAGE_PICK_MAX_BYTES = 30 * 1024 * 1024;
/** The biggest prepared picture the app uploads and the server sends. Storage rules enforce the same number. */
export const IMAGE_SEND_MAX_BYTES = 4 * 1024 * 1024;
/** WhatsApp caption length the app allows. */
export const IMAGE_CAPTION_MAX = 1000;
/** The biggest picture the server fetches from WhatsApp to show on View (WhatsApp's own photo limit is about this). */
export const MEDIA_FETCH_MAX_BYTES = 16 * 1024 * 1024;
/** A fetched picture lives this long in the cache, then the server deletes it. */
export const MEDIA_CACHE_TTL_MS = 60 * 60_000;
/** A sent picture's upload is deleted by the server as soon as it has been sent; this is the backstop for a send that never ran. */
export const OUTBOX_TTL_MS = 6 * 60 * 60_000;

/** A kept picture (attachments) that nothing refers to any more is deleted after this long (time to save an edit, or to undo). */
export const ATTACHMENT_ORPHAN_MS = 24 * 60 * 60_000;

/** What can be uploaded to send. The app always produces JPEG; the server accepts what WhatsApp renders as a photo. */
export const SEND_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export type SendImageMime = (typeof SEND_IMAGE_MIMES)[number];

/**
 * outbox: a one-time upload for a message that is sent once (a chat message, a reply, an offer). The server deletes it after the send.
 * attachments: a picture saved on a message that is sent again and again (a template, a scheduled group post). It stays until the
 * curator removes the picture or the message. It is the curator's own message content, never a chat's.
 */
export type ImageScope = "outbox" | "attachments";
export const IMAGE_SCOPES: readonly ImageScope[] = ["outbox", "attachments"];

/** A picture attached to an outgoing message: where it is in Storage, and a file name for WhatsApp. */
export interface MessageImage {
  path: string;
  name?: string;
}

const ID = /^[A-Za-z0-9_-]{8,64}$/;
export const isImageId = (id: string) => ID.test(id);

export const imagePath = (uid: string, scope: ImageScope, id: string) => `users/${uid}/${scope}/${id}.jpg`;

/** The scope and id of a picture path, only when it is exactly one of this user's own upload paths. Anything else is null. */
export function parseImagePath(uid: string, path: unknown): { scope: ImageScope; id: string } | null {
  if (typeof path !== "string" || !uid || /[/\\]/.test(uid)) return null;
  const prefix = `users/${uid}/`;
  if (!path.startsWith(prefix)) return null;
  const m = /^(outbox|attachments)\/([^/]+)\.jpg$/.exec(path.slice(prefix.length));
  return m && isImageId(m[2]) ? { scope: m[1] as ImageScope, id: m[2] } : null;
}

/** A message id as a file name: letters, digits, dot, dash and underscore only. */
export function safeMediaId(messageId: string): string {
  const s = String(messageId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  if (!s || /^\.+$/.test(s)) throw new Error("Which message?");
  return s;
}

export const mediaCachePrefix = (uid: string) => `users/${uid}/media-cache/`;
export const mediaCachePath = (uid: string, messageId: string) => `${mediaCachePrefix(uid)}${safeMediaId(messageId)}`;
export const outboxPrefix = (uid: string) => `users/${uid}/outbox/`;
export const attachmentsPrefix = (uid: string) => `users/${uid}/attachments/`;

/**
 * Every kept picture something still uses: the settings messages (templates), each show's scheduled group posts and its after-show
 * message. Anything in attachments/ that is not in this set (a removed picture, a copy that was never saved) is an orphan.
 */
export function imagePathsInUse(
  uid: string,
  settings: { messages?: Record<string, unknown> | null } | null | undefined,
  shows: { groupPosts?: { message?: unknown }[] | null; cleanup?: { message?: unknown } | null }[],
): Set<string> {
  const out = new Set<string>();
  const add = (msg: unknown) => {
    const img = msg && typeof msg === "object" ? cleanImage((msg as { image?: unknown }).image, uid) : undefined;
    if (img) out.add(img.path);
  };
  for (const m of Object.values(settings?.messages ?? {})) add(m);
  for (const s of shows) {
    for (const p of s.groupPosts ?? []) add(p.message);
    add(s.cleanup?.message);
  }
  return out;
}

/** A message's picture, cleaned: only a path inside this user's own upload folders survives. */
export function cleanImage(raw: unknown, uid?: string): MessageImage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Partial<MessageImage>;
  if (typeof o.path !== "string") return undefined;
  if (uid ? !parseImagePath(uid, o.path) : !/^users\/[^/]+\/(outbox|attachments)\/[A-Za-z0-9_-]{8,64}\.jpg$/.test(o.path)) return undefined;
  const name = typeof o.name === "string" ? cleanFileName(o.name) : "";
  return { path: o.path, ...(name && { name }) };
}

export function cleanFileName(name: string, fallback = "photo.jpg"): string {
  const n = String(name ?? "").replace(/[^\w.\- ]/g, "").trim().slice(0, 60);
  return n || fallback;
}

export interface SendImage {
  path: string;
  scope: ImageScope;
  caption: string;
  name: string;
}

/** send_image: checks what the app sent. The path must be one of this user's own upload paths; the caption is trimmed and capped. */
export function parseSendImage(uid: string, p: Record<string, unknown>): SendImage {
  const parsed = parseImagePath(uid, p.path);
  if (!parsed) throw new Error("That picture isn't available to send. Pick it again.");
  return { path: String(p.path), scope: parsed.scope, caption: String(p.caption ?? "").trim().slice(0, IMAGE_CAPTION_MAX), name: cleanFileName(String(p.name ?? "")) };
}

/** fetch_media: the message to fetch. The chat itself is checked by the server (roster comic or linked group, not Never read). */
export function parseFetchMedia(p: Record<string, unknown>): { messageId: string } {
  const id = String(p.messageId ?? "").trim();
  if (!id || id.length > 300) throw new Error("Which message?");
  safeMediaId(id);
  return { messageId: id };
}

/** Why a picture can't be used, from what is known of the file (stored metadata): null when it's fine. */
export function sendImageProblem(meta: { size?: number | string | null; contentType?: string | null }): string | null {
  const type = String(meta.contentType ?? "").toLowerCase();
  if (!(SEND_IMAGE_MIMES as readonly string[]).includes(type)) return "Only pictures can be sent from here.";
  const size = Number(meta.size ?? 0);
  if (!size) return "That picture is empty. Pick it again.";
  if (size > IMAGE_SEND_MAX_BYTES) return "That picture is too big to send. Pick a smaller one.";
  return null;
}

export type FetchMediaFailure = "expired" | "too_big" | "not_image";

/** fetch_media's answer: where the picture is (Storage path, readable only by its owner), or why there isn't one. */
export type FetchMediaResult = { path: string; mime: string; bytes: number; expiresAt: number } | { path: null; reason: FetchMediaFailure };

/** Can a downloaded picture be shown? `bytes` is the size of the data. */
export function checkFetchedMedia(m: { mime?: string | null; bytes: number } | null | undefined): FetchMediaFailure | null {
  if (!m || !m.bytes) return "expired";
  if (!String(m.mime ?? "").toLowerCase().startsWith("image/")) return "not_image";
  if (m.bytes > MEDIA_FETCH_MAX_BYTES) return "too_big";
  return null;
}

/** What to tell the curator when View doesn't produce a picture. */
export const FETCH_FAILURE_TEXT: Record<FetchMediaFailure | "offline", string> = {
  expired: "This photo is no longer on WhatsApp. It may have expired or been deleted.",
  too_big: "This photo is too big to show here. Open it on your phone.",
  not_image: "This isn't a photo, so it can't be shown here. Open it on your phone.",
  offline: "Your server is offline, so the photo can't be fetched right now. Try again when it's back.",
};

/** "340 KB", "1.2 MB"; empty when the size isn't known. */
export function formatBytes(n: number | null | undefined): string {
  if (!n || n < 0) return "";
  if (n < 1000) return `${Math.round(n)} B`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} KB`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)} MB`;
}

/** Cache and outbox files older than their lifetime, from a listing: the names to delete. */
export function expiredFiles(files: { name: string; createdAt: number }[], now: number, ttlMs: number): string[] {
  return files.filter((f) => now - f.createdAt >= ttlMs).map((f) => f.name);
}
