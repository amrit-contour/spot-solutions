import { describe, expect, it } from "vitest";
import {
  SYNC_FRESH_MS,
  agoLabel,
  cacheEvictions,
  chatSyncView,
  clearMark,
  effectiveAwaiting,
  fitWithin,
  groupReactions,
  pruneMarks,
  reactionEdge,
  reactionReservePx,
  savedFromLabel,
  setMark,
  toggleMyReaction,
  toggleNeedsReply,
  trimThreadForCache,
} from "./chatState.ts";
import type { GetThreadResult, ThreadMessage } from "./threads.ts";

describe("sync line", () => {
  const now = 1_000_000_000;
  it("says syncing while reading, and only warns when nothing fresh was read", () => {
    expect(chatSyncView({ lastOkAt: 0, loading: true, now })).toMatchObject({ syncing: true, ok: false, label: "Syncing…" });
    expect(chatSyncView({ lastOkAt: now - 30_000, loading: true, now })).toMatchObject({ syncing: true, ok: true });
  });
  it("is synced for a fresh read, stale after a while", () => {
    expect(chatSyncView({ lastOkAt: now - 120_000, loading: false, now })).toMatchObject({ ok: true, label: "Synced 2 min ago" });
    expect(chatSyncView({ lastOkAt: now - SYNC_FRESH_MS - 1, loading: false, now }).ok).toBe(false);
  });
  it("a failed sync is not ok, with or without an earlier read", () => {
    expect(chatSyncView({ lastOkAt: now - 60_000, loading: false, error: "x", now })).toMatchObject({ ok: false });
    expect(chatSyncView({ lastOkAt: 0, loading: false, error: "x", now }, now - 3_600_000).label).toBe("Offline · saved 1 h ago");
  });
  it("shows a saved copy until the first read", () => {
    expect(chatSyncView({ lastOkAt: 0, loading: false, now }, now - 600_000)).toMatchObject({ ok: false, label: "Saved 10 min ago" });
  });
  it("words times", () => {
    expect(agoLabel(now - 10_000, now)).toBe("just now");
    expect(agoLabel(now - 86_400_000, now)).toBe("yesterday");
    expect(agoLabel(now - 3 * 86_400_000, now)).toBe("3 days ago");
  });
  it("labels the saved time in the curator's timezone", () => {
    const at = Date.UTC(2026, 9, 27, 4, 44); // 10:14 in Kolkata
    expect(savedFromLabel(at, at + 60_000, "Asia/Kolkata")).toBe("10:14 am");
    expect(savedFromLabel(at, at + 3 * 86_400_000, "Asia/Kolkata")).toMatch(/Tue 27 Oct, 10:14 am/);
  });
});

describe("done / needs reply marks", () => {
  const t = { at: 100, awaitingYou: true };
  it("done clears needs-reply until a newer message arrives", () => {
    const marks = setMark({}, "a", "done", t);
    expect(effectiveAwaiting(t, marks.a)).toBe(false);
    expect(effectiveAwaiting({ at: 101, awaitingYou: true }, marks.a)).toBe(true);
    expect(effectiveAwaiting({ at: 101, awaitingYou: false }, marks.a)).toBe(false);
  });
  it("needs reply holds until something newer lets WhatsApp's own rule decide", () => {
    const marks = setMark({}, "a", "needs", { at: 100 });
    expect(effectiveAwaiting({ at: 100, awaitingYou: false }, marks.a)).toBe(true);
    expect(effectiveAwaiting({ at: 120, awaitingYou: false }, marks.a)).toBe(false); // you replied
  });
  it("toggle flips what you see", () => {
    const a = toggleNeedsReply({}, "a", t);
    expect(a.a.kind).toBe("done");
    const b = toggleNeedsReply(a, "a", t);
    expect(b.a.kind).toBe("needs");
    expect(effectiveAwaiting({ at: 100, awaitingYou: false }, toggleNeedsReply({}, "x", { at: 100, awaitingYou: false }).x)).toBe(true);
  });
  it("prunes marks a newer message made moot and chats that are gone", () => {
    const marks = { a: { kind: "done" as const, at: 100 }, b: { kind: "done" as const, at: 100 }, c: { kind: "needs" as const, at: 5 } };
    expect(Object.keys(pruneMarks(marks, [{ id: "a", at: 100 }, { id: "b", at: 200 }]))).toEqual(["a"]);
    expect(clearMark(marks, "a").a).toBeUndefined();
  });
});

describe("reactions", () => {
  it("sits on the inner edge: right for incoming, left for outgoing", () => {
    expect(reactionEdge(false)).toBe("right");
    expect(reactionEdge(true)).toBe("left");
    expect(reactionReservePx()).toBe(18);
  });
  it("groups counts per emoji, biggest first", () => {
    expect(groupReactions([{ emoji: "👍", count: 1, byMe: false }, { emoji: "❤️", count: 2, byMe: false }, { emoji: "👍", count: 1, byMe: true }])).toEqual([
      { emoji: "👍", count: 2, byMe: true },
      { emoji: "❤️", count: 2, byMe: false },
    ]);
  });
  it("applies yours at once: add, switch, take back", () => {
    const a = toggleMyReaction([{ emoji: "👍", count: 2, byMe: false }], "👍");
    expect(a).toEqual({ chips: [{ emoji: "👍", count: 3, byMe: true }], sent: "👍" });
    const b = toggleMyReaction(a.chips, "😂");
    expect(b.chips).toContainEqual({ emoji: "😂", count: 1, byMe: true });
    expect(b.chips).toContainEqual({ emoji: "👍", count: 2, byMe: false });
    const c = toggleMyReaction(b.chips, "😂");
    expect(c.sent).toBe("");
    expect(c.chips.some((x) => x.byMe)).toBe(false);
  });
});

describe("cache and photos", () => {
  const m = (n: number): ThreadMessage => ({ id: `m${n}`, at: n, fromMe: false, kind: "text", text: "x" });
  it("keeps only the newest messages and says there are more", () => {
    const r: GetThreadResult = { comicId: "a", chatId: "a", messages: Array.from({ length: 60 }, (_, i) => m(i)), hasMore: false, at: 1 };
    const t = trimThreadForCache(r, 40);
    expect(t.messages).toHaveLength(40);
    expect(t.messages[0].id).toBe("m20");
    expect(t.hasMore).toBe(true);
  });
  it("forgets the oldest saved threads past the cap", () => {
    expect(cacheEvictions([{ key: "a", savedAt: 1 }, { key: "b", savedAt: 3 }, { key: "c", savedAt: 2 }], 2)).toEqual(["a"]);
  });
  it("fits photos inside 1600px and never enlarges", () => {
    expect(fitWithin(4000, 3000)).toEqual({ w: 1600, h: 1200 });
    expect(fitWithin(800, 600)).toEqual({ w: 800, h: 600 });
  });
});
