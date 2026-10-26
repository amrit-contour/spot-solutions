import { describe, expect, it } from "vitest";
import { DAY_MS, DEMO_SOURCE_UID, closedRequestsWeeks, collectionsForScope, expiredSandboxIds, requestsToExpire, ttlMs, demoSandboxIds, isDataScope, oldRequests, planLineupReset, planWeekReset } from "./cleanup.ts";
import type { Lineup } from "./types.ts";

const lineup = (over: Partial<Lineup> = {}): Lineup => ({ id: "2026-10-26_a", weekOf: "2026-10-26", showId: "a", date: "2026-10-27", slots: [{ comicId: "c1" }, { comicId: "c2" }], status: "draft", ...over });
const req = (comicId: string, status: string, over: object = {}) => ({ id: `2026-10-26_${comicId}`, comicId, weekOf: "2026-10-26", status: status as never, ...over });

describe("planLineupReset", () => {
  it("clears slots and puts assigned requests back to waiting", () => {
    const p = planLineupReset(lineup(), [req("c1", "assigned"), req("c2", "assigned", { ackedAt: 5 }), req("c3", "assigned")])!;
    expect(p.lineupPatch).toEqual({ slots: [] });
    expect(p.confirmed).toBe(false);
    expect(p.cleared).toBe(2);
    expect(p.requestResets).toEqual([
      { id: "2026-10-26_c1", status: "new" },
      { id: "2026-10-26_c2", status: "acked" },
    ]);
  });

  it("leaves confirmed requests alone on an unconfirmed lineup, and other weeks", () => {
    const p = planLineupReset(lineup(), [req("c1", "confirmed"), req("c2", "assigned", { weekOf: "2026-10-19" })])!;
    expect(p.requestResets).toEqual([]);
  });

  it("flags confirmed lineups, reopens them and resets confirmed requests", () => {
    const p = planLineupReset(lineup({ status: "confirmed", sentAt: 9 }), [req("c1", "confirmed"), req("c2", "rejected")])!;
    expect(p.confirmed).toBe(true);
    expect(p.lineupPatch).toMatchObject({ slots: [], status: "draft", sentAt: null, groupSync: null, showDaySyncedOn: null, micCheckSentOn: null, outcome: null });
    expect(p.requestResets).toEqual([{ id: "2026-10-26_c1", status: "new" }]);
  });

  it("undoes the performed mark and confirmed history of a confirmed lineup", () => {
    const entry = (status: string, date = "2026-10-27", showId = "a") => ({ date, showId, showName: "A", status: status as never });
    const comics = [
      { id: "c1", lastPerformedWeek: "2026-10-26", history: [entry("confirmed"), entry("confirmed", "2026-10-20")] },
      { id: "c2", lastPerformedWeek: "2026-10-19", history: [entry("canned")] },
      { id: "c9", lastPerformedWeek: "2026-10-26", history: [entry("confirmed")] },
    ];
    const p = planLineupReset(lineup({ status: "confirmed" }), [], comics)!;
    expect(p.comicPatches).toEqual([{ id: "c1", patch: { lastPerformedWeek: null, history: [entry("confirmed", "2026-10-20")] } }]);
    // A draft was never confirmed: nothing to undo.
    expect(planLineupReset(lineup(), [], comics)!.comicPatches).toEqual([]);
  });

  it("keeps a cancelled lineup cancelled and skips empty lineups", () => {
    expect(planLineupReset(lineup({ status: "cancelled" }), [])!.lineupPatch).toEqual({ slots: [] });
    expect(planLineupReset(lineup({ slots: [] }), [])).toBeNull();
  });
});

describe("planWeekReset", () => {
  const shows = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, active: id !== "f" }));

  it("plans every lineup that has comics", () => {
    const plans = planWeekReset([lineup(), lineup({ id: "2026-10-26_b", showId: "b", slots: [] }), lineup({ id: "2026-10-26_c", showId: "c", status: "confirmed" })], [], shows);
    expect(plans.map((p) => p.showId)).toEqual(["a", "c"]);
    expect(plans.filter((p) => p.confirmed)).toHaveLength(1);
  });

  it("skips cancelled and canned lineups and lineups of inactive or unknown shows", () => {
    const plans = planWeekReset(
      [lineup(), lineup({ id: "x_d", showId: "d", status: "cancelled" }), lineup({ id: "x_e", showId: "e", status: "canned" }), lineup({ id: "x_f", showId: "f" }), lineup({ id: "x_g", showId: "g" })],
      [],
      shows,
    );
    expect(plans.map((p) => p.showId)).toEqual(["a"]);
  });
});

describe("oldRequests", () => {
  it("keeps the cutoff week and later", () => {
    const rs = [{ weekOf: "2026-10-12" }, { weekOf: "2026-10-19" }, { weekOf: "2026-10-26" }];
    expect(oldRequests(rs, "2026-10-26")).toEqual([{ weekOf: "2026-10-12" }, { weekOf: "2026-10-19" }]);
    expect(oldRequests(rs, "2026-10-12")).toEqual([]);
  });
});

describe("data scopes", () => {
  it("maps scopes to collections", () => {
    expect(collectionsForScope("requests")).toEqual(["requests"]);
    expect(collectionsForScope("history")).toEqual(["actions", "notices", "offers", "polls"]);
    expect(collectionsForScope("everything")).toEqual(expect.arrayContaining(["venues", "shows", "comics", "requests", "lineups", "secrets"]));
  });

  it("only accepts known scopes", () => {
    expect(isDataScope("comics")).toBe(true);
    expect(isDataScope("everything")).toBe(true);
    expect(isDataScope("toString")).toBe(false);
    expect(isDataScope("users")).toBe(false);
  });
});

describe("demoSandboxIds", () => {
  it("takes only demo-flagged users and never the source copy", () => {
    const users = [{ id: "anon1", demo: true }, { id: DEMO_SOURCE_UID, demo: true }, { id: "real" }, { id: "x", demo: "true" }, { id: "anon2", demo: true, email: null }];
    expect(demoSandboxIds(users)).toEqual(["anon1", "anon2"]);
  });

  it("skips a flagged user that has an email", () => {
    expect(demoSandboxIds([{ id: "u", demo: true, email: "a@b.co" }])).toEqual([]);
  });
});

describe("requestsToExpire", () => {
  const r = (weekOf: string, status: string) => ({ weekOf, status: status as never });
  const all = ["new", "acked", "assigned", "confirmed", "rejected", "dismissed"].map((st) => r("2026-08-03", st));

  it("picks dismissed, rejected and confirmed requests older than the cutoff, never open or placed ones", () => {
    expect(requestsToExpire(all, "2026-10-26", 8).map((x) => x.status)).toEqual(["confirmed", "rejected", "dismissed"]);
  });
  it("keeps requests inside the window, including the exact cutoff week", () => {
    // 8 weeks before 2026-10-26 is 2026-08-31
    expect(requestsToExpire([r("2026-08-31", "dismissed"), r("2026-08-24", "dismissed")], "2026-10-26", 8)).toEqual([r("2026-08-24", "dismissed")]);
  });
  it("0 weeks keeps everything", () => {
    expect(requestsToExpire(all, "2026-10-26", 0)).toEqual([]);
  });
});

describe("closedRequestsWeeks", () => {
  it("defaults to 8 and accepts 0 as keep-forever", () => {
    expect(closedRequestsWeeks(undefined)).toBe(8);
    expect(closedRequestsWeeks({})).toBe(8);
    expect(closedRequestsWeeks({ retention: { closedRequestsWeeks: 0 } })).toBe(0);
    expect(closedRequestsWeeks({ retention: { closedRequestsWeeks: 12 } })).toBe(12);
    expect(closedRequestsWeeks({ retention: { closedRequestsWeeks: -1 } })).toBe(8);
    expect(closedRequestsWeeks({ retention: { closedRequestsWeeks: "3" } })).toBe(8);
  });
});

describe("expiredSandboxIds", () => {
  const now = Date.UTC(2026, 9, 26);
  it("selects sandboxes older than 7 days by demoClonedAt, else createdAt, and spares the template, real accounts and undated ones", () => {
    const users = [
      { id: "old", demo: true, demoClonedAt: now - 8 * DAY_MS },
      { id: "fresh", demo: true, demoClonedAt: now - 6 * DAY_MS },
      { id: "created", demo: true, createdAt: now - 9 * DAY_MS },
      { id: "reclone", demo: true, demoClonedAt: now - DAY_MS, createdAt: now - 30 * DAY_MS },
      { id: "demo-curator", demo: true, demoClonedAt: now - 99 * DAY_MS },
      { id: "real", demo: true, email: "a@b.c", demoClonedAt: now - 99 * DAY_MS },
      { id: "undated", demo: true },
      { id: "plain", demoClonedAt: now - 99 * DAY_MS },
    ];
    expect(expiredSandboxIds(users, now)).toEqual(["old", "created"]);
  });
  it("ttlMs adds whole days", () => {
    expect(ttlMs(7, 1000)).toBe(1000 + 7 * DAY_MS);
  });
});
