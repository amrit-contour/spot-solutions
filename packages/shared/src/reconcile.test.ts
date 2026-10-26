import { describe, expect, it } from "vitest";
import { isGroupMember, planReconcilePlace, reconcileBucket, reconcileTicked, suggestReconcile, waitingRequests } from "./reconcile.ts";

const shows = [
  { id: "mon", groupId: "g-mon@g.us" },
  { id: "tue", groupId: "g-tue@g.us" },
  { id: "wed", groupId: null },
];
const gave = (showId: string | null) => ({ decision: "gave_spot" as const, showId, evidence: "yes you're on monday" });

describe("suggestReconcile", () => {
  it("places and marks told when the curator gave a spot, and flags the group when they aren't in it", () => {
    const s = suggestReconcile({ decision: gave("mon"), groupShowIds: [], shows });
    expect(s).toMatchObject({ action: "place", showId: "mon", markTold: true, addToGroup: true, confidence: "high", evidence: "yes you're on monday" });
  });
  it("doesn't flag the group when they're already in it, or the show has none", () => {
    expect(suggestReconcile({ decision: gave("mon"), groupShowIds: ["mon"], shows }).addToGroup).toBe(false);
    expect(suggestReconcile({ decision: gave("wed"), groupShowIds: [], shows }).addToGroup).toBe(false);
  });
  it("still flags the group when they're in a different show's group", () => {
    expect(suggestReconcile({ decision: gave("mon"), groupShowIds: ["tue"], shows }).addToGroup).toBe(true);
  });
  it("closes a decline, even when they're in a group", () => {
    const s = suggestReconcile({ decision: { decision: "declined", showId: null, evidence: "sorry full this week" }, groupShowIds: ["mon"], shows });
    expect(s).toMatchObject({ action: "close_declined", markTold: false, addToGroup: false, confidence: "high" });
  });
  it("places a comic in exactly one group with lower confidence and no reply", () => {
    const s = suggestReconcile({ decision: null, groupShowIds: ["tue"], shows });
    expect(s).toMatchObject({ action: "place", showId: "tue", markTold: true, addToGroup: false, confidence: "low" });
    expect(s.reason).toMatch(/already in the group/i);
    expect(reconcileTicked(s)).toBe(false);
  });
  it("does the same when the model was unclear", () => {
    const s = suggestReconcile({ decision: { decision: "unclear", showId: null, evidence: "" }, groupShowIds: ["mon"], shows });
    expect(s).toMatchObject({ action: "place", showId: "mon", confidence: "low" });
  });
  it("does nothing for several groups, no group, or a yes with no known show", () => {
    expect(suggestReconcile({ decision: null, groupShowIds: ["mon", "tue"], shows }).action).toBe("none");
    expect(suggestReconcile({ decision: null, groupShowIds: [], shows }).action).toBe("none");
    expect(suggestReconcile({ decision: gave(null), groupShowIds: [], shows }).action).toBe("none");
    expect(suggestReconcile({ decision: gave("gone"), groupShowIds: [], shows }).action).toBe("none");
  });
  it("uses the one group when a yes doesn't say which show", () => {
    const s = suggestReconcile({ decision: gave(null), groupShowIds: ["tue"], shows });
    expect(s).toMatchObject({ action: "place", showId: "tue", confidence: "low" });
  });
});

describe("buckets", () => {
  it("sorts suggestions into the sheet's sections and ticks only the sure ones", () => {
    const high = suggestReconcile({ decision: gave("mon"), groupShowIds: [], shows });
    const low = suggestReconcile({ decision: null, groupShowIds: ["mon"], shows });
    const no = suggestReconcile({ decision: { decision: "declined", showId: null, evidence: "full" }, groupShowIds: [], shows });
    const none = suggestReconcile({ decision: null, groupShowIds: [], shows });
    expect([high, low, no, none].map(reconcileBucket)).toEqual(["gave", "group", "declined", "none"]);
    expect([high, low, no, none].map(reconcileTicked)).toEqual([true, false, true, false]);
  });
});

describe("isGroupMember", () => {
  const members = [{ id: "919876543210@c.us", name: "A", isAdmin: false }, { id: "555@lid", name: "B", isAdmin: false }];
  it("matches by id, chat id or phone", () => {
    expect(isGroupMember({ id: "919876543210@c.us" }, members)).toBe(true);
    expect(isGroupMember({ id: "x", chatId: "555@lid" }, members)).toBe(true);
    expect(isGroupMember({ id: "x", phone: "+91 98765 43210" }, members)).toBe(true);
    expect(isGroupMember({ id: "y", phone: "1234" }, members)).toBe(false);
  });
});

describe("waitingRequests", () => {
  const r = (comicId: string, status: string, confidence = 0.9, hold: string | null = null, holdOverridden = false) => ({ comicId, status: status as never, hold: hold as never, holdOverridden, intent: { confidence, isSpotRequest: true, preferredDays: [] } });
  it("is the Waiting column: new or acked, unplaced, not held, clear enough", () => {
    const out = waitingRequests([r("a", "new"), r("b", "acked"), r("c", "assigned"), r("d", "new", 0.5), r("e", "acked", 0.5), r("f", "new", 0.9, "midweek"), r("g", "new", 0.9, "midweek", true), r("h", "new")], new Set(["h"]));
    expect(out.map((x) => x.comicId)).toEqual(["a", "b", "e", "g"]);
  });
});

describe("planReconcilePlace", () => {
  const show = { slotCount: 2, includeSlotTime: true, defaultMinutes: 5 };
  it("adds the comic last with the show's set length and records them as told", () => {
    const p = planReconcilePlace({ lineup: { slots: [{ comicId: "a", minutes: 4 }], status: "draft" }, show, comicId: "b", markTold: true, now: 100 });
    expect(p.outcome).toBe("placed");
    expect(p.slots).toEqual([{ comicId: "a", minutes: 4 }, { comicId: "b", minutes: 5 }]);
    expect(p.sent).toEqual({ b: { at: 100, minutes: 5, order: 1 } });
  });
  it("starts from a baseline of the current slots on a confirmed lineup, so only the new comic is told", () => {
    const p = planReconcilePlace({ lineup: { slots: [{ comicId: "a", minutes: 4 }], status: "confirmed", sentAt: 50 }, show, comicId: "b", markTold: true, now: 100 });
    expect(p.sent).toEqual({ a: { at: 50, minutes: 4, order: 0 }, b: { at: 100, minutes: 5, order: 1 } });
  });
  it("without markTold, leaves a draft's record alone and keeps the new comic pending on a confirmed one", () => {
    expect(planReconcilePlace({ lineup: { slots: [], status: "draft" }, show, comicId: "b", markTold: false, now: 1 }).sent).toBeNull();
    const c = planReconcilePlace({ lineup: { slots: [{ comicId: "a" }], status: "confirmed", sentAt: 50 }, show, comicId: "b", markTold: false, now: 100 });
    expect(Object.keys(c.sent ?? {})).toEqual(["a"]);
  });
  it("reports a full or called-off show and changes nothing", () => {
    const full = planReconcilePlace({ lineup: { slots: [{ comicId: "a" }, { comicId: "c" }], status: "draft" }, show, comicId: "b", markTold: true, now: 1 });
    expect(full.outcome).toBe("full");
    expect(full.slots).toHaveLength(2);
    expect(planReconcilePlace({ lineup: { slots: [], status: "cancelled" }, show, comicId: "b", markTold: true, now: 1 }).outcome).toBe("called_off");
  });
  it("creates the lineup when there isn't one, and doesn't add someone twice", () => {
    expect(planReconcilePlace({ lineup: null, show, comicId: "b", markTold: false, now: 1 }).slots).toEqual([{ comicId: "b", minutes: 5 }]);
    const again = planReconcilePlace({ lineup: { slots: [{ comicId: "b", minutes: 5 }], status: "draft" }, show, comicId: "b", markTold: true, now: 9 });
    expect(again.outcome).toBe("already");
    expect(again.slots).toHaveLength(1);
  });
});
