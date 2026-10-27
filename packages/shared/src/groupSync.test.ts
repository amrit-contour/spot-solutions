import { describe, expect, it } from "vitest";
import { groupPanel, groupPlanNeedsReview } from "./groupSync.ts";

describe("POCs in the group panel", () => {
  it("tags POCs (not also co-host), keeps them in a sync, and never marks them leaving", () => {
    const members = [
      { id: "p@c.us", name: "Poc", isAdmin: false },
      { id: "x@c.us", name: "Last week", isAdmin: false },
    ];
    const out = groupPanel({ members, lineup: [], regulars: [], protected: ["p@c.us"], pocs: ["p@c.us"] });
    expect(out.rows.find((r) => r.id === "p@c.us")?.tags).toEqual(["poc"]);
    expect(out.toRemove).toEqual(["x@c.us"]);
  });
});

import { diffGroup, inGroup, liveInvites, settleSyncResults, INVITE_TTL_MS } from "./groupSync.ts";

describe("group sync identity matching", () => {
  const base = { regulars: [], protected: [], self: "me@c.us", confirmed: ["111@lid"] };
  it("an @lid comic already in the group as a phone id is not offered for adding", () => {
    const d = diffGroup({ ...base, participants: [{ id: "6111@c.us", isAdmin: false, keys: ["111@lid", "6111@c.us"] }], aliases: {} });
    expect(d.toAdd).toEqual([]);
  });
  it("matches through the comic's other ids (chat id, phone)", () => {
    const d = diffGroup({ ...base, confirmed: ["6111@c.us"], participants: [{ id: "999@lid", isAdmin: false }], aliases: { "6111@c.us": ["999@lid"] } });
    expect(d.toAdd).toEqual([]);
    expect(d.toRemove).toEqual([]);
  });
  it("a lineup comic who is not there is added; an unrelated member leaves", () => {
    const d = diffGroup({ ...base, participants: [{ id: "777@c.us", isAdmin: false }] });
    expect(d.toAdd).toEqual(["111@lid"]);
    expect(d.toRemove).toEqual(["777@c.us"]);
  });
  it("someone with a live invite is waiting, not re-offered", () => {
    const d = diffGroup({ ...base, participants: [], waiting: ["111@lid"] });
    expect(d.toAdd).toEqual([]);
    expect(d.invited).toEqual(["111@lid"]);
  });
  it("inGroup uses alt ids and aliases", () => {
    expect(inGroup("111@lid", [{ id: "6111@c.us", alt: ["111@lid"] }])).toBe(true);
    expect(inGroup("a@c.us", [{ id: "x@lid" }], { "a@c.us": ["x@lid"] })).toBe(true);
    expect(inGroup("a@c.us", [{ id: "x@lid" }])).toBe(false);
  });
});

describe("invites and verifying a sync", () => {
  const now = 1_000_000_000;
  it("an add that the group doesn't show becomes an invite waiting for them; one that did join is added", () => {
    const r = settleSyncResults({ results: { a: "added", b: "added", c: "invited", d: "failed" }, now, isIn: (id) => id === "a" });
    expect(r.results).toEqual({ a: "added", b: "invited", c: "invited", d: "failed" });
    expect(Object.keys(r.invites).sort()).toEqual(["b", "c"]);
  });
  it("a removal that left them in the group failed", () => {
    expect(settleSyncResults({ results: { a: "removed", b: "removed" }, now, isIn: (id) => id === "a" }).results).toEqual({ a: "failed", b: "removed" });
  });
  it("keeps earlier invites for people still outside and drops the ones who joined", () => {
    const r = settleSyncResults({ results: {}, now, prior: { x: 5, y: 6 }, isIn: (id) => id === "y" });
    expect(r.invites).toEqual({ x: 5 });
  });
  it("invites lapse after 24 hours and drop out when they join or come off the lineup", () => {
    const l = liveInvites({ fresh: now - 1000, old: now - INVITE_TTL_MS - 1, joined: now, off: now }, now, ["fresh", "old", "joined"], (id) => id === "joined");
    expect(Object.keys(l.waiting)).toEqual(["fresh"]);
    expect(l.lapsed).toEqual(["old"]);
  });
  it("the panel tags an invited comic Invite sent, never Joining, and doesn't list them as to add", () => {
    const p = groupPanel({ members: [], lineup: ["a@c.us"], regulars: [], protected: [], invited: { "a@c.us": now } });
    expect(p.toAdd).toEqual([]);
    expect(p.rows[0].tags).toEqual(["invited"]);
  });
});

describe("groupPlanNeedsReview", () => {
  it("is false when nothing to add or remove", () => {
    expect(groupPlanNeedsReview({ toAdd: [], toRemove: [] })).toBe(false);
    expect(groupPlanNeedsReview(null)).toBe(false);
  });
  it("ignores people with an invite still waiting, counts lapsed ones", () => {
    expect(groupPlanNeedsReview({ toAdd: ["a"], toRemove: [], invited: { a: 1 } })).toBe(false);
    expect(groupPlanNeedsReview({ toAdd: ["a"], toRemove: [], invited: { a: 1 } }, { lapsed: ["a"] })).toBe(true);
  });
  it("ignores adds already in the cached group, counts removes", () => {
    expect(groupPlanNeedsReview({ toAdd: ["61400000001@c.us"], toRemove: [] }, { members: [{ id: "61400000001@c.us" }] })).toBe(false);
    expect(groupPlanNeedsReview({ toAdd: [], toRemove: ["x"] })).toBe(true);
  });
});
