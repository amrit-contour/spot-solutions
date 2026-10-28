import { describe, expect, it } from "vitest";
import { GROUP_CACHE_STALE_MS, checkShows, groupVerdict, membershipDecision, targetShows } from "./membership.ts";
import { holdFor } from "./rules.ts";
import type { Comic, Lineup, RuleSettings, Show } from "./types.ts";

const NOW = Date.parse("2026-10-28T10:00:00Z");
const week = "2026-10-26";
const comic: Comic = { id: "91@c.us", name: "Rohan", phone: "91", tier: "open", lastPerformedWeek: null, regularOf: [] };
const mem = (id: string, at = NOW - 1000, groupId = "g1") => ({ groupId, at, members: [{ id, name: "x", isAdmin: false }] });
const show = (o: Partial<Show> = {}) => ({ id: "s1", name: "Monday Mic", weekday: 1, active: true, groupId: "g1", regulars: [], groupMembers: mem("91@c.us"), ...o }) as unknown as Show;
const lineup = (ids: string[], status: Lineup["status"] = "draft") => ({ showId: "s1", status, slots: ids.map((comicId) => ({ comicId })) });
const run = (s: Show, l: ReturnType<typeof lineup>[], c: Comic = comic) => membershipDecision(checkShows({ comic: c, shows: [s], lineups: l, week, now: NOW }));

describe("membershipDecision", () => {
  it("1. on the lineup and in the group: confirmed", () => {
    const d = run(show(), [lineup(["91@c.us"])]);
    expect(d.kind).toBe("confirmed");
    if (d.kind === "confirmed") expect(d.check).toMatchObject({ showName: "Monday Mic", day: "Monday" });
  });
  it("1. a show with no group counts the lineup alone", () => {
    expect(run(show({ groupId: null, groupMembers: null }), [lineup(["91@c.us"])]).kind).toBe("confirmed");
  });
  it("matches through the phone id and aliases", () => {
    const c = { ...comic, id: "55@lid", chatId: "55@lid" };
    expect(run(show(), [lineup(["91@c.us"])], c).kind).toBe("confirmed");
  });
  it("2. in the group, not on the lineup: hold, with the reason", () => {
    const d = run(show(), [lineup(["other@c.us"])]);
    expect(d).toMatchObject({ kind: "hold_in_group", reason: "In the group, not on the lineup" });
  });
  it("2. a cancelled lineup is not 'on the lineup'", () => {
    expect(run(show(), [lineup(["91@c.us"], "cancelled")]).kind).toBe("hold_in_group");
  });
  it("3. on the lineup, not in the group: hold, with the reason", () => {
    const d = run(show({ groupMembers: mem("zzz@c.us") }), [lineup(["91@c.us"])]);
    expect(d).toMatchObject({ kind: "hold_on_lineup", reason: "On the lineup, not in the group" });
  });
  it("4. neither: the normal flows", () => {
    expect(run(show({ groupMembers: mem("zzz@c.us") }), [lineup([])])).toEqual({ kind: "normal", regular: false });
  });
  it("4. a regular who is neither on the lineup nor in the group is held like case 2", () => {
    const s = show({ groupMembers: mem("zzz@c.us"), regulars: ["91@c.us"] });
    const d = run(s, [lineup([])]);
    expect(d.kind).toBe("hold_in_group");
    if (d.kind === "hold_in_group") expect(d.reason).toMatch(/Regular of Monday Mic/);
  });
  it("a regular tier comic is a regular of the shows in regularOf", () => {
    const c: Comic = { ...comic, tier: "regular", regularOf: ["s1"] };
    expect(run(show({ groupMembers: mem("zzz@c.us") }), [lineup([])], c).kind).toBe("hold_in_group");
  });
  it("on one show's lineup and in its group beats a mismatch elsewhere", () => {
    const a = show();
    const b = show({ id: "s2", name: "Tue", weekday: 2, groupMembers: mem("zzz@c.us") });
    const checks = checkShows({ comic, shows: [a, b], lineups: [lineup(["91@c.us"])], week, now: NOW });
    expect(membershipDecision(checks).kind).toBe("confirmed");
  });
});

describe("unknown membership falls back to holding, saying so", () => {
  it("no cache", () => {
    const d = run(show({ groupMembers: null }), [lineup(["91@c.us"])]);
    expect(d).toMatchObject({ kind: "hold_unknown" });
    if (d.kind === "hold_unknown") expect(d.reason).toMatch(/not loaded/);
  });
  it("cache for another group is missing", () => {
    expect(run(show({ groupMembers: mem("91@c.us", NOW, "other") }), [lineup([])]).kind).toBe("hold_unknown");
  });
  it("stale cache, even when not on the lineup", () => {
    const d = run(show({ groupMembers: mem("91@c.us", NOW - GROUP_CACHE_STALE_MS - 1) }), [lineup([])]);
    expect(d.kind).toBe("hold_unknown");
    if (d.kind === "hold_unknown") expect(d.reason).toMatch(/out of date/);
  });
  it("groupVerdict reports why", () => {
    expect(groupVerdict(comic, show({ groupMembers: undefined }), NOW)).toEqual({ inGroup: null, why: "missing" });
  });
});

describe("targetShows", () => {
  const mon = show();
  const tue = show({ id: "s2", name: "Tuesday Laughs", weekday: 2 });
  it("uses the named show, else preferred days, else every active show", () => {
    expect(targetShows([mon, tue], { preferredShowHint: "tuesday" }).map((s) => s.id)).toEqual(["s2"]);
    expect(targetShows([mon, tue], { preferredDays: [1] }).map((s) => s.id)).toEqual(["s1"]);
    expect(targetShows([mon, tue], { preferredDays: [] }).map((s) => s.id)).toEqual(["s1", "s2"]);
  });
});

describe("regular exemption from the performed-recently hold", () => {
  const rules = { window: { enabled: false }, skipLastWeek: true, cooldownWeeks: 1 } as unknown as RuleSettings;
  const recent: Comic = { ...comic, lastPerformedWeek: "2026-10-19" };
  const opts = { week, at: new Date(NOW), rules, timeZone: "UTC" };
  it("holds a recent performer, but not a regular of the show", () => {
    expect(holdFor({ ...opts, comic: recent })).toBe("last_week");
    expect(holdFor({ ...opts, comic: recent, regular: true })).toBeNull();
  });
  it("a regular still honours banned", () => {
    expect(holdFor({ ...opts, comic: { ...recent, list: "banned" }, regular: true })).toBe("banned");
  });
});

import { GROUP_REFRESH_MS, groupRefreshDue, holdReasonFor, jitterOf, minutesToShowStart } from "./membership.ts";
import { scanHold } from "./scanHistory.ts";

describe("groupRefreshDue", () => {
  const h = 3600_000;
  const c = (ageMs: number, groupId = "g1") => ({ groupId, at: NOW - ageMs });
  const due = (cache: ReturnType<typeof c> | null, extra: { jitter?: number; minutesToStart?: number | null } = {}) => groupRefreshDue({ cache, groupId: "g1", now: NOW, ...extra });
  it("no cache, or another group's: due", () => {
    expect(due(null)).toBe(true);
    expect(due(c(1000, "other"))).toBe(true);
  });
  it("fresh: not due; past 12h: due", () => {
    expect(due(c(11 * h))).toBe(false);
    expect(due(c(GROUP_REFRESH_MS))).toBe(true);
  });
  it("jitter delays the refresh by up to 25%", () => {
    expect(due(c(13 * h), { jitter: 1 })).toBe(false);
    expect(due(c(15 * h + 1), { jitter: 1 })).toBe(true);
    expect(due(c(13 * h), { jitter: 0 })).toBe(true);
  });
  it("show day: within 3h of the start, a list from before that point is due; a newer one is not", () => {
    expect(due(c(1 * h), { minutesToStart: 170 })).toBe(true);
    expect(due(c(5 * 60_000), { minutesToStart: 170 })).toBe(false);
    expect(due(c(1 * h), { minutesToStart: 200 })).toBe(false);
    expect(due(c(1 * h), { minutesToStart: null })).toBe(false);
  });
  it("show day stops mattering long after the start", () => {
    expect(due(c(5 * h), { minutesToStart: -120 })).toBe(false);
  });
  it("minutesToShowStart and jitterOf", () => {
    expect(minutesToShowStart({ weekday: 1, startTime: "20:00" }, 1, "17:30")).toBe(150);
    expect(minutesToShowStart({ weekday: 1, startTime: "20:00" }, 2, "17:30")).toBeNull();
    expect(jitterOf("g1")).toBeGreaterThanOrEqual(0);
    expect(jitterOf("g1")).toBeLessThan(1);
  });
});

describe("scanHold uses the membership decision", () => {
  const rules = { window: { enabled: false }, skipLastWeek: true, cooldownWeeks: 1 } as unknown as RuleSettings;
  const base = { week, burst: [{ at: NOW }], rules, timeZone: "UTC", comic: { ...comic, lastPerformedWeek: "2026-10-19" } };
  it("lineup/group mismatches hold with their reasons", () => {
    expect(scanHold({ ...base, membership: run(show(), [lineup([])]) })).toBe("in_group_not_lineup");
    expect(scanHold({ ...base, membership: run(show({ groupMembers: mem("z@c.us") }), [lineup(["91@c.us"])]) })).toBe("lineup_not_group");
    expect(scanHold({ ...base, membership: run(show({ groupMembers: null }), [lineup([])]) })).toBe("membership_unknown");
  });
  it("normal falls through to the usual holds", () => {
    expect(scanHold({ ...base, membership: { kind: "normal", regular: false } })).toBe("last_week");
    expect(scanHold({ ...base, membership: { kind: "normal", regular: true } })).toBeNull();
    expect(holdReasonFor(null)).toBeNull();
  });
});
