import { describe, expect, it } from "vitest";
import type { Comic } from "@spot/shared";
import { PHOTO_NONE, PHOTO_REFRESH_MS } from "@spot/shared";
import { PicQueue, type PicDeps } from "./profilePicsQueue.ts";

const comic = (id: string, extra: Partial<Comic> = {}) => ({ id, name: id, phone: id, tier: "regular", ...extra }) as Comic;

function setup(comics: Comic[], opts: { urls?: Record<string, string | null>; blocked?: string[]; ready?: boolean; throws?: string[] } = {}) {
  let t = 1_000_000_000;
  const docs = new Map(comics.map((c) => [c.id, c]));
  const fetched: string[] = [];
  const deps: PicDeps = {
    now: () => t,
    ready: () => opts.ready ?? true,
    load: async (id) => docs.get(id),
    blocked: async (c) => (opts.blocked ?? []).includes(c.id),
    fetchUrl: async (c) => {
      fetched.push(c.id);
      if (opts.throws?.includes(c.id)) throw new Error("not ready");
      return opts.urls?.[c.id] ?? null;
    },
    save: async (id, patch) => void docs.set(id, { ...docs.get(id)!, ...patch }),
  };
  return { q: new PicQueue(deps, 2000), docs, fetched, advance: (ms: number) => void (t += ms) };
}

describe("PicQueue", () => {
  it("fetches at most one per interval", async () => {
    const s = setup([comic("a"), comic("b")], { urls: { a: "https://x/a", b: "https://x/b" } });
    s.q.enqueue(["a", "b"]);
    expect(await s.q.step()).toBe("saved");
    expect(await s.q.step()).toBe("wait");
    expect(s.fetched).toEqual(["a"]);
    s.advance(2000);
    expect(await s.q.step()).toBe("saved");
    expect(s.docs.get("b")?.photoUrl).toBe("https://x/b");
  });
  it("remembers hidden photos as none with a timestamp", async () => {
    const s = setup([comic("a")]);
    s.q.enqueue(["a"]);
    await s.q.step();
    expect(s.docs.get("a")?.photoUrl).toBe(PHOTO_NONE);
    expect(s.docs.get("a")?.photoAt).toBeGreaterThan(0);
    s.q.enqueue(["a"]);
    expect(await s.q.step()).toBe("skipped"); // fresh: no second ask
    expect(s.fetched).toHaveLength(1);
  });
  it("refreshes after 7 days, and a forced one after the floor", async () => {
    const s = setup([comic("a", { photoUrl: "https://x/old", photoAt: 1_000_000_000 - PHOTO_REFRESH_MS - 1 })], { urls: { a: "https://x/new" } });
    s.q.enqueue(["a"]);
    await s.q.step();
    expect(s.docs.get("a")?.photoUrl).toBe("https://x/new");
    s.advance(60_000);
    s.q.enqueue(["a"], true);
    expect(await s.q.step()).toBe("skipped"); // forced too soon after the last ask
    s.advance(5 * 60_000);
    s.q.enqueue(["a"], true);
    expect(await s.q.step()).toBe("saved");
    expect(s.fetched).toHaveLength(2);
  });
  it("never asks about Never read people", async () => {
    const s = setup([comic("a"), comic("b")], { blocked: ["a"], urls: { b: "https://x/b" } });
    s.q.enqueue(["a", "b"]);
    expect(await s.q.step()).toBe("saved");
    expect(s.fetched).toEqual(["b"]);
    expect(s.docs.get("a")?.photoAt).toBeUndefined();
  });
  it("waits while WhatsApp is offline and keeps the queue", async () => {
    const s = setup([comic("a")], { ready: false });
    s.q.enqueue(["a"]);
    expect(await s.q.step()).toBe("offline");
    expect(s.q.size).toBe(1);
  });
  it("does not save when WhatsApp throws", async () => {
    const s = setup([comic("a")], { throws: ["a"] });
    s.q.enqueue(["a"]);
    expect(await s.q.step()).toBe("failed");
    expect(s.docs.get("a")?.photoAt).toBeUndefined();
  });
  it("dedupes and puts forced ids first; skips missing comics", async () => {
    const s = setup([comic("a"), comic("b")]);
    expect(s.q.enqueue(["a", "a", "b", "ghost"])).toBe(3);
    s.q.enqueue(["b"], true);
    expect(s.q.size).toBe(3);
  });

  it("handles WhatsApp ids with no saved doc (groups, curators) and keeps them apart from comics of the same id", async () => {
    const saved: Record<string, unknown> = {};
    let t = 1_000_000_000;
    const q = new PicQueue(
      {
        now: () => t,
        ready: () => true,
        load: async (id, kind) => (kind === "wa" ? { id, chatId: id } : undefined),
        blocked: async () => false,
        fetchUrl: async (c) => `https://x/${c.id}`,
        save: async (id, patch, kind) => void (saved[`${kind}:${id}`] = patch),
      },
      2000,
    );
    q.enqueue(["120363@g.us"], false, "wa");
    q.enqueue(["120363@g.us"], false, "comic"); // same id, other kind: its own entry (no doc, so it is skipped)
    expect(q.size).toBe(2);
    expect(await q.step()).toBe("saved");
    expect(saved["wa:120363@g.us"]).toMatchObject({ photoUrl: "https://x/120363@g.us" });
    t += 2000;
    expect(await q.step()).toBe("skipped");
  });
  it("adds jitter to the wait between lookups", async () => {
    let t = 1_000_000_000;
    const deps: PicDeps = {
      now: () => t,
      ready: () => true,
      load: async (id) => comic(id),
      blocked: async () => false,
      fetchUrl: async () => "https://x/y",
      save: async () => undefined,
    };
    const q = new PicQueue(deps, 2000, () => 1); // the longest jitter: interval + half
    q.enqueue(["a", "b"]);
    await q.step();
    t += 2500;
    expect(await q.step()).toBe("wait");
    t += 500;
    expect(await q.step()).toBe("saved");
  });
});
