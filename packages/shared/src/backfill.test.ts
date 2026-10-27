import { describe, expect, it } from "vitest";
import { backfillAddSlot, backfillBase, backfillPatch, isBackfilled, isPastShow, kindOfSlot, requestAfterBackfill, toldAfterBackfill } from "./backfill.ts";
import { recentSpot } from "./adhoc.ts";
import type { Comic, Lineup, Show } from "./types.ts";

const show = { id: "mon", name: "Monday Mic" } as Show;
const base = { date: "2026-10-12", weekOf: "2026-10-12", show, rolloverDay: 3 as const };
const comic = (c: Partial<Comic> = {}): Comic => ({ id: "a@c.us", name: "A", phone: "1", tier: "open", ...c });
const opts = { includeSlotTime: false };

describe("backfill records", () => {
  it("a regular spot sets lastPerformedWeek and counts toward the cooldown", () => {
    const p = backfillPatch(comic(), { ...base, kind: "regular" });
    expect(p.lastPerformedWeek).toBe("2026-10-12");
    expect(recentSpot({ history: p.history, lastPerformedWeek: p.lastPerformedWeek }, "2026-10-19", 1)).not.toBeNull();
  });
  it("an ad hoc spot is history but never triggers the cooldown", () => {
    const p = backfillPatch(comic(), { ...base, kind: "adhoc" });
    expect(p.history[0]).toMatchObject({ adhoc: true, status: "confirmed" });
    expect(p.lastPerformedWeek).toBeUndefined();
    expect(recentSpot({ history: p.history, lastPerformedWeek: null }, "2026-10-19", 1)).toBeNull();
  });
  it("never moves lastPerformedWeek backwards; switching regular to ad hoc steps it back", () => {
    expect(backfillPatch(comic({ lastPerformedWeek: "2026-10-26" }), { ...base, kind: "regular" }).lastPerformedWeek).toBeUndefined();
    const reg = backfillPatch(comic(), { ...base, kind: "regular" });
    const sw = backfillPatch(comic({ history: reg.history, lastPerformedWeek: reg.lastPerformedWeek }), { ...base, kind: "adhoc" });
    expect(sw.lastPerformedWeek).toBeNull();
    expect(sw.history).toHaveLength(1);
  });
  it("removing a spot drops it from history and falls back to the previous regular week", () => {
    const prev = backfillPatch(comic(), { ...base, date: "2026-10-05", weekOf: "2026-10-05", kind: "regular" });
    const cur = backfillPatch(comic(prev), { ...base, kind: "regular" });
    const gone = backfillPatch(comic({ history: cur.history, lastPerformedWeek: cur.lastPerformedWeek }), { ...base, kind: null });
    expect(gone.history.map((h) => h.date)).toEqual(["2026-10-05"]);
    expect(gone.lastPerformedWeek).toBe("2026-10-05");
  });
});

describe("backfill lineup", () => {
  const lineup = (l: Partial<Lineup>) => ({ id: "x", weekOf: "2026-10-12", showId: "mon", date: "2026-10-12", slots: [], status: "draft", ...l }) as Lineup;
  it("a missing or draft lineup becomes a flagged record; a sent one is left alone", () => {
    expect(backfillBase(undefined)).toMatchObject({ backfilled: true, status: "confirmed", outcome: "happened" });
    expect(backfillBase(lineup({ status: "draft" })).backfilled).toBe(true);
    expect(backfillBase(lineup({ status: "confirmed" }))).toEqual({});
    expect(isBackfilled(lineup({ backfilled: true }))).toBe(true);
  });
  it("slots carry backfill and the kind, which can be switched", () => {
    const s = backfillAddSlot([], "a", "adhoc", opts);
    expect(s[0]).toMatchObject({ comicId: "a", backfill: true, adhoc: true });
    expect(kindOfSlot(s[0])).toBe("adhoc");
    expect(kindOfSlot(backfillAddSlot(s, "a", "regular", opts)[0])).toBe("regular");
  });
  it("a sent lineup records the change as told", () => {
    const cur = lineup({ status: "confirmed", slots: [{ comicId: "b" }], sent: { b: { at: 1, minutes: null, order: 0 } } });
    const after = backfillAddSlot(cur.slots, "a", "regular", opts);
    expect(Object.keys(toldAfterBackfill(cur, after, opts, "a", 5)!)).toEqual(["b", "a"]);
    expect(toldAfterBackfill(lineup({ backfilled: true, status: "confirmed" }), after, opts, "a", 5)).toBeUndefined();
  });
  it("settles an open request only", () => {
    expect(requestAfterBackfill({ status: "assigned" })).toBe("confirmed");
    expect(requestAfterBackfill({ status: "rejected" })).toBeNull();
    expect(isPastShow("2026-10-12", "2026-10-13")).toBe(true);
  });
});
