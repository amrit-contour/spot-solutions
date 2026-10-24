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
