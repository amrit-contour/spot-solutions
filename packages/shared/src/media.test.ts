import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_ORPHAN_MS,
  IMAGE_CAPTION_MAX,
  IMAGE_SEND_MAX_BYTES,
  MEDIA_CACHE_TTL_MS,
  MEDIA_FETCH_MAX_BYTES,
  checkFetchedMedia,
  cleanImage,
  expiredFiles,
  formatBytes,
  imagePath,
  imagePathsInUse,
  mediaCachePath,
  normalizeMessage,
  parseFetchMedia,
  parseImagePath,
  parseSendImage,
  safeMediaId,
  sendImageProblem,
  storeMessage,
  toThreadMessage,
} from "./index.ts";

const uid = "uidA1";
const id = "abcDEF1234567890_-xy";

describe("picture paths", () => {
  it("accepts only this user's own outbox and attachments files", () => {
    expect(parseImagePath(uid, `users/${uid}/outbox/${id}.jpg`)).toEqual({ scope: "outbox", id });
    expect(parseImagePath(uid, imagePath(uid, "attachments", id))).toEqual({ scope: "attachments", id });
  });
  it("refuses another user's file, other folders, traversal and odd names", () => {
    expect(parseImagePath(uid, `users/other/outbox/${id}.jpg`)).toBeNull();
    expect(parseImagePath(uid, `users/${uid}/media-cache/${id}.jpg`)).toBeNull();
    expect(parseImagePath(uid, `users/${uid}/outbox/../../other/outbox/${id}.jpg`)).toBeNull();
    expect(parseImagePath(uid, `users/${uid}/outbox/sub/${id}.jpg`)).toBeNull();
    expect(parseImagePath(uid, `users/${uid}/outbox/${id}.png`)).toBeNull();
    expect(parseImagePath(uid, `users/${uid}/outbox/short.jpg`)).toBeNull();
    expect(parseImagePath(uid, `vault/${uid}/login-1-ab.bin`)).toBeNull();
    expect(parseImagePath(uid, 42)).toBeNull();
    expect(parseImagePath("", `users//outbox/${id}.jpg`)).toBeNull();
    expect(parseImagePath("a/b", `users/a/b/outbox/${id}.jpg`)).toBeNull();
  });
  it("names a fetched picture's cache file from the message id, safely", () => {
    expect(mediaCachePath(uid, "false_919@c.us_3EB0AB")).toBe(`users/${uid}/media-cache/false_919_c.us_3EB0AB`);
    expect(safeMediaId("../../x")).toBe(".._.._x");
    expect(mediaCachePath(uid, "../../x")).not.toContain("/../");
    expect(() => safeMediaId("")).toThrow(/Which message/);
    expect(() => safeMediaId("..")).toThrow(/Which message/);
    expect(safeMediaId("a".repeat(500))).toHaveLength(120);
  });
});

describe("send_image validation", () => {
  const ok = { path: `users/${uid}/outbox/${id}.jpg`, caption: "  Doors at 7  ", name: "My Pic?.jpg" };
  it("takes a path of the user's own, trims the caption and cleans the name", () => {
    expect(parseSendImage(uid, ok)).toEqual({ path: ok.path, scope: "outbox", caption: "Doors at 7", name: "My Pic.jpg" });
    expect(parseSendImage(uid, { path: ok.path }).name).toBe("photo.jpg");
  });
  it("caps the caption", () => {
    expect(parseSendImage(uid, { ...ok, caption: "x".repeat(5000) }).caption).toHaveLength(IMAGE_CAPTION_MAX);
  });
  it("refuses a missing path and someone else's", () => {
    expect(() => parseSendImage(uid, {})).toThrow(/isn't available/);
    expect(() => parseSendImage(uid, { path: `users/other/outbox/${id}.jpg` })).toThrow(/isn't available/);
  });
});

describe("fetch_media validation", () => {
  it("needs a message id", () => {
    expect(parseFetchMedia({ messageId: " true_1@c.us_AB " })).toEqual({ messageId: "true_1@c.us_AB" });
    expect(() => parseFetchMedia({})).toThrow(/Which message/);
    expect(() => parseFetchMedia({ messageId: "x".repeat(400) })).toThrow(/Which message/);
  });
});

describe("size and type limits", () => {
  it("sends a small picture and refuses the rest, in words for the curator", () => {
    expect(sendImageProblem({ size: 300_000, contentType: "image/jpeg" })).toBeNull();
    expect(sendImageProblem({ size: String(IMAGE_SEND_MAX_BYTES), contentType: "IMAGE/PNG" })).toBeNull();
    expect(sendImageProblem({ size: IMAGE_SEND_MAX_BYTES + 1, contentType: "image/jpeg" })).toMatch(/too big/);
    expect(sendImageProblem({ size: 0, contentType: "image/jpeg" })).toMatch(/empty/);
    expect(sendImageProblem({ size: 100, contentType: "video/mp4" })).toMatch(/Only pictures/);
    expect(sendImageProblem({ size: 100, contentType: "image/svg+xml" })).toMatch(/Only pictures/);
    expect(sendImageProblem({ size: 100, contentType: null })).toMatch(/Only pictures/);
  });
  it("shows a fetched picture only when it exists, is an image and fits", () => {
    expect(checkFetchedMedia({ mime: "image/jpeg", bytes: 1000 })).toBeNull();
    expect(checkFetchedMedia({ mime: "image/webp", bytes: MEDIA_FETCH_MAX_BYTES })).toBeNull();
    expect(checkFetchedMedia({ mime: "image/jpeg", bytes: MEDIA_FETCH_MAX_BYTES + 1 })).toBe("too_big");
    expect(checkFetchedMedia({ mime: "video/mp4", bytes: 1000 })).toBe("not_image");
    expect(checkFetchedMedia({ mime: "image/jpeg", bytes: 0 })).toBe("expired");
    expect(checkFetchedMedia(null)).toBe("expired");
    expect(checkFetchedMedia(undefined)).toBe("expired");
  });
  it("formats sizes for the placeholder, and says nothing when unknown", () => {
    expect(formatBytes(undefined)).toBe("");
    expect(formatBytes(0)).toBe("");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(214_000)).toBe("214 KB");
    expect(formatBytes(1_250_000)).toBe("1.3 MB");
    expect(formatBytes(15_400_000)).toBe("15 MB");
  });
});

describe("lifetimes", () => {
  it("lists the files past their life and keeps the rest", () => {
    const now = 10 * MEDIA_CACHE_TTL_MS;
    const files = [
      { name: "old", createdAt: now - MEDIA_CACHE_TTL_MS },
      { name: "fresh", createdAt: now - MEDIA_CACHE_TTL_MS + 1 },
    ];
    expect(expiredFiles(files, now, MEDIA_CACHE_TTL_MS)).toEqual(["old"]);
    expect(MEDIA_CACHE_TTL_MS).toBe(3_600_000);
    expect(ATTACHMENT_ORPHAN_MS).toBeGreaterThan(MEDIA_CACHE_TTL_MS);
  });
});

describe("a picture on a message", () => {
  const image = { path: `users/${uid}/attachments/${id}.jpg`, name: "poster.jpg" };
  it("is kept by normalize and store, and an image-only message is a message", () => {
    expect(normalizeMessage({ kind: "text", body: "Hi", image })).toEqual({ kind: "text", body: "Hi", image });
    expect(normalizeMessage({ kind: "text", body: "", image })).toEqual({ kind: "text", body: "", image });
    expect(normalizeMessage({ kind: "text", body: "" })).toEqual({ kind: "text", body: "" });
    expect(storeMessage({ kind: "text", body: "Hi" })).toBe("Hi");
    expect(storeMessage({ kind: "text", body: "Hi", image })).toEqual({ kind: "text", body: "Hi", image });
  });
  it("drops a path outside the upload folders and a picture on a poll", () => {
    expect(normalizeMessage({ kind: "text", body: "Hi", image: { path: "vault/x/y.bin" } })).toEqual({ kind: "text", body: "Hi" });
    expect(normalizeMessage({ kind: "text", body: "Hi", image: { path: "../x.jpg" } }).image).toBeUndefined();
    expect(normalizeMessage({ kind: "poll", body: "", poll: { question: "Q", options: ["a", "b"], multi: false }, image }).image).toBeUndefined();
    expect(cleanImage({ path: image.path }, "someoneElse")).toBeUndefined();
    expect(cleanImage(image, uid)).toEqual(image);
  });
  it("counts a picture shared by two scheduled posts (a copied post) as in use until both let go", () => {
    const post = { message: { kind: "text", body: "", image } };
    expect(imagePathsInUse(uid, {}, [{ groupPosts: [post] }, { groupPosts: [post] }]).has(image.path)).toBe(true);
    expect(imagePathsInUse(uid, {}, [{ groupPosts: [post] }, { groupPosts: [{ message: "plain" }] }]).has(image.path)).toBe(true);
    expect(imagePathsInUse(uid, {}, [{ groupPosts: [{ message: "plain" }] }]).has(image.path)).toBe(false);
  });
  it("finds the kept pictures that templates and scheduled posts still use", () => {
    const other = `users/${uid}/attachments/zzzzzzzzzzzz.jpg`;
    const used = imagePathsInUse(
      uid,
      { messages: { offer: { kind: "text", body: "x", image }, ack: "plain text" } },
      [{ groupPosts: [{ message: { kind: "text", body: "", image: { path: other } } }, { message: null }], cleanup: { message: "" } }, { groupPosts: null }],
    );
    expect([...used].sort()).toEqual([image.path, other].sort());
    expect(imagePathsInUse("someoneElse", { messages: { offer: { kind: "text", body: "x", image } } }, []).size).toBe(0);
  });
});

describe("media messages in a thread", () => {
  it("carry the size when WhatsApp gives one", () => {
    const base = { id: "m1", timestamp: 1_700_000_000, fromMe: false, hasMedia: true };
    expect(toThreadMessage({ ...base, type: "image", body: "Poster", size: 214_000 })).toMatchObject({ kind: "media", media: "image", bytes: 214_000, text: "[photo] Poster" });
    expect(toThreadMessage({ ...base, type: "image", body: "" })).not.toHaveProperty("bytes");
    expect(toThreadMessage({ ...base, type: "sticker", body: "", size: 20_000 })).toMatchObject({ kind: "sticker", bytes: 20_000 });
  });
});

describe("rules files agree with the code", () => {
  const read = (f: string) => readFileSync(new URL(`../../../${f}`, import.meta.url), "utf8");
  it("firestore.rules lets the owner create and delete send_image and fetch_media commands", () => {
    const rules = read("firestore.rules");
    const lists = rules.match(/request\.resource\.data\.type in \[[^\]]*\]/g) ?? [];
    expect(lists.filter((l) => l.includes("'send_image'") && l.includes("'fetch_media'")).length).toBeGreaterThanOrEqual(1);
    const del = rules.split("\n").find((l) => l.includes("allow delete: if isOwner(uid) && resource.data.type in")) ?? "";
    expect(del).toContain("'send_image'");
    expect(del).toContain("'fetch_media'");
  });
  it("storage.rules: the owner writes outbox and attachments (small pictures only), only the server writes media-cache", () => {
    const rules = read("storage.rules");
    expect(rules).toContain("match /users/{uid}/outbox/{file}");
    expect(rules).toContain("match /users/{uid}/attachments/{file}");
    expect(rules).toContain(`request.resource.size <= ${IMAGE_SEND_MAX_BYTES / 1024 / 1024} * 1024 * 1024`);
    const cache = rules.slice(rules.indexOf("match /users/{uid}/media-cache/{file}"), rules.indexOf("match /{allPaths=**}"));
    expect(cache).toContain("allow read, delete: if owner(uid)");
    expect(cache).not.toMatch(/create|update|write/);
    expect(rules).toMatch(/match \/\{allPaths=\*\*\}\s*\{\s*allow read, write: if false;/);
    expect(rules).toContain("!= 'anonymous'");
  });
});
