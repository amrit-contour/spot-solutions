// Pictures in messages, the app's side (docs/architecture.md, "Pictures in messages").
//   Sending: pick a picture, squeeze it to a JPEG (1600 px, quality 0.8), upload it to the curator's own Storage folder, and hand the
//   path to a command (or put it on a message). Nothing is sent through Firestore.
//   Viewing: nothing is downloaded until View is tapped. Then fetch_media makes the server put that one picture in a short-lived
//   cache file; this file reads it, shows it, and deletes the cache file when the chat is closed.
import { getApp } from "firebase/app";
import type { FirebaseStorage } from "firebase/storage";
import { FETCH_FAILURE_TEXT, IMAGE_JPEG_QUALITY, IMAGE_MAX_EDGE, IMAGE_PICK_MAX_BYTES, IMAGE_SEND_MAX_BYTES, fitWithin, imagePath, parseImagePath, type FetchMediaResult, type ImageScope } from "@spot/shared";
import { runCommand } from "./data";

const emulate = import.meta.env.DEV && import.meta.env.VITE_USE_EMULATORS === "1";

let ready: Promise<{ storage: FirebaseStorage; sdk: typeof import("firebase/storage") }> | null = null;
/** Firebase Storage, loaded the first time a picture is used (it is not in the app's first load). */
function storageSdk() {
  ready ??= import("firebase/storage").then((sdk) => {
    const app = getApp();
    const bucket = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || app.options.storageBucket || `${app.options.projectId}.firebasestorage.app`;
    const storage = sdk.getStorage(app, `gs://${bucket}`);
    if (emulate) sdk.connectStorageEmulator(storage, "127.0.0.1", Number(import.meta.env.VITE_EMULATOR_STORAGE_PORT || 9199));
    return { storage, sdk };
  });
  return ready;
}

/** A random file name for an upload: letters and digits, 20 characters. */
export function newImageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 20);
}

export interface PreparedImage {
  blob: Blob;
  /** An object URL for the thumbnail. Call URL.revokeObjectURL when done with it. */
  previewUrl: string;
  bytes: number;
  /** The picked file's name with a .jpg ending. */
  name: string;
  width: number;
  height: number;
}

/** Any picked picture becomes a JPEG of at most 1600 px a side, squeezed under what a send allows. */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith("image/")) throw new Error("Pick a photo.");
  if (file.size > IMAGE_PICK_MAX_BYTES) throw new Error("That photo is over 30 MB. Pick a smaller one.");
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  if (!bmp) throw new Error("That photo couldn't be opened.");
  const base = fitWithin(bmp.width, bmp.height, IMAGE_MAX_EDGE);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser can't prepare photos.");
  // Quality first (0.8, then lower), then the picture itself, until it fits.
  for (const scale of [1, 0.75, 0.5]) {
    canvas.width = Math.max(1, Math.round(base.w * scale));
    canvas.height = Math.max(1, Math.round(base.h * scale));
    ctx.fillStyle = "#fff"; // a transparent PNG would turn black as a JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    for (const q of [IMAGE_JPEG_QUALITY, 0.65, 0.5]) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", q));
      if (blob && blob.size <= IMAGE_SEND_MAX_BYTES) {
        bmp.close?.();
        return { blob, previewUrl: URL.createObjectURL(blob), bytes: blob.size, name: `${(file.name || "photo").replace(/\.[^.]+$/, "")}.jpg`, width: canvas.width, height: canvas.height };
      }
    }
  }
  bmp.close?.();
  throw new Error("That photo can't be made small enough to send.");
}

/** Upload a prepared picture to the curator's own folder and return its Storage path. */
export async function uploadImage(uid: string, scope: ImageScope, blob: Blob, signal?: AbortSignal): Promise<string> {
  const { storage, sdk } = await storageSdk();
  const path = imagePath(uid, scope, newImageId());
  if (signal?.aborted) throw new Error("Cancelled");
  await sdk.uploadBytes(sdk.ref(storage, path), blob, { contentType: "image/jpeg", cacheControl: "private, no-store" });
  return path;
}

/** Delete one of the curator's own uploads (a removed attachment, a discarded unsent message). Never throws. */
export async function deleteImage(uid: string, path: string): Promise<void> {
  if (!parseImagePath(uid, path)) return;
  try {
    const { storage, sdk } = await storageSdk();
    await sdk.deleteObject(sdk.ref(storage, path));
  } catch {
    /* already gone, or offline: the server's sweep removes a leftover one-time upload */
  }
}

/** A short-lived picture the server fetched: where it is, and an object URL to show it. */
export interface FetchedPicture {
  url: string;
  bytes: number;
  /** The cache file, so it can be deleted when the chat closes. Null for a demo picture. */
  path: string | null;
}

export class MediaFetchError extends Error {}

/** Read a cache file the server wrote (the owner can read it by the storage rules) into an object URL. */
async function readCacheFile(path: string): Promise<{ url: string; bytes: number }> {
  const { storage, sdk } = await storageSdk();
  const blob = await sdk.getBlob(sdk.ref(storage, path));
  return { url: URL.createObjectURL(blob), bytes: blob.size };
}

/** Turn fetch_media's answer into a picture, or throw an error with words for the curator. */
export async function resolveFetched(r: FetchMediaResult | null | undefined): Promise<FetchedPicture> {
  if (!r || r.path === null) throw new MediaFetchError(FETCH_FAILURE_TEXT[r?.reason ?? "expired"]);
  const f = await readCacheFile(r.path);
  return { ...f, path: r.path };
}

/** The curator tapped View: ask the server for this message's picture. The one place that asks. */
export async function fetchPicture(uid: string, target: { comicId: string } | { groupId: string }, messageId: string): Promise<FetchedPicture> {
  let r: FetchMediaResult;
  try {
    // 90 s: a cold WhatsApp page can be slow. A server that isn't running never answers, and that is said plainly.
    r = await runCommand<FetchMediaResult>(uid, "fetch_media", { ...target, messageId }, 90_000, { ephemeral: true });
  } catch (e) {
    const msg = (e as Error).message;
    if (/didn't respond|isn't running|offline/i.test(msg)) throw new MediaFetchError(FETCH_FAILURE_TEXT.offline);
    throw new MediaFetchError(msg);
  }
  return resolveFetched(r);
}

/** Delete the cache file of a picture (when its chat is closed) and let go of its object URL. */
export async function forgetPicture(uid: string, p: FetchedPicture): Promise<void> {
  URL.revokeObjectURL(p.url);
  if (!p.path || !p.path.startsWith(`users/${uid}/media-cache/`)) return;
  try {
    const { storage, sdk } = await storageSdk();
    await sdk.deleteObject(sdk.ref(storage, p.path));
  } catch {
    /* the server deletes it within the hour anyway */
  }
}

/** The curator's own saved picture (a template's or a scheduled post's) as an object URL, for a thumbnail. Revoke it when done. */
export async function readOwnPicture(path: string): Promise<string> {
  const { storage, sdk } = await storageSdk();
  return URL.createObjectURL(await sdk.getBlob(sdk.ref(storage, path)));
}
