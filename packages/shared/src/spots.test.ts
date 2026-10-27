import { describe, expect, it } from "vitest";
import { bySpotTime, cleanNotes, clashingIds, manualSpot, spotClashes, spotDateLabel, spotHasNotes, spotState, spotStats, spotsByDay, validateSpot } from "./spots.ts";
import type { Ask, MySpot } from "./rooms.ts";

// 2026-10-27 is a Tuesday: the week is Mon 26 to Sun 1 Nov.
const TODAY = "2026-10-27";
const spot = (p: Partial<MySpot>): MySpot => ({ id: Math.random().toString(36).slice(2), date: TODAY, source: "ask", createdAt: 0, ...p });
const ask = (p: Partial<Ask>): Ask => ({ id: Math.random().toString(36).slice(2), roomId: "r", showId: "s", showDate: TODAY, status: "sent", createdAt: 0, ...p });

describe("spotState", () => {
  it("places a spot against today", () => {
    expect(spotState(spot({ date: "2026-10-30" }), TODAY)).toBe("upcoming");
    expect(spotState(spot({}), TODAY)).toBe("tonight");
    expect(spotState(spot({ date: "2026-10-20" }), TODAY)).toBe("to_check");
    expect(spotState(spot({ date: "2026-10-20", happened: true }), TODAY)).toBe("happened");
    expect(spotState(spot({ date: "2026-10-20", happened: false }), TODAY)).toBe("didnt");
    expect(spotState(spot({ status: "cancelled" }), TODAY)).toBe("cancelled");
  });
});

describe("the calendar", () => {
  const list = [spot({ id: "c", date: "2026-10-29", time: "21:00" }), spot({ id: "a", date: "2026-10-28" }), spot({ id: "b", date: "2026-10-29", time: "19:00" }), spot({ id: "n", date: "2026-10-29" })];
  it("groups by date and orders by time, untimed last", () => {
    const days = spotsByDay(list);
    expect(days.map((d) => d.date)).toEqual(["2026-10-28", "2026-10-29"]);
    expect(days[1]!.spots.map((s) => s.id)).toEqual(["b", "c", "n"]);
    expect(spotsByDay(list, true).map((d) => d.date)).toEqual(["2026-10-29", "2026-10-28"]);
    expect([...list].sort(bySpotTime)[0]!.id).toBe("a");
  });
  it("labels a date", () => expect(spotDateLabel("2026-10-29")).toBe("Thu 29 Oct"));
  it("flags clashes, but not spots with no time, cancelled ones or ones that didn't happen", () => {
    const a = spot({ id: "a", time: "20:00" });
    const b = spot({ id: "b", time: "21:00" });
    const far = spot({ id: "far", time: "23:30" });
    expect(spotClashes([a, b, far], a).map((s) => s.id)).toEqual(["b"]);
    expect([...clashingIds([a, b, far])].sort()).toEqual(["a", "b"]);
    expect(clashingIds([a, spot({ id: "n" }), spot({ id: "x", time: "20:30", status: "cancelled" }), spot({ id: "y", time: "20:30", happened: false })]).size).toBe(0);
    // A candidate not saved yet is checked against every saved spot.
    expect(spotClashes([a], { id: "new", date: TODAY, time: "20:45" })).toHaveLength(1);
  });
});

describe("notes", () => {
  it("trims, drops empty fields and bad ratings", () => {
    expect(cleanNotes({ room: " Good sound ", crowd: "  ", rating: 7, setList: "" })).toEqual({ room: "Good sound" });
    expect(cleanNotes({ rating: 4, whatWorked: " the callback " })).toEqual({ rating: 4, whatWorked: "the callback" });
    expect(cleanNotes({ rating: 0 })).toBeUndefined();
    expect(cleanNotes(undefined)).toBeUndefined();
    expect(spotHasNotes({ notes: { crowd: "loud" } })).toBe(true);
    expect(spotHasNotes({})).toBe(false);
  });
});

describe("validateSpot / manualSpot", () => {
  it("lists what to fix", () => {
    expect(validateSpot({ date: "", roomName: "" })).toHaveLength(2);
    expect(validateSpot({ date: TODAY, roomName: "Bloom", time: "25:00" })).toEqual(["That time isn't valid."]);
    expect(validateSpot({ date: TODAY, roomName: "Bloom", time: "20:00" })).toEqual([]);
  });
  it("makes an ad hoc booked spot", () => {
    expect(manualSpot({ date: TODAY, roomName: " Bloom ", time: "20:00" }, "id1", 9)).toEqual({ id: "id1", date: TODAY, time: "20:00", roomName: "Bloom", source: "adhoc", happened: null, status: "booked", createdAt: 9 });
  });
});

describe("spotStats", () => {
  const spots = [
    spot({ date: "2026-10-26", happened: true, roomId: "bloom", roomName: "Bloom", notes: { rating: 4 } }),
    spot({ date: "2026-10-20", happened: true, roomId: "bloom", roomName: "Bloom", notes: { rating: 5 } }),
    spot({ date: "2026-10-03", happened: true, roomId: "glens", roomName: "Glen's" }),
    spot({ date: "2026-09-28", happened: true, roomName: "Banter" }),
    spot({ date: "2026-10-22", happened: null, roomName: "Banter" }),
    spot({ date: "2026-10-29", happened: null, roomName: "Banter" }),
    spot({ date: "2026-11-05", happened: null, roomName: "Banter" }),
    spot({ date: "2026-10-27", happened: false }),
    spot({ date: "2026-10-28", status: "cancelled" }),
  ];
  const asks = [ask({ status: "got_it" }), ask({ status: "got_it" }), ask({ status: "declined" }), ask({ status: "no_reply" }), ask({ status: "sent" }), ask({ status: "planned" }), ask({ status: "expired", skipped: true })];
  const s = spotStats(spots, asks, TODAY);
  it("counts this week and this month", () => {
    expect(s.doneWeek).toBe(1);
    expect(s.doneMonth).toBe(3);
    expect(s.done).toBe(4);
    expect(s.bookedWeek).toBe(1);
    expect(s.toCheck).toBe(1);
  });
  it("counts per room, most first", () => {
    expect(s.byRoom).toEqual([{ roomId: "bloom", roomName: "Bloom", count: 2 }, { roomId: undefined, roomName: "Banter", count: 1 }, { roomId: "glens", roomName: "Glen's", count: 1 }]);
  });
  it("counts asks sent against got it, ignoring drafts and skips", () => {
    expect(s.asks).toEqual({ sent: 5, gotIt: 2, declined: 1, noReply: 1, waiting: 1 });
  });
  it("averages ratings", () => {
    expect(s.avgRating).toBe(4.5);
    expect(spotStats([], [], TODAY)).toMatchObject({ avgRating: null, done: 0, byRoom: [] });
  });
});
