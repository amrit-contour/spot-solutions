import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIRM_TEMPLATE, renderTemplate } from "./template.ts";
import { dateInWeek, formatTime, shiftWeek, weekOf } from "./week.ts";
import { diffGroup } from "./groupSync.ts";

describe("renderTemplate", () => {
  const base = { name: "Rohan", show: "Monday Mic", venue: "Laugh Store", day: "Monday", date: "27 Oct", time: "8:30 PM" };

  it("fills variables", () => {
    expect(renderTemplate("Hi {{name}} @ {{ venue }}", base)).toBe("Hi Rohan @ Laugh Store");
  });

  it("drops the minutes line when the show has no time limit", () => {
    const out = renderTemplate(DEFAULT_CONFIRM_TEMPLATE, base);
    expect(out).not.toContain("min set");
    expect(out).toContain("Laugh Store");
  });

  it("keeps the minutes line when set", () => {
    expect(renderTemplate(DEFAULT_CONFIRM_TEMPLATE, { ...base, minutes: 5 })).toContain("⏱ 5 min set");
  });

  it("supports inverted sections", () => {
    expect(renderTemplate("{{^minutes}}Open set{{/minutes}}", {})).toBe("Open set");
  });

  it("blanks unknown variables", () => {
    expect(renderTemplate("A{{nope}}B", {})).toBe("AB");
  });
});

describe("weekOf", () => {
  // 2026-10-26 is a Monday.
  it("Saturday rolls to next Monday", () => {
    expect(weekOf(new Date("2026-10-24T10:00:00+05:30"))).toBe("2026-10-26");
  });
  it("Monday morning is that Monday", () => {
    expect(weekOf(new Date("2026-10-26T09:00:00+05:30"))).toBe("2026-10-26");
  });
  it("Tuesday is still the same week", () => {
    expect(weekOf(new Date("2026-10-27T23:00:00+05:30"))).toBe("2026-10-26");
  });
  it("Wednesday starts next week's curation", () => {
    expect(weekOf(new Date("2026-10-28T00:30:00+05:30"))).toBe("2026-11-02");
  });
  it("uses the curator's timezone, not UTC", () => {
    // 01:00 IST Wed is still Tue in UTC.
    expect(weekOf(new Date("2026-10-27T19:30:00Z"))).toBe("2026-11-02");
  });
  it("helpers", () => {
    expect(shiftWeek("2026-10-26", -1)).toBe("2026-10-19");
    expect(dateInWeek("2026-10-26", 2)).toBe("2026-10-27");
    expect(formatTime("20:30")).toBe("8:30 PM");
  });
});

describe("diffGroup", () => {
  it("adds new comics, removes last week's, keeps regulars/admins/self", () => {
    const d = diffGroup({
      participants: [
        { id: "me", isAdmin: true },
        { id: "cohost", isAdmin: true },
        { id: "regular", isAdmin: false },
        { id: "lastweek", isAdmin: false },
        { id: "repeat", isAdmin: false },
      ],
      confirmed: ["repeat", "newbie"],
      regulars: ["regular"],
      protected: [],
      self: "me",
    });
    expect(d.toAdd).toEqual(["newbie"]);
    expect(d.toRemove).toEqual(["lastweek"]);
    expect(d.kept.sort()).toEqual(["cohost", "me", "regular"]);
  });
});

import { pendingRejections } from "./defaults.ts";
describe("pendingRejections", () => {
  it("only regrets clear, unplaced, unhandled requests", () => {
    const mk = (comicId: string, status: string, confidence = 0.9) => ({ comicId, status, intent: { confidence } });
    const out = pendingRejections(
      [mk("a", "acked"), mk("b", "assigned"), mk("c", "acked"), mk("d", "dismissed"), mk("e", "new", 0.5), mk("f", "rejected")],
      new Set(["c"]),
    );
    expect(out.map((r) => r.comicId)).toEqual(["a"]);
  });
});

import { holdFor, inWindow, lastSpot, withHistory } from "./rules.ts";
describe("rules", () => {
  const tz = "Asia/Kolkata";
  const w = { enabled: true, startDay: 6 as const, startTime: "15:00", endDay: 1 as const, endTime: "10:00" };
  const rules = { window: w, skipLastWeek: true };
  it("request window wraps Sat 3 PM → Mon 10 AM", () => {
    expect(inWindow(new Date("2026-10-24T16:00:00+05:30"), w, tz)).toBe(true); // Sat 4 PM
    expect(inWindow(new Date("2026-10-25T23:00:00+05:30"), w, tz)).toBe(true); // Sun night
    expect(inWindow(new Date("2026-10-26T09:59:00+05:30"), w, tz)).toBe(true); // Mon 9:59
    expect(inWindow(new Date("2026-10-26T10:00:00+05:30"), w, tz)).toBe(false); // Mon 10:00
    expect(inWindow(new Date("2026-10-24T14:00:00+05:30"), w, tz)).toBe(false); // Sat 2 PM
    expect(inWindow(new Date("2026-10-22T12:00:00+05:30"), w, tz)).toBe(false); // Thu
  });
  it("holds by list, window, then last week", () => {
    const at = new Date("2026-10-25T12:00:00+05:30");
    const base = { id: "a", name: "A", phone: "", tier: "open" as const };
    expect(holdFor({ comic: { ...base, list: "banned" }, week: "2026-10-26", at, rules, timeZone: tz })).toBe("banned");
    expect(holdFor({ comic: { ...base, lastPerformedWeek: "2026-10-19" }, week: "2026-10-26", at, rules, timeZone: tz })).toBe("last_week");
    expect(holdFor({ comic: base, week: "2026-10-26", at: new Date("2026-10-22T12:00:00+05:30"), rules, timeZone: tz })).toBe("midweek");
    expect(holdFor({ comic: base, week: "2026-10-26", at, rules, timeZone: tz })).toBe(null);
  });
  it("history keeps newest first and finds the last real spot", () => {
    let h = withHistory([], { date: "2026-10-13", showId: "m", showName: "Mon", status: "confirmed" });
    h = withHistory(h, { date: "2026-10-20", showId: "m", showName: "Mon", status: "cancelled" });
    h = withHistory(h, { date: "2026-10-27", showId: "t", showName: "Tue", status: "confirmed" });
    expect(h.map((x) => x.date)).toEqual(["2026-10-27", "2026-10-20", "2026-10-13"]);
    expect(lastSpot(h, "2026-10-24")?.date).toBe("2026-10-13");
  });
});

import { rolloverDayFor } from "./week.ts";
describe("week rollover follows the shows", () => {
  const tz = "Asia/Kolkata";
  it("Mon/Tue mic rolls on Wednesday", () => {
    expect(rolloverDayFor([{ weekday: 1 }, { weekday: 2 }])).toBe(3);
  });
  it("a Thursday show keeps this week current through Thursday", () => {
    const r = rolloverDayFor([{ weekday: 1 }, { weekday: 4 }]); // Mon + Thu → Fri
    expect(r).toBe(5);
    expect(weekOf(new Date("2026-10-29T12:00:00+05:30"), tz, r)).toBe("2026-10-26"); // Thu
    expect(weekOf(new Date("2026-10-30T12:00:00+05:30"), tz, r)).toBe("2026-11-02"); // Fri
  });
  it("Sunday shows mean plain calendar weeks", () => {
    const r = rolloverDayFor([{ weekday: 3 }, { weekday: 0 }]);
    expect(r).toBe(1);
    expect(weekOf(new Date("2026-11-01T21:00:00+05:30"), tz, r)).toBe("2026-10-26"); // Sun night
    expect(weekOf(new Date("2026-11-02T09:00:00+05:30"), tz, r)).toBe("2026-11-02"); // Mon
  });
  it("paused shows don't count", () => {
    expect(rolloverDayFor([{ weekday: 1 }, { weekday: 6, active: false }])).toBe(2);
  });
});

import { parseYesNo } from "./defaults.ts";
describe("parseYesNo", () => {
  it("reads common replies", () => {
    for (const y of ["Yes!", "haan bhai", "sure, book me", "Ok 👍", "chalega"]) expect(parseYesNo(y)).toBe(true);
    for (const n of ["no", "Nahi yaar", "can't make it sorry", "nope", "It didn't happen"]) expect(parseYesNo(n)).toBe(false);
    for (const u of ["what time is it?", "", "hmm let me check"]) expect(parseYesNo(u)).toBe(null);
  });
});
