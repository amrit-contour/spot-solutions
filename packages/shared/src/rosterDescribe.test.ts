import { describe, expect, it } from "vitest";
import { buildBlrRoster } from "./fixtures/blrRooms.ts";
import { shareableRoster, type Roster, type SharedRoster } from "./rooms.ts";
import { diffRosters, type RosterChange } from "./rosterMerge.ts";
import { changeTitle, clockLabel, describeChange, formatValue, listDiff, timesText, weekdaysText } from "./rosterDescribe.ts";

const mine = (): Roster => buildBlrRoster();
const pub = (): SharedRoster => shareableRoster(mine());
const ch = (over: Partial<RosterChange>): RosterChange => ({ id: "x", op: "changed", level: "show", label: "Bloom · Mic · times", ...over });

describe("formatters", () => {
  it("reads times without :00", () => {
    expect(clockLabel("21:00")).toBe("9 PM");
    expect(clockLabel("20:30")).toBe("8:30 PM");
    expect(timesText(["21:00", "19:00"])).toBe("7 PM, 9 PM");
    expect(formatValue("times", ["21:00"])).toBe("9 PM");
  });
  it("weekdays, ask rules, limits, booleans, tags", () => {
    expect(weekdaysText([1, 2])).toBe("Mon, Tue");
    expect(formatValue("askRule", { kind: "weekday", day: 1, morning: true })).toBe("Ping Monday morning");
    expect(formatValue("limits", [{ scope: "room", perWeek: 2 }])).toBe("2 a week");
    expect(formatValue("limits", [{ scope: "show", perMonth: 1 }])).toBe("Show: 1 a month");
    expect(formatValue("whatever", true)).toBe("On");
    expect(formatValue("whatever", false)).toBe("Off");
    expect(formatValue("tags", ["new-comics", "paid-entry"])).toBe("new-comics, paid-entry");
    expect(formatValue("type", "both")).toBe("Mic and show");
    expect(formatValue("times", [])).toBe("nothing");
  });
  it("list diffs", () => {
    expect(listDiff(["a", "b"], ["b", "c"])).toBe("+ c, − a");
    expect(listDiff(["a"], ["a"])).toBe("");
  });
});

describe("describeChange on a real diff", () => {
  it("a changed start time reads 9 PM to 8:30 PM, never JSON", () => {
    const m = mine();
    const p = pub();
    const room = p.rooms.find((r) => r.shows.length)!;
    room.shows[0]!.times = ["20:30"];
    m.rooms.find((r) => r.id === room.id)!.shows[0]!.times = ["21:00"];
    const c = diffRosters(m, p).find((x) => x.field === "times")!;
    const t = describeChange(c);
    expect(t.from).toBe("9 PM");
    expect(t.to).toBe("8:30 PM");
    expect(t.what).toBe("Start times");
    expect(changeTitle(c)).toMatch(/: Start times$/);
  });
  it("a weekday change shows curators by name", () => {
    const m = mine();
    const p = pub();
    const room = p.rooms.find((r) => r.shows.some((s) => s.days.length))!;
    const day = room.shows.find((s) => s.days.length)!.days[0]!;
    const mr = m.rooms.find((r) => r.id === room.id)!;
    const md = mr.shows.find((s) => s.days.some((d) => d.weekday === day.weekday))!.days.find((d) => d.weekday === day.weekday)!;
    md.curatorIds = [];
    md.theyReachOut = true;
    const c = diffRosters(m, p).find((x) => x.field === `days.${day.weekday}`)!;
    const t = describeChange(c);
    expect(t.from).toMatch(/^they'll reach out/);
    expect(`${t.from}${t.to}`).not.toMatch(/[{}\[\]"]/);
  });
  it("tags show what was added and dropped; curators by name; whole shows summarised", () => {
    expect(describeChange(ch({ level: "room", field: "tags", label: "Bloom · tags", before: ["a", "b"], after: ["b", "c"] })).diff).toBe("+ c, − a");
    const cur = describeChange(ch({ level: "curator", field: "phone", label: "Dhruv · phone", before: "9", after: "8" }));
    expect(cur).toMatchObject({ where: "Dhruv", what: "Number", from: "9", to: "8" });
    const added = describeChange(ch({ op: "added", field: undefined, label: "Bloom · Mic", after: { days: [{ weekday: 1 }, { weekday: 2 }], times: ["21:00"] } }));
    expect(added.summary).toBe("Mon, Tue 9 PM");
    expect(describeChange(ch({ op: "removed", field: "days.3", label: "Bloom · Mic · Wed", before: { curators: ["Akhil"] } })).what).toBe("Stop on Wednesday");
  });
});
