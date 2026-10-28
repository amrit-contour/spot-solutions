import { describe, expect, it } from "vitest";
import { cleanupAlreadyStarted, cleanupStep, cleanupTriggerPost, migrateCleanupTrigger, type GroupCleanup } from "./groupCleanup.ts";
import type { GroupPost } from "./groupPosts.ts";

const post = (p: Partial<GroupPost>): GroupPost => ({ id: "p1", template: "groupThanks", daysBefore: -1, time: "10:00", enabled: true, ...p });
const cleanup = (c: Partial<GroupCleanup> = {}): GroupCleanup => ({ enabled: true, time: "11:00", ...c });
const lineup = (p = {}) => ({ date: "2026-10-26", status: "confirmed" as const, outcome: "happened" as const, ...p });
const now = { date: "2026-10-27", time: "12:00" };

describe("cleanupTriggerPost: one source of truth", () => {
  it("the show's setting picks the post", () => {
    const show = { cleanup: cleanup({ afterPostId: "p2" }), groupPosts: [post({}), post({ id: "p2" })] };
    expect(cleanupTriggerPost(show)?.id).toBe("p2");
  });
  it("a missing, paused post or cleanup off means no post trigger", () => {
    expect(cleanupTriggerPost({ cleanup: cleanup({ afterPostId: "zz" }), groupPosts: [post({})] })).toBeNull();
    expect(cleanupTriggerPost({ cleanup: cleanup({ afterPostId: "p1" }), groupPosts: [post({ enabled: false })] })).toBeNull();
    expect(cleanupTriggerPost({ cleanup: cleanup({ enabled: false, afterPostId: "p1" }), groupPosts: [post({})] })).toBeNull();
  });
  it("the old per-post switch still works until the show chooses; an explicit time choice beats it", () => {
    const legacy = post({ after: { removeComics: true } });
    expect(cleanupTriggerPost({ cleanup: cleanup(), groupPosts: [legacy] })?.id).toBe("p1");
    expect(cleanupTriggerPost({ cleanup: cleanup({ afterPostId: null }), groupPosts: [legacy] })).toBeNull();
    expect(cleanupTriggerPost({ cleanup: cleanup({ afterPostId: "p9" }), groupPosts: [legacy, post({ id: "p9" })] })?.id).toBe("p9");
  });
});

describe("migrateCleanupTrigger", () => {
  it("moves the switch into the show's setting and strips it from the post", () => {
    const m = migrateCleanupTrigger({ cleanup: cleanup({ mode: "auto" }), groupPosts: [post({ after: { removeComics: true } }), post({ id: "p2" })] })!;
    expect(m.cleanup).toMatchObject({ enabled: true, onHappened: "clear", onDidnt: "repeat", afterPostId: "p1" });
    expect(m.cleanup).not.toHaveProperty("mode");
    expect(m.groupPosts[0].after).toBeNull();
  });
  it("cleanup that was off turns on asking every time (what the old switch did)", () => {
    const m = migrateCleanupTrigger({ groupPosts: [post({ after: { removeComics: true } })] })!;
    expect(m.cleanup).toMatchObject({ enabled: true, onHappened: "ask", onDidnt: "ask", onCalledOff: "ask", afterPostId: "p1" });
  });
  it("nothing to move: null; and a show that already chose keeps its choice", () => {
    expect(migrateCleanupTrigger({ groupPosts: [post({})] })).toBeNull();
    const m = migrateCleanupTrigger({ cleanup: cleanup({ afterPostId: null }), groupPosts: [post({ after: { removeComics: true } })] })!;
    expect(m.cleanup.afterPostId).toBeNull();
    expect(m.groupPosts[0].after).toBeNull();
  });
});

describe("the cleanup runs at most once per lineup", () => {
  const show = (c: Partial<GroupCleanup> = {}) => ({ groupId: "g@g.us", active: true, cleanup: cleanup(c), groupPosts: [post({})] });
  it("with a post trigger the timed pass leaves a happened show to the post", () => {
    expect(cleanupStep(show({ afterPostId: "p1" }), lineup(), now, true)).toBeNull();
    expect(cleanupStep(show({ afterPostId: null }), lineup(), now, true)).toBe("run");
  });
  it("a show that didn't happen still decides at the set time (default rule: by repeat next week)", () => {
    expect(cleanupStep(show({ afterPostId: "p1" }), lineup({ status: "canned", outcome: "canned" }), now, true)).toBe("askRepeat");
  });
  it("once any trigger has started one, neither trigger starts another", () => {
    for (const status of ["asked", "partial", "done", "kept", "skipped"] as const) {
      const l = lineup({ cleanup: { status, at: 1 } });
      expect(cleanupAlreadyStarted(l)).toBe(true);
      expect(cleanupStep(show({ afterPostId: null }), l, now, true)).not.toBe("run");
      expect(cleanupStep(show({ afterPostId: null }), l, now, true)).not.toBe("ask");
    }
    expect(cleanupAlreadyStarted(lineup())).toBe(false);
    expect(cleanupAlreadyStarted(lineup({ backfilled: true }))).toBe(true);
  });
});
