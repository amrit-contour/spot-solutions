import { describe, expect, it } from "vitest";
import { curationWeek, lastShowDate } from "./curationWeek.ts";
import type { Show } from "./types.ts";

type S = Pick<Show, "active" | "weekday" | "activeDates" | "pausedDates">;
const show = (weekday: Show["weekday"], o: Partial<S> = {}): S => ({ weekday, active: true, ...o });
// 2026-10-26 is a Monday. Times are 18:00 IST (12:30 UTC) on the given date.
const at = (date: string) => new Date(`${date}T12:30:00Z`);
const TZ = "Asia/Kolkata";

describe("curationWeek", () => {
  it("stays on this week through the day of the last show", () => {
    const shows = [show(1), show(2)];
    expect(curationWeek(at("2026-10-26"), TZ, shows)).toBe("2026-10-26");
    expect(curationWeek(at("2026-10-27"), TZ, shows)).toBe("2026-10-26");
  });

  it("rolls to next week the day after the last show", () => {
    expect(curationWeek(at("2026-10-28"), TZ, [show(1), show(2)])).toBe("2026-11-02");
  });

  it("a later show this week keeps the week current", () => {
    expect(curationWeek(at("2026-10-28"), TZ, [show(1), show(2), show(4)])).toBe("2026-10-26");
  });

  it("a one-off date for an inactive show counts", () => {
    const shows = [show(1), show(2), show(4, { active: false, activeDates: ["2026-10-29"] })];
    expect(curationWeek(at("2026-10-28"), TZ, shows)).toBe("2026-10-26");
    expect(curationWeek(at("2026-10-30"), TZ, shows)).toBe("2026-11-02");
  });

  it("a skipped date doesn't count", () => {
    const shows = [show(1), show(4, { pausedDates: ["2026-10-29"] })];
    expect(curationWeek(at("2026-10-28"), TZ, shows)).toBe("2026-11-02");
  });

  it("an inactive show doesn't count", () => {
    expect(curationWeek(at("2026-10-28"), TZ, [show(1), show(4, { active: false })])).toBe("2026-11-02");
  });

  it("a Sunday show keeps the whole week", () => {
    expect(curationWeek(at("2026-11-01"), TZ, [show(0)])).toBe("2026-10-26");
  });

  it("uses the local date, not UTC", () => {
    // 2026-10-28 00:30 IST is still 2026-10-27 in UTC: Tuesday's show is over in Bangalore.
    expect(curationWeek(new Date("2026-10-27T19:00:00Z"), TZ, [show(1), show(2)])).toBe("2026-11-02");
  });

  it("no shows set up: the Wednesday default", () => {
    expect(curationWeek(at("2026-10-27"), TZ, [])).toBe("2026-10-26");
    expect(curationWeek(at("2026-10-28"), TZ, [])).toBe("2026-11-02");
  });
});

describe("lastShowDate", () => {
  it("finds the latest date anything is on", () => {
    expect(lastShowDate([show(1), show(5)], "2026-10-26")).toBe("2026-10-30");
    expect(lastShowDate([show(1, { active: false })], "2026-10-26")).toBeNull();
  });
});
