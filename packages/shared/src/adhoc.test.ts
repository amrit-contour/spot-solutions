import { describe, expect, it } from "vitest";
import { cooldownWeeks, cooldownWords, directNotice, directPlan, onYes, recentSpot, roundFilled } from "./adhoc.ts";
import { formatDate } from "./week.ts";

const round = (size: number, slots: number, autoAdd: boolean) => ({ round: { id: "r1", size, slots, autoAdd } });

describe("onYes", () => {
  it("one comic asked (or an old offer with no round): book it", () => {
    expect(onYes({ round: null }, [])).toBe("book");
    expect(onYes(round(1, 1, false), [])).toBe("book");
  });
  it("several asked, auto-add: book while slots are left, then full", () => {
    expect(onYes(round(4, 2, true), [{ status: "accepted" }, { status: "pending" }])).toBe("book");
    expect(onYes(round(4, 2, true), [{ status: "accepted" }, { status: "accepted" }])).toBe("full");
  });
  it("several asked, curator picks: wait in Updates", () => {
    expect(onYes(round(3, 1, false), [{ status: "pending" }])).toBe("pick");
    expect(onYes(round(3, 1, false), [{ status: "accepted" }])).toBe("full");
  });
  it("knows when the round has filled", () => {
    expect(roundFilled(round(3, 2, true), [{ status: "accepted" }])).toBe(false);
    expect(roundFilled(round(3, 2, true), [{ status: "accepted" }, { status: "accepted" }])).toBe(true);
  });
});

describe("cooldown", () => {
  const week = "2026-10-26";
  const spot = (date: string, adhoc = false) => ({ date, showId: "mon", showName: "Monday Mic", status: "confirmed" as const, ...(adhoc && { adhoc: true }) });
  it("finds a spot inside the window, newest first", () => {
    expect(recentSpot({ history: [spot("2026-10-19")] }, week, 1)).toEqual({ date: "2026-10-19", showName: "Monday Mic" });
    expect(recentSpot({ history: [spot("2026-10-12")] }, week, 1)).toBeNull();
    expect(recentSpot({ history: [spot("2026-10-12")] }, week, 2)?.date).toBe("2026-10-12");
  });
  it("ignores ad hoc spots, cancellations and anything this week", () => {
    expect(recentSpot({ history: [spot("2026-10-19", true)] }, week, 4)).toBeNull();
    expect(recentSpot({ history: [{ ...spot("2026-10-19"), status: "canned" }] }, week, 4)).toBeNull();
    expect(recentSpot({ history: [spot("2026-10-26")] }, week, 4)).toBeNull();
  });
  it("falls back to lastPerformedWeek when there's no history", () => {
    expect(recentSpot({ lastPerformedWeek: "2026-10-19" }, week, 1)?.date).toBe("2026-10-19");
    expect(recentSpot({ lastPerformedWeek: "2026-10-05" }, week, 2)).toBeNull();
  });
  it("clamps the weeks and words the reply", () => {
    expect(cooldownWeeks({})).toBe(1);
    expect(cooldownWeeks({ cooldownWeeks: 20 })).toBe(8);
    expect(cooldownWords("2026-10-19", week, 1, formatDate)).toEqual({ lastWhen: "last week", askAgain: "next week" });
    const w = cooldownWords("2026-10-12", week, 4, formatDate);
    expect(w.lastWhen).toBe(`on ${formatDate("2026-10-12")}`);
    expect(w.askAgain).toBe(`from the week of ${formatDate("2026-11-16")}`);
  });
});

describe("direct add (already agreed)", () => {
  it("writes the Updates entry for one or several", () => {
    expect(directNotice(["Rahul"], "Monday Mic")).toBe("Added Rahul to Monday Mic directly");
    expect(directNotice(["Rahul", "Priya"], "Monday Mic")).toBe("Added Rahul and Priya to Monday Mic directly");
    expect(directNotice(["Rahul", "Priya", "Sam"], "Monday Mic")).toBe("Added Rahul, Priya and Sam to Monday Mic directly");
  });
  it("adds everyone not already on it and counts how far over the show goes", () => {
    expect(directPlan(["a", "b"], ["c", "d"], 6)).toEqual({ add: ["c", "d"], already: [], over: 0 });
    expect(directPlan(["a", "b"], ["b", "c", "c"], 3)).toEqual({ add: ["c"], already: ["b"], over: 0 });
    expect(directPlan(["a", "b", "c"], ["d", "e"], 4)).toEqual({ add: ["d", "e"], already: [], over: 1 });
  });
});
