import { describe, expect, it } from "vitest";
import { clashes, type MySpot } from "./rooms.ts";
import { spotStats } from "./spots.ts";
import { materializeRegular, mergeRegulars, regularDates, regularFromSpot, regularLabel, regularSpotId, suggestRegulars, validateRegular, type RegularSpot } from "./regulars.ts";
import { DAY_NAMES } from "./week.ts";

const base: RegularSpot = { id: "r1", roomName: "Bloom", cadence: "weekly", weekdays: [1], startDate: "2026-10-05", time: "21:00", createdAt: 1 };

describe("regularDates", () => {
  it("weekly", () => expect(regularDates(base, "2026-10-01", "2026-10-31")).toEqual(["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]));
  it("starts at the start date, ends at the end date", () => {
    expect(regularDates({ ...base, endDate: "2026-10-12" }, "2026-09-01", "2026-12-01")).toEqual(["2026-10-05", "2026-10-12"]);
  });
  it("every other week counts from the start week, even across a month and the year", () => {
    expect(regularDates({ ...base, cadence: "biweekly", startDate: "2026-12-14" }, "2026-12-01", "2027-01-31")).toEqual(["2026-12-14", "2026-12-28", "2027-01-11", "2027-01-25"]);
  });
  it("biweekly with the start on a later weekday of the week", () => {
    const r: RegularSpot = { ...base, cadence: "biweekly", weekdays: [1, 5], startDate: "2026-10-07" };
    expect(regularDates(r, "2026-10-01", "2026-10-31")).toEqual(["2026-10-09", "2026-10-19", "2026-10-23"]);
  });
  it("custom weekdays", () => expect(regularDates({ ...base, cadence: "custom", weekdays: [2, 4] }, "2026-10-05", "2026-10-11")).toEqual(["2026-10-06", "2026-10-08"]));
  it("monthly nth weekday, and the last", () => {
    const second: RegularSpot = { ...base, cadence: "monthly", weekdays: [1], nth: [2], startDate: "2026-01-01" };
    expect(regularDates(second, "2026-10-01", "2026-11-30")).toEqual(["2026-10-12", "2026-11-09"]);
    const last = { ...second, nth: [-1] };
    expect(regularDates(last, "2026-10-01", "2026-11-30")).toEqual(["2026-10-26", "2026-11-30"]);
    // the fifth Monday of a month (Aug 2026 has five) is also the last
    expect(regularDates({ ...second, nth: [5] }, "2026-08-01", "2026-08-31")).toEqual(["2026-08-31"]);
    expect(regularDates({ ...last }, "2026-08-01", "2026-08-31")).toEqual(["2026-08-31"]);
  });
  it("monthly with no nth uses the start date's", () => {
    expect(regularDates({ ...base, cadence: "monthly", weekdays: [], startDate: "2026-10-14" }, "2026-10-01", "2026-12-31")).toEqual(["2026-10-14", "2026-11-11", "2026-12-09"]);
  });
  it("skips, unless asked", () => {
    const r = { ...base, skipped: ["2026-10-12"] };
    expect(regularDates(r, "2026-10-01", "2026-10-20")).toEqual(["2026-10-05", "2026-10-19"]);
    expect(regularDates(r, "2026-10-01", "2026-10-20", true)).toHaveLength(3);
  });
});

describe("mergeRegulars", () => {
  it("computes occurrences as regular spots and prefers a stored doc", () => {
    const stored: MySpot = { ...materializeRegular(mergeRegulars([], [base], "2026-10-12", "2026-10-12")[0]!), happened: true, notes: { rating: 4 } };
    expect(stored.id).toBe(regularSpotId("r1", "2026-10-12"));
    const out = mergeRegulars([stored], [base], "2026-10-05", "2026-10-19");
    expect(out.map((s) => s.date)).toEqual(["2026-10-12", "2026-10-05", "2026-10-19"].sort((a, b) => (a === "2026-10-12" ? -1 : b === "2026-10-12" ? 1 : a.localeCompare(b))));
    expect(out.find((s) => s.date === "2026-10-12")!.happened).toBe(true);
    expect(out.filter((s) => s.virtual)).toHaveLength(2);
    expect(out.every((s) => s.source === "regular" && s.regularId === "r1")).toBe(true);
  });
  it("materialising is idempotent and drops the virtual flag", () => {
    const a = mergeRegulars([], [base], "2026-10-05", "2026-10-05")[0]!;
    expect(materializeRegular(a)).toEqual(materializeRegular(a));
    expect("virtual" in materializeRegular(a)).toBe(false);
  });
  it("a skipped date drops out (placeholder on request), but not a played one", () => {
    const r = { ...base, skipped: ["2026-10-12"] };
    expect(mergeRegulars([], [r], "2026-10-05", "2026-10-19").map((s) => s.date)).toEqual(["2026-10-05", "2026-10-19"]);
    const withSkipped = mergeRegulars([], [r], "2026-10-05", "2026-10-19", true);
    expect(withSkipped.find((s) => s.date === "2026-10-12")).toMatchObject({ status: "cancelled", skippedRegular: true });
    const played: MySpot = { ...materializeRegular(mergeRegulars([], [base], "2026-10-12", "2026-10-12")[0]!), happened: true };
    expect(mergeRegulars([played], [r], "2026-10-12", "2026-10-12").some((s) => s.date === "2026-10-12")).toBe(true);
  });
  it("counts in clashes and stats", () => {
    const spots = mergeRegulars([], [base], "2026-10-05", "2026-10-19");
    expect(clashes(spots, { date: "2026-10-12", time: "21:30" })).toHaveLength(1);
    expect(clashes(spots, { date: "2026-10-13", time: "21:30" })).toHaveLength(0);
    const stats = spotStats(spots, [], "2026-10-13");
    expect(stats.toCheck).toBe(2);
    expect(stats.bookedWeek).toBe(0);
  });
});

describe("helpers", () => {
  it("labels", () => {
    expect(regularLabel(base, DAY_NAMES)).toBe("Every Monday");
    expect(regularLabel({ ...base, cadence: "biweekly" }, DAY_NAMES)).toBe("Every other Monday");
    expect(regularLabel({ ...base, cadence: "monthly", nth: [2, -1] }, DAY_NAMES)).toBe("2nd and last Monday of the month");
    expect(regularLabel({ ...base, cadence: "custom", weekdays: [2, 4, 6] }, DAY_NAMES)).toBe("Every Tuesday, Thursday and Saturday");
  });
  it("validates", () => {
    expect(validateRegular(base)).toEqual([]);
    expect(validateRegular({ ...base, roomName: " ", endDate: "2026-01-01" })).toHaveLength(2);
  });
  it("makes a regular from a spot", () => {
    const r = regularFromSpot({ date: "2026-10-29", time: "20:00", roomId: "x", roomName: "Bloom" }, "n", 5);
    expect(r).toMatchObject({ cadence: "weekly", weekdays: [4], startDate: "2026-10-29", time: "20:00", roomId: "x" });
  });
  it("suggests regulars from the roster's myRole", () => {
    const rooms = [{ id: "a", name: "A", shows: [{ id: "s", name: "Mic", myRole: "regular", cadence: "weekly", times: ["20:00"], days: [{ weekday: 3 }] }, { id: "t", name: "Other", cadence: "weekly", times: [], days: [{ weekday: 1 }] }] }] as never;
    const out = suggestRegulars(rooms, [], "2026-10-27", (r, s) => `${r}_${s}`, 1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ roomId: "a", showId: "s", weekdays: [3], time: "20:00" });
    expect(suggestRegulars(rooms, [{ roomId: "a", showId: "s" }], "2026-10-27", () => "x", 1)).toHaveLength(0);
  });
});
