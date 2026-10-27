import { describe, expect, it } from "vitest";
import { ACTIVITY_CAP, appendActivity, lineupActivity, showState, type ActivityEntry } from "./lineupActivity.ts";
import type { Lineup, Show } from "./types.ts";

const show = { id: "s1", groupId: "g@g.us", weekday: 1, groupPosts: [{ id: "p1", template: "groupLineup", daysBefore: 0, time: "15:00", enabled: true }, { id: "p2", template: "groupReminder", daysBefore: 1, time: "18:00", enabled: true }], groupPostsSent: {} } as unknown as Show;
const base = { id: "2026-10-26_s1", weekOf: "2026-10-26", showId: "s1", date: "2026-10-26", slots: [], status: "confirmed" } as Lineup;
const name = (id: string) => id;

describe("appendActivity", () => {
  it("keeps the newest entries up to the cap", () => {
    let l: ActivityEntry[] = [];
    for (let i = 0; i < ACTIVITY_CAP + 5; i++) l = appendActivity(l, { at: i, kind: "post", tone: "done", text: `e${i}` });
    expect(l).toHaveLength(ACTIVITY_CAP);
    expect(l[0].text).toBe("e5");
    expect(l.at(-1)?.text).toBe(`e${ACTIVITY_CAP + 4}`);
  });
});

describe("showState", () => {
  it("is upcoming, today, then done", () => {
    expect(showState(base, "2026-10-28", "2026-10-26").kind).toBe("upcoming");
    expect(showState(base, "2026-10-26", "2026-10-26")).toMatchObject({ kind: "today", over: false });
    expect(showState(base, "2026-10-25", "2026-10-26")).toMatchObject({ kind: "done", over: true });
  });
  it("an answer of 'happened' makes it done even today", () => {
    expect(showState({ ...base, outcome: "happened" }, "2026-10-26", "2026-10-26")).toMatchObject({ kind: "done", over: true });
  });
  it("canned, recorded and called off", () => {
    expect(showState({ ...base, status: "canned" }, "2026-10-28", "2026-10-26").label).toBe("Didn't happen");
    expect(showState({ ...base, backfilled: true }, "2026-10-20", "2026-10-26").label).toBe("Recorded");
    expect(showState({ ...base, status: "cancelled" }, "2026-10-28", "2026-10-26")).toMatchObject({ label: "Called off", over: false });
    expect(showState({ ...base, status: "cancelled" }, "2026-10-20", "2026-10-26").over).toBe(true);
  });
  it("a past show that never went out is a past show", () => {
    expect(showState({ ...base, status: "draft" }, "2026-10-20", "2026-10-26")).toMatchObject({ kind: "past", over: true });
    expect(showState(null, "2026-10-20", "2026-10-26").kind).toBe("past");
  });
});

describe("lineupActivity", () => {
  const now = { date: "2026-10-26", time: "12:00" };
  it("lists scheduled posts that are still to come, after what happened", () => {
    const rows = lineupActivity({ lineup: { ...base, sentAt: 1000, sent: { a: { at: 1000, minutes: null, order: 0 } } }, show, now, nameOf: name });
    expect(rows.map((r) => r.key)).toEqual(["confirm", "post-p1"]);
    expect(rows[1]).toMatchObject({ tone: "scheduled" });
    expect(rows[1].when).toMatch(/^Today/);
  });
  it("shows a past scheduled post as posted when nothing recorded it, and not twice when something did", () => {
    const sent = { ...show, groupPostsSent: { p1: "2026-10-26" } } as unknown as Show;
    expect(lineupActivity({ lineup: base, show: sent, now, nameOf: name }).filter((r) => r.icon === "post")).toHaveLength(1);
    const withEntry = { ...base, activity: [{ at: 5, kind: "post", tone: "done", text: "Posted the lineup post in the group", ref: "p1" }] } as Lineup;
    expect(lineupActivity({ lineup: withEntry, show: sent, now, nameOf: name }).filter((r) => r.icon === "post")).toHaveLength(1);
  });
  it("a partial cleanup lists who is left and offers a retry", () => {
    const lineup = { ...base, cleanup: { status: "partial", at: 10, removed: 4, failed: 1, pending: [{ id: "1@c.us", name: "Sam", reason: "still in after removal" }], retryAt: null } } as Lineup;
    const row = lineupActivity({ lineup, show, now: { date: "2026-10-28", time: "12:00" }, nameOf: name }).find((r) => r.icon === "cleanup");
    expect(row).toMatchObject({ tone: "failed", action: "retry_cleanup" });
    expect(row?.detail?.[0]).toBe("Sam: still in after removal");
  });
  it("offers and drop-outs, and nothing scheduled for a called-off show", () => {
    const lineup = { ...base, status: "cancelled", dropped: [{ comicId: "x", at: 7 }] } as Lineup;
    const offers = [{ id: "o1", lineupId: base.id, comicName: "Ana", status: "pending", sentAt: 3 }] as never;
    const rows = lineupActivity({ lineup, show, offers, now, nameOf: name });
    expect(rows.map((r) => r.key)).toEqual(["offer-o1", "drop-x"]);
    expect(rows[0].tone).toBe("scheduled");
  });
  it("a backfilled show has no confirmations or scheduled posts", () => {
    expect(lineupActivity({ lineup: { ...base, backfilled: true, sentAt: 1 }, show, now, nameOf: name })).toEqual([]);
  });
});
