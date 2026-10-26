import { describe, expect, it } from "vitest";
import { askHints, curatorUsage, daysLabel, groupByArea, roomMatches, showSummary, timesLabel, todayAt } from "./roomView.ts";
import { BLR_ROSTER } from "./fixtures/blrRooms.ts";

describe("room summaries", () => {
  it("labels days", () => {
    expect(daysLabel([1, 2, 3, 4])).toBe("Mon–Thu");
    expect(daysLabel([6, 0])).toBe("Sat, Sun");
    expect(daysLabel([1, 3, 5])).toBe("Mon, Wed, Fri");
    expect(daysLabel([0, 1, 2, 3, 4, 5, 6])).toBe("Daily");
    expect(daysLabel([5, 6, 0])).toBe("Fri–Sun");
  });
  it("labels times and shows", () => {
    expect(timesLabel(["21:30"])).toBe("9:30 PM");
    expect(timesLabel(["21:00", "19:00"])).toBe("7:00 PM and 9:00 PM");
    const s = showSummary({ name: "Mic", type: "mic", cadence: "weekly", times: ["21:30"], days: [1, 2, 3, 4].map((weekday) => ({ weekday: weekday as 1, curatorIds: [] })) });
    expect(s).toBe("Mic · Mon–Thu 9:30 PM");
    const m = showSummary({ name: "", type: "show", cadence: "monthly", monthlyWeeks: [1, -1], times: ["20:00"], days: [{ weekday: 6, curatorIds: [] }] });
    expect(m).toBe("Show · 1st, last Sat 8:00 PM");
  });
  it("groups by area and searches", () => {
    const g = groupByArea(BLR_ROSTER.rooms);
    expect(g.map((x) => x.area)).toEqual([...g.map((x) => x.area)].sort((a, b) => a.localeCompare(b)));
    expect(g.flatMap((x) => x.rooms).length).toBe(BLR_ROSTER.rooms.length);
    const first = BLR_ROSTER.rooms[0]!;
    expect(roomMatches(first, BLR_ROSTER.curators, first.name.toUpperCase())).toBe(true);
    expect(roomMatches(first, BLR_ROSTER.curators, "zzzz-nothing")).toBe(false);
  });
  it("finds today's curators, ask hints and usage", () => {
    const withHint = BLR_ROSTER.rooms.find((r) => askHints(r).length > 0)!;
    expect(askHints(withHint)[0]).toMatch(/Ping|reach|Walk|First|Register|Instagram/);
    // 2026-10-26 is a Monday: some seeded room runs a show then.
    const running = BLR_ROSTER.rooms.flatMap((r) => todayAt(r, BLR_ROSTER.curators, "2026-10-26"));
    expect(running.length).toBeGreaterThan(0);
    const use = curatorUsage(BLR_ROSTER.rooms);
    expect(use.size).toBeGreaterThan(0);
  });
});
