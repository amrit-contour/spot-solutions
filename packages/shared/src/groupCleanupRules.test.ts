import { describe, expect, it } from "vitest";
import { cleanupDecision, cleanupOutcome, cleanupRules, cleanupStep, cleanupSummary, offRuleFor, withCleanupRules, type GroupCleanup } from "./groupCleanup.ts";
import type { GroupPost } from "./groupPosts.ts";

// Show on Mon 26 Oct; the clean-up evaluates on Tue 27 Oct from 11:00.
const cleanup = (c: Partial<GroupCleanup> = {}): GroupCleanup => ({ enabled: true, time: "11:00", ...c });
const show = (c: Partial<GroupCleanup> = {}) => ({ groupId: "g@g.us", active: true, cleanup: cleanup(c) });
const base = { date: "2026-10-26", cleanup: null };
const happened = { ...base, status: "confirmed" as const, outcome: "happened" as const };
const didnt = { ...base, status: "canned" as const, outcome: "canned" as const };
const calledOff = { ...base, status: "cancelled" as const, outcome: null };
const tue = { date: "2026-10-27", time: "12:00" };

describe("cleanupRules: migration from the old auto/ask mode", () => {
  it("auto: clear when it happened, decide by repeat when it didn't", () => {
    expect(cleanupRules({ mode: "auto" })).toEqual({ happened: "clear", didnt: "repeat", calledOff: "repeat" });
  });
  it("ask: ask in every case", () => {
    expect(cleanupRules({ mode: "ask" })).toEqual({ happened: "ask", didnt: "ask", calledOff: "ask" });
  });
  it("nothing set: the defaults", () => {
    expect(cleanupRules(undefined)).toEqual({ happened: "clear", didnt: "repeat", calledOff: "repeat" });
  });
  it("a rule that is set wins over the old mode", () => {
    expect(cleanupRules({ mode: "ask", onHappened: "keep", onDidnt: "clear" })).toEqual({ happened: "keep", didnt: "clear", calledOff: "ask" });
  });
  it("saving writes the three rules out and drops mode", () => {
    const w = withCleanupRules(cleanup({ mode: "ask" }), { onDidnt: "keep" });
    expect(w).toMatchObject({ onHappened: "ask", onDidnt: "keep", onCalledOff: "ask" });
    expect(w).not.toHaveProperty("mode");
  });
});

describe("cleanupOutcome", () => {
  it("tells happened, didn't happen and called off apart; null while the mic check is unanswered", () => {
    expect(cleanupOutcome(happened, true)).toBe("happened");
    expect(cleanupOutcome(didnt, true)).toBe("didnt");
    expect(cleanupOutcome({ status: "confirmed", outcome: "canned" }, true)).toBe("didnt");
    expect(cleanupOutcome(calledOff, true)).toBe("calledOff");
    expect(cleanupOutcome({ status: "confirmed", outcome: null }, true)).toBeNull();
    expect(cleanupOutcome({ status: "confirmed", outcome: null }, false)).toBe("happened");
  });
});

describe("each outcome x rule", () => {
  const rows: [string, typeof happened, Partial<GroupCleanup>, string][] = [
    ["happened + clear", happened, { onHappened: "clear" }, "run"],
    ["happened + ask", happened, { onHappened: "ask" }, "ask"],
    ["happened + keep", happened, { onHappened: "keep" }, "keep"],
    ["didn't happen + ask", didnt, { onDidnt: "ask" }, "ask"],
    ["didn't happen + keep", didnt, { onDidnt: "keep" }, "keep"],
    ["didn't happen + clear anyway", didnt, { onDidnt: "clear" }, "run"],
    ["didn't happen + repeat (undecided)", didnt, { onDidnt: "repeat" }, "askRepeat"],
    ["called off + ask", calledOff as never, { onCalledOff: "ask" }, "ask"],
    ["called off + keep", calledOff as never, { onCalledOff: "keep" }, "keep"],
    ["called off + clear anyway", calledOff as never, { onCalledOff: "clear" }, "run"],
    ["called off + repeat (undecided)", calledOff as never, { onCalledOff: "repeat" }, "askRepeat"],
  ];
  it.each(rows)("%s", (_n, lineup, rules, step) => {
    expect(cleanupStep(show(rules), lineup, tue, true)).toBe(step);
  });
  it("a rule for one outcome never affects another", () => {
    const s = show({ onHappened: "keep", onDidnt: "clear", onCalledOff: "ask" });
    expect(cleanupStep(s, happened, tue, true)).toBe("keep");
    expect(cleanupStep(s, didnt, tue, true)).toBe("run");
    expect(cleanupStep(s, calledOff, tue, true)).toBe("ask");
  });
});

describe("the repeat decision", () => {
  const rules = cleanupRules({ onDidnt: "repeat", onCalledOff: "repeat" });
  it.each(["didnt", "calledOff"] as const)("%s: repeat keeps everyone, don't repeat clears, not decided asks", (o) => {
    expect(cleanupDecision(rules, o, true)).toBe("keep");
    expect(cleanupDecision(rules, o, false)).toBe("run");
    expect(cleanupDecision(rules, o, null)).toBe("askRepeat");
    expect(cleanupDecision(rules, o, undefined)).toBe("askRepeat");
  });
  it("the repeat answer never changes a show that happened, or a rule that isn't 'repeat'", () => {
    expect(cleanupDecision(cleanupRules({ onHappened: "clear" }), "happened", true)).toBe("run");
    expect(cleanupDecision(cleanupRules({ onDidnt: "ask" }), "didnt", true)).toBe("ask");
    expect(cleanupDecision(cleanupRules({ onDidnt: "clear" }), "didnt", true)).toBe("run");
    expect(cleanupDecision(cleanupRules({ onDidnt: "keep" }), "didnt", false)).toBe("keep");
  });
  it("cleanupStep reads the lineup's repeatNext", () => {
    expect(cleanupStep(show(), { ...didnt, repeatNext: true }, tue, true)).toBe("keep");
    expect(cleanupStep(show(), { ...didnt, repeatNext: false }, tue, true)).toBe("run");
    expect(cleanupStep(show(), { ...didnt, repeatNext: null }, tue, true)).toBe("askRepeat");
  });
  it("a cleanup asked about repeat settles when the answer comes, and waits until then", () => {
    const asked = { ...didnt, cleanup: { status: "asked" as const, at: 1, reason: "repeat" as const } };
    expect(cleanupStep(show(), asked, tue, true)).toBeNull();
    expect(cleanupStep(show(), { ...asked, repeatNext: true }, tue, true)).toBe("keep");
    expect(cleanupStep(show(), { ...asked, repeatNext: false }, tue, true)).toBe("run");
    // a plain "asked" (Clear / Keep everyone) is never settled by the scheduler
    expect(cleanupStep(show(), { ...didnt, repeatNext: false, cleanup: { status: "asked", at: 1, reason: "canned" } }, tue, true)).toBeNull();
  });
});

describe("timing and the once-per-lineup guard are unchanged", () => {
  it("waits for the day after at the set time, for every outcome", () => {
    for (const l of [happened, didnt, calledOff]) {
      expect(cleanupStep(show({ onHappened: "keep", onDidnt: "keep", onCalledOff: "keep" }), l as never, { date: "2026-10-27", time: "10:59" }, true)).toBeNull();
      expect(cleanupStep(show({ onHappened: "keep", onDidnt: "keep", onCalledOff: "keep" }), l as never, { date: "2026-10-27", time: "11:00" }, true)).toBe("keep");
    }
  });
  it("anything that already started a cleanup blocks the next trigger", () => {
    for (const status of ["done", "kept", "skipped"] as const) expect(cleanupStep(show(), { ...didnt, cleanup: { status, at: 1 } }, tue, true)).toBeNull();
  });
  it("the chosen post only holds back a show that happened", () => {
    const posts: GroupPost[] = [{ id: "p1", template: "groupThanks", daysBefore: -1, time: "10:00", enabled: true }];
    const s = { ...show({ afterPostId: "p1" }), groupPosts: posts };
    expect(cleanupStep(s, happened, tue, true)).toBeNull();
    expect(cleanupStep(s, didnt, tue, true)).toBe("askRepeat");
    expect(cleanupStep(s, calledOff as never, tue, true)).toBe("askRepeat");
  });
  it("offRuleFor", () => {
    expect(offRuleFor(show({ onDidnt: "clear", onCalledOff: "keep" }), didnt)).toBe("clear");
    expect(offRuleFor(show({ onDidnt: "clear", onCalledOff: "keep" }), calledOff)).toBe("keep");
    expect(offRuleFor(show(), happened)).toBeNull();
  });
});

describe("cleanupSummary", () => {
  it("says the rules in a line", () => {
    expect(cleanupSummary(cleanupRules({}))).toBe("Mic happened: clears the group. Didn't happen or called off: follows 'repeat next week'. Repeat keeps everyone, don't repeat clears, undecided asks you.");
    expect(cleanupSummary({ happened: "keep", didnt: "ask", calledOff: "clear" })).toBe("Mic happened: keeps everyone. Didn't happen: asks you first. Called off: clears the group anyway.");
  });
});
