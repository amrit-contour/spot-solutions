import { describe, expect, it } from "vitest";
import { cancelledPatch, diffLineup, effectiveMinutes, resendCandidates, sentSnapshot, settleSent } from "./lineupUpdates.ts";
import { diffGroup, groupModeOf, groupPanel } from "./groupSync.ts";

const show = { includeSlotTime: true, defaultMinutes: 5 };
const slots = (...ids: string[]) => ids.map((comicId) => ({ comicId }));

describe("effectiveMinutes", () => {
  it("uses the slot, then the default, and nothing when the show doesn't mention minutes", () => {
    expect(effectiveMinutes(show, { comicId: "a", minutes: 7 })).toBe(7);
    expect(effectiveMinutes(show, { comicId: "a" })).toBe(5);
    expect(effectiveMinutes({ includeSlotTime: false, defaultMinutes: 5 }, { comicId: "a", minutes: 7 })).toBeNull();
  });
});

describe("diffLineup", () => {
  const sent = sentSnapshot(slots("a", "b", "c"), show, 100);

  it("finds nothing when the lineup is as sent", () => {
    const d = diffLineup(slots("a", "b", "c"), sent, show);
    expect(d).toMatchObject({ added: [], removed: [], moved: [], minutes: [], total: 0 });
  });

  it("treats a told ad hoc slot as unchanged: never added, moved or resent, and the others aren't moved by it", () => {
    const base = sentSnapshot(slots("a", "b"), show, 100);
    const withAdhoc = { ...base, z: { at: 200, minutes: 5, order: 0 } }; // draft-style entry: order doesn't match
    const live = [{ comicId: "a" }, { comicId: "b" }, { comicId: "z", adhoc: true, minutes: 9 }];
    const d = diffLineup(live, withAdhoc, show);
    expect(d).toMatchObject({ added: [], removed: [], moved: [], minutes: [], total: 0 });
  });

  it("still lists an ad hoc slot that was never told", () => {
    const d = diffLineup([...slots("a", "b", "c"), { comicId: "z", adhoc: true }], sent, show);
    expect(d.added).toEqual(["z"]);
  });

  it("finds adds and removes", () => {
    const d = diffLineup(slots("a", "c", "d"), sent, show);
    expect(d.added).toEqual(["d"]);
    expect(d.removed).toEqual(["b"]);
    expect(d.total).toBe(2);
  });

  it("doesn't flag the people below someone who was removed as moved", () => {
    expect(diffLineup(slots("b", "c"), sent, show).moved).toEqual([]);
  });

  it("finds a reorder and reports 1-based positions", () => {
    const d = diffLineup(slots("c", "a", "b"), sent, show);
    expect(d.moved.map((m) => m.comicId)).toEqual(["c", "a", "b"]);
    expect(d.moved[0]).toEqual({ comicId: "c", from: 3, to: 1 });
    expect(d.total).toBe(3);
  });

  it("finds minutes changes, and ignores them for shows that don't mention minutes", () => {
    const d = diffLineup([{ comicId: "a", minutes: 8 }, { comicId: "b" }, { comicId: "c" }], sent, show);
    expect(d.minutes).toEqual([{ comicId: "a", from: 5, to: 8 }]);
    expect(diffLineup([{ comicId: "a", minutes: 8 }, { comicId: "b" }, { comicId: "c" }], sentSnapshot(slots("a", "b", "c"), { includeSlotTime: false }, 1), { includeSlotTime: false }).minutes).toEqual([]);
  });

  it("counts a person once when they moved and changed minutes", () => {
    const d = diffLineup([{ comicId: "b", minutes: 9 }, { comicId: "a" }, { comicId: "c" }], sent, show);
    expect(resendCandidates(d).sort()).toEqual(["a", "b"]);
    expect(d.total).toBe(2);
  });

  it("treats everyone as added when nothing was recorded", () => {
    expect(diffLineup(slots("a"), undefined, show).added).toEqual(["a"]);
  });
});

describe("settleSent", () => {
  const sent = sentSnapshot(slots("a", "b", "c"), show, 100);

  it("records adds and drops removals", () => {
    const out = settleSent(slots("a", "c", "d"), show, sent, 500, { messaged: ["d"] });
    expect(Object.keys(out)).toEqual(["a", "c", "d"]);
    expect(out.d).toEqual({ at: 500, minutes: 5, order: 2 });
    expect(out.a.at).toBe(100);
    expect(out.c.order).toBe(1);
  });

  it("moves the time only for people who were messaged", () => {
    const next = [{ comicId: "a", minutes: 8 }, { comicId: "b" }, { comicId: "c" }];
    expect(settleSent(next, show, sent, 500, { messaged: [] }).a).toEqual({ at: 100, minutes: 8, order: 0 });
    expect(settleSent(next, show, sent, 500, { messaged: ["a"] }).a.at).toBe(500);
  });

  it("leaves failed adds unsent and failed removals listed", () => {
    const out = settleSent(slots("a", "d"), show, sent, 500, { failed: ["d", "b"] });
    expect(out.d).toBeUndefined();
    expect(out.b).toEqual(sent.b);
    const d = diffLineup(slots("a", "d"), out, show);
    expect(d.added).toEqual(["d"]);
    expect(d.removed).toEqual(["b"]);
  });

  it("keeps the old minutes for a failed resend so the change stays visible", () => {
    const next = [{ comicId: "a", minutes: 8 }, { comicId: "b" }, { comicId: "c" }];
    const out = settleSent(next, show, sent, 500, { failed: ["a"] });
    expect(diffLineup(next, out, show).minutes).toEqual([{ comicId: "a", from: 5, to: 8 }]);
  });
});

describe("cancelledPatch", () => {
  const lineup = { weekOf: "2026-10-26", showId: "mon" };
  const mon = { id: "mon", name: "Monday Mic", weekday: 1 as const };
  it("logs a cancelled entry and undoes this week's performed mark", () => {
    const p = cancelledPatch({ history: [{ date: "2026-10-26", showId: "mon", showName: "Monday Mic", status: "confirmed" }], lastPerformedWeek: "2026-10-26" }, lineup, mon);
    expect(p.history).toEqual([{ date: "2026-10-26", showId: "mon", showName: "Monday Mic", status: "cancelled" }]);
    expect(p.lastPerformedWeek).toBeNull();
  });
  it("leaves the performed mark when they're still on another lineup", () => {
    expect(cancelledPatch({ lastPerformedWeek: "2026-10-26" }, lineup, mon, true)).not.toHaveProperty("lastPerformedWeek");
  });
});

describe("diffGroup forceRemove", () => {
  const base = { participants: [{ id: "me", isAdmin: true }, { id: "boss", isAdmin: true }, { id: "reg", isAdmin: false }, { id: "a", isAdmin: false }], confirmed: ["a", "b"], regulars: ["reg"], protected: [], self: "me" };
  it("removes marked admins and regulars but never the curator or someone on the lineup", () => {
    const d = diffGroup({ ...base, forceRemove: ["boss", "reg", "a", "me"] });
    expect(d.toRemove.sort()).toEqual(["boss", "reg"]);
    expect(d.toAdd).toEqual(["b"]);
  });
});

describe("groupPanel", () => {
  const members = [
    { id: "1@c.us", name: "Admin", isAdmin: true },
    { id: "2@c.us", name: "Co", isAdmin: false },
    { id: "3@c.us", name: "Reg", isAdmin: false },
    { id: "4@c.us", name: "Lineup", isAdmin: false },
    { id: "5@c.us", name: "Old", isAdmin: false },
    { id: "6@lid", name: "Unknown", isAdmin: false },
  ];
  const panel = groupPanel({ members, lineup: ["4@c.us", "9@c.us"], regulars: ["3@c.us"], protected: ["2@c.us"] });
  const tags = (id: string) => panel.rows.find((r) => r.id === id)!.tags;

  it("tags each member", () => {
    expect(tags("1@c.us")).toEqual(["admin"]);
    expect(tags("2@c.us")).toEqual(["cohost"]);
    expect(tags("3@c.us")).toEqual(["regular"]);
    expect(tags("4@c.us")).toEqual(["lineup"]);
    expect(tags("5@c.us")).toEqual(["leaving"]);
  });
  it("lists lineup comics who aren't in the group yet as joining", () => {
    const r = panel.rows.find((x) => x.id === "9@c.us")!;
    expect(r.member).toBe(false);
    expect(r.tags).toEqual(["joining"]);
    expect(panel.toAdd).toEqual(["9@c.us"]);
  });
  it("never marks a number it can't match as leaving", () => {
    expect(tags("6@lid")).toEqual([]);
    expect(panel.toRemove).toEqual(["5@c.us"]);
  });
  it("counts who stays", () => {
    expect(panel.kept.sort()).toEqual(["1@c.us", "2@c.us", "3@c.us"]);
  });
  it("shows a forced admin as leaving", () => {
    const p = groupPanel({ members, lineup: [], regulars: [], protected: [], forceRemove: ["1@c.us"] });
    expect(p.rows.find((r) => r.id === "1@c.us")!.tags).toEqual(["admin", "leaving"]);
  });
});

describe("groupModeOf", () => {
  it("keeps the old behaviour for shows with a group but no mode", () => {
    expect(groupModeOf({ groupId: "g" })).toBe("confirm");
    expect(groupModeOf({ groupMode: "manual", groupId: "g" })).toBe("manual");
    expect(groupModeOf({ groupMode: "show_day", groupId: "g" })).toBe("show_day");
    expect(groupModeOf({ groupId: null })).toBe("manual");
  });
});

import { adhocToldPatch, toldSent } from "./lineupUpdates.ts";
describe("ad hoc comics are recorded as told", () => {
  const show = { includeSlotTime: false, defaultMinutes: null };
  const draft = { status: "draft" as const, sent: null, slots: [{ comicId: "a" }, { comicId: "b" }, { comicId: "x", adhoc: true }] };
  it("on a draft, only the told comic gets an entry (the rest still get Confirm & send)", () => {
    expect(Object.keys(toldSent(draft, show, "x", 5))).toEqual(["x"]);
  });
  it("on a confirmed lineup with no record, the others stand as told, as before", () => {
    expect(Object.keys(toldSent({ ...draft, status: "confirmed" }, show, "x", 5)).sort()).toEqual(["a", "b", "x"]);
  });
  it("migration: an accepted-offer ad hoc slot with no entry gets one; run again, nothing changes", () => {
    const sent = adhocToldPatch(draft, show, new Set(["x"]), 9);
    expect(Object.keys(sent ?? {})).toEqual(["x"]);
    expect(adhocToldPatch({ ...draft, sent }, show, new Set(["x"]), 10)).toBeNull();
  });
  it("migration leaves alone: not accepted, not told (notTold), backfilled or called-off lineups", () => {
    expect(adhocToldPatch(draft, show, new Set(), 9)).toBeNull();
    expect(adhocToldPatch({ ...draft, slots: [{ comicId: "x", adhoc: true, notTold: true }] }, show, new Set(["x"]), 9)).toBeNull();
    expect(adhocToldPatch({ ...draft, backfilled: true }, show, new Set(["x"]), 9)).toBeNull();
    expect(adhocToldPatch({ ...draft, status: "cancelled" }, show, new Set(["x"]), 9)).toBeNull();
  });
});
