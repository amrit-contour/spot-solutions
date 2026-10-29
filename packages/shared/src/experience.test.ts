import { describe, expect, it } from "vitest";
import { experienceLabel, experienceOf, parseComedySince, spotsByYear } from "./experience.ts";
import type { SpotHistoryEntry } from "./types.ts";

const NOW = new Date("2026-10-29T12:00:00Z");
const spot = (date: string, o: Partial<SpotHistoryEntry> = {}): SpotHistoryEntry => ({ date, showId: "s", showName: "Mic", status: "confirmed", ...o });
const spots = (n: number, year = 2026, o: Partial<SpotHistoryEntry> = {}) => Array.from({ length: n }, (_, i) => spot(`${year}-0${(i % 9) + 1}-1${i % 9}`, o));

describe("experienceOf", () => {
  it("new: few spots, or under 6 months", () => {
    expect(experienceOf({ comedySince: "2020", history: spots(2) }, NOW).tags).toContain("New");
    expect(experienceOf({ comedySince: "2026-07", history: spots(20) }, NOW).tags).toContain("New");
  });

  it("nothing known (no spots, no start date): no tag", () => {
    expect(experienceOf({}, NOW).tags).toEqual([]);
  });

  it("a comic with many spots and no 'comedy since' is not New, and years are unknown", () => {
    const e = experienceOf({ history: spots(40, 2025) }, NOW);
    expect(e.tags).not.toContain("New");
    expect(e.known).toBe(false);
    expect(experienceLabel(e)).toBeNull();
  });

  it("beginner: past the new stage but under a year", () => {
    expect(experienceOf({ comedySince: "2026-01", history: spots(8) }, NOW).tags).toEqual(["Beginner"]);
  });

  it("senior: 3 years or more, and the years tick up by themselves", () => {
    const e = experienceOf({ comedySince: "2023-04", history: spots(8) }, NOW);
    expect(e.tags).toContain("Senior");
    expect(experienceLabel(e)).toBe("3 yrs 6 mo");
    expect(experienceLabel(experienceOf({ comedySince: "2023-04", history: spots(8) }, new Date("2027-05-02T00:00:00Z")))).toBe("4 yrs 1 mo");
  });

  it("killer: average 4.3+ over 5+ rated shows", () => {
    expect(experienceOf({ comedySince: "2020", history: spots(5, 2026, { rating: 4.5 }) }, NOW).tags).toContain("Killer");
    expect(experienceOf({ comedySince: "2020", history: spots(4, 2026, { rating: 5 }) }, NOW).tags).not.toContain("Killer");
  });

  it("counts only spots they did: not cancelled, not future, not a no-show", () => {
    const h = [spot("2026-10-01"), spot("2026-10-02", { status: "cancelled" }), spot("2026-12-01"), spot("2026-10-03", { attendance: "no_show" })];
    expect(experienceOf({ history: h }, NOW).spots).toBe(1);
  });

  it("trend compares the last 5 rated shows with the 5 before", () => {
    const old = Array.from({ length: 5 }, (_, i) => spot(`2025-0${i + 1}-01`, { rating: 3 }));
    const recent = Array.from({ length: 5 }, (_, i) => spot(`2026-0${i + 1}-01`, { rating: 4.5 }));
    expect(experienceOf({ history: [...old, ...recent] }, NOW).trend).toBe("up");
  });

  it("inactive after 6 months without a spot", () => {
    expect(experienceOf({ comedySince: "2020", history: [spot("2025-12-01")] }, NOW).inactiveSince).toBe("December 2025");
    expect(experienceOf({ comedySince: "2020", history: [spot("2026-09-01")] }, NOW).inactiveSince).toBeNull();
  });

  it("pinned tags show, hidden ones don't", () => {
    const e = experienceOf({ comedySince: "2020", history: spots(2), tagsPinned: ["Killer"], tagsHidden: ["New"] }, NOW);
    expect(e.tags).toEqual(["Killer", "Senior"]);
    expect(e.computed).toContain("New");
  });

  it("custom thresholds", () => {
    expect(experienceOf({ comedySince: "2024-06", history: spots(8) }, NOW, { seniorYears: 2 }).tags).toContain("Senior");
  });
});

describe("spotsByYear", () => {
  it("counts per year and keeps the empty years in between", () => {
    expect(spotsByYear([spot("2023-02-01"), spot("2023-05-01"), spot("2025-01-01")], NOW)).toEqual([
      { year: 2023, spots: 2 },
      { year: 2024, spots: 0 },
      { year: 2025, spots: 1 },
    ]);
  });
});

describe("parseComedySince", () => {
  it("takes YYYY and YYYY-MM, nothing else", () => {
    expect(parseComedySince("2019")?.toISOString().slice(0, 7)).toBe("2019-01");
    expect(parseComedySince("2019-06")?.toISOString().slice(0, 7)).toBe("2019-06");
    expect(parseComedySince("June 2019")).toBeNull();
    expect(parseComedySince("2019-13")).toBeNull();
  });
});
