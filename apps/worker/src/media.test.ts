import { describe, expect, it } from "vitest";
import { IMAGE_SEND_MAX_BYTES, MEDIA_CACHE_TTL_MS, MEDIA_FETCH_MAX_BYTES, OUTBOX_TTL_MS, ATTACHMENT_ORPHAN_MS } from "@spot/shared";
import { cachePicture, dropSentImage, knownTooBig, loadOutImage, sweepMedia, type MediaStore } from "./media.ts";

const uid = "uidA1";
const id = "abcDEF1234567890_-xy";
const outbox = `users/${uid}/outbox/${id}.jpg`;
const kept = `users/${uid}/attachments/${id}.jpg`;

/** An in-memory bucket: path -> bytes, type and creation time. */
function fakeStore(files: Record<string, { data?: Buffer; size?: number; type?: string; at?: number }> = {}) {
  const f = new Map(Object.entries(files));
  const store: MediaStore & { files: typeof f } = {
    files: f,
    meta: async (p) => {
      const x = f.get(p);
      return x ? { size: x.size ?? x.data?.length ?? 0, contentType: x.type ?? "image/jpeg" } : null;
    },
    read: async (p) => f.get(p)?.data ?? Buffer.alloc(0),
    write: async (p, data, type) => void f.set(p, { data, type, at: Date.now() }),
    remove: async (p) => void f.delete(p),
    list: async (prefix) => [...f.entries()].filter(([n]) => n.startsWith(prefix)).map(([name, x]) => ({ name, createdAt: x.at ?? 0 })),
  };
  return store;
}

describe("loadOutImage", () => {
  it("reads one of the account's own uploads as base64 with its type and a clean name", async () => {
    const store = fakeStore({ [outbox]: { data: Buffer.from("JPEGDATA") } });
    expect(await loadOutImage(uid, { path: outbox, name: "my pic?.jpg" }, store)).toEqual({ mime: "image/jpeg", data: Buffer.from("JPEGDATA").toString("base64"), name: "my pic.jpg" });
  });
  it("never reads another account's file, even when the path is in this account's own settings", async () => {
    const theirs = `users/other/outbox/${id}.jpg`;
    const store = fakeStore({ [theirs]: { data: Buffer.from("x") } });
    await expect(loadOutImage(uid, { path: theirs }, store)).rejects.toThrow(/isn't available/);
    await expect(loadOutImage(uid, { path: `vault/${uid}/login-1-ab.bin` }, store)).rejects.toThrow(/isn't available/);
  });
  it("says so when the file is gone, too big, or not a picture", async () => {
    await expect(loadOutImage(uid, { path: outbox }, fakeStore())).rejects.toThrow(/no longer there/);
    await expect(loadOutImage(uid, { path: outbox }, fakeStore({ [outbox]: { size: IMAGE_SEND_MAX_BYTES + 1 } }))).rejects.toThrow(/too big/);
    await expect(loadOutImage(uid, { path: outbox }, fakeStore({ [outbox]: { data: Buffer.from("x"), type: "application/pdf" } }))).rejects.toThrow(/Only pictures/);
  });
});

describe("dropSentImage", () => {
  it("deletes a one-time upload and never a kept picture or someone else's file", async () => {
    const store = fakeStore({ [outbox]: { data: Buffer.from("a") }, [kept]: { data: Buffer.from("b") }, [`users/other/outbox/${id}.jpg`]: { data: Buffer.from("c") } });
    await dropSentImage(uid, outbox, store);
    await dropSentImage(uid, kept, store);
    await dropSentImage(uid, `users/other/outbox/${id}.jpg`, store);
    expect([...store.files.keys()].sort()).toEqual([`users/other/outbox/${id}.jpg`, kept].sort());
  });
});

describe("fetch_media: cachePicture", () => {
  const b64 = (n: number) => Buffer.alloc(n, 1).toString("base64");
  it("stores a picture under the account's media-cache and says where, with when it expires", async () => {
    const store = fakeStore();
    const r = await cachePicture(uid, "false_1@c.us_AB", { mimetype: "image/jpeg", data: b64(3000) }, store, 1_000);
    expect(r).toEqual({ path: `users/${uid}/media-cache/false_1_c.us_AB`, mime: "image/jpeg", bytes: 3000, expiresAt: 1_000 + MEDIA_CACHE_TTL_MS });
    expect(store.files.get(`users/${uid}/media-cache/false_1_c.us_AB`)?.type).toBe("image/jpeg");
  });
  it("stores nothing for an expired, oversized or non-picture message", async () => {
    const store = fakeStore();
    expect(await cachePicture(uid, "m1", undefined, store)).toEqual({ path: null, reason: "expired" });
    expect(await cachePicture(uid, "m1", { mimetype: "image/jpeg", data: "" }, store)).toEqual({ path: null, reason: "expired" });
    expect(await cachePicture(uid, "m1", { mimetype: "video/mp4", data: b64(100) }, store)).toEqual({ path: null, reason: "not_image" });
    expect(await cachePicture(uid, "m1", { mimetype: "image/jpeg", data: b64(MEDIA_FETCH_MAX_BYTES + 3000) }, store)).toEqual({ path: null, reason: "too_big" });
    expect(store.files.size).toBe(0);
  });
  it("knows a picture is too big before downloading it", () => {
    expect(knownTooBig(MEDIA_FETCH_MAX_BYTES + 1)).toBe(true);
    expect(knownTooBig(MEDIA_FETCH_MAX_BYTES)).toBe(false);
    expect(knownTooBig(undefined)).toBe(false);
  });
});

describe("sweepMedia", () => {
  const now = 100 * OUTBOX_TTL_MS;
  const files = () => ({
    [`users/${uid}/media-cache/old`]: { data: Buffer.from("x"), at: now - MEDIA_CACHE_TTL_MS },
    [`users/${uid}/media-cache/new`]: { data: Buffer.from("x"), at: now - 60_000 },
    [`users/${uid}/outbox/${id}.jpg`]: { data: Buffer.from("x"), at: now - OUTBOX_TTL_MS },
    [`users/${uid}/outbox/fresh12345678.jpg`]: { data: Buffer.from("x"), at: now - 60_000 },
    [kept]: { data: Buffer.from("x"), at: now - ATTACHMENT_ORPHAN_MS - 1 },
    [`users/${uid}/attachments/inuse12345678.jpg`]: { data: Buffer.from("x"), at: now - ATTACHMENT_ORPHAN_MS - 1 },
    [`users/${uid}/attachments/young12345678.jpg`]: { data: Buffer.from("x"), at: now - 60_000 },
  });
  it("deletes cache files after an hour and unsent uploads after their backstop, nothing younger", async () => {
    const store = fakeStore(files());
    expect(await sweepMedia(uid, store, now)).toBe(2);
    expect(store.files.has(`users/${uid}/media-cache/old`)).toBe(false);
    expect(store.files.has(outbox)).toBe(false);
    expect(store.files.has(`users/${uid}/media-cache/new`)).toBe(true);
    expect(store.files.has(kept)).toBe(true); // kept pictures are judged only when the references are known
  });
  it("also deletes a kept picture nothing uses any more, but never one still in use or a young one", async () => {
    const store = fakeStore(files());
    const used = new Set([`users/${uid}/attachments/inuse12345678.jpg`]);
    expect(await sweepMedia(uid, store, now, used)).toBe(3);
    expect(store.files.has(kept)).toBe(false);
    expect(store.files.has(`users/${uid}/attachments/inuse12345678.jpg`)).toBe(true);
    expect(store.files.has(`users/${uid}/attachments/young12345678.jpg`)).toBe(true);
  });
  it("only looks inside this account's folders", async () => {
    const store = fakeStore({ [`users/other/media-cache/old`]: { data: Buffer.from("x"), at: 0 } });
    expect(await sweepMedia(uid, store, now)).toBe(0);
    expect(store.files.size).toBe(1);
  });
});
