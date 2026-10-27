import { describe, expect, it } from "vitest";
import { cleanCriteria, criteriaSummary, evaluatePost, minutesOverdue, postStatusToShow, waitMinutes, TEMPLATE_CRITERIA, type CriteriaFacts, type PostCriteria } from "./groupPostCriteria.ts";
import { GROUP_POST_KEYS, groupPostMessage, groupPostVars, newGroupPost, renderGroupPost } from "./groupPosts.ts";
import { lineupActivity } from "./lineupActivity.ts";
import type { Lineup, Show } from "./types.ts";

const slot = (comicId: string) => ({ comicId });
const lineup = (p: Partial<Lineup> = {}): NonNullable<CriteriaFacts["lineup"]> => ({ status: "confirmed", outcome: null, slots: [slot("a"), slot("b"), slot("c")], ...p });
const facts = (p: Partial<CriteriaFacts> = {}): CriteriaFacts => ({ lineup: lineup(), slotCount: 5, micCheckOn: true, overdueMin: 0, ...p });
const post = (criteria?: PostCriteria, p: { daysBefore?: number; time?: string } = {}) => ({ daysBefore: -1, time: "10:00", criteria, ...p });
const verdict = (c: PostCriteria | undefined, f: Partial<CriteriaFacts> = {}, p = {}) => evaluatePost(post(c, p), facts(f));

describe("evaluatePost: no criteria", () => {
  it("goes for a normal show and when there's no lineup doc", () => {
    expect(verdict(undefined)).toEqual({ go: true });
    expect(verdict(undefined, { lineup: null })).toEqual({ go: true });
  });
  it("keeps the old rule: a show that is off gets nothing", () => {
    expect(verdict(undefined, { lineup: lineup({ status: "cancelled" }) })).toEqual({ go: false, hold: false, reason: "Skipped: show was called off" });
    expect(verdict(undefined, { lineup: lineup({ status: "canned", outcome: "canned" }) })).toEqual({ go: false, hold: false, reason: "Skipped: show didn't happen" });
  });
});

describe("evaluatePost: show status", () => {
  it("happened: goes once the mic check says so, skips when it didn't, holds while unknown", () => {
    expect(verdict({ show: "happened" }, { lineup: lineup({ outcome: "happened" }) })).toEqual({ go: true });
    expect(verdict({ show: "happened" }, { lineup: lineup({ status: "canned", outcome: "canned" }) })).toEqual({ go: false, hold: false, reason: "Skipped: show didn't happen" });
    expect(verdict({ show: "happened" }, { lineup: lineup({ status: "cancelled" }) })).toMatchObject({ go: false, hold: false, reason: "Skipped: show was called off" });
    expect(verdict({ show: "happened" })).toEqual({ go: false, hold: true, reason: `Waiting for "did it happen"` });
  });
  it("holds, then skips once the wait is over", () => {
    const c = { show: "happened" as const, waitHours: 4 };
    expect(verdict(c, { overdueMin: 239 })).toMatchObject({ go: false, hold: true });
    expect(verdict(c, { overdueMin: 240 })).toEqual({ go: false, hold: false, reason: `Skipped: no answer to "did it happen" in 4h` });
  });
  it("waits 6 hours by default, and never past the end of its own day", () => {
    expect(waitMinutes({ time: "10:00" })).toBe(360);
    expect(waitMinutes({ time: "20:00", criteria: undefined })).toBe(210);
    expect(verdict({ show: "happened" }, { overdueMin: 359 })).toMatchObject({ hold: true });
    expect(verdict({ show: "happened" }, { overdueMin: 360 })).toMatchObject({ hold: false });
    expect(verdict({ show: "happened" }, { overdueMin: 210 }, { time: "20:00" })).toMatchObject({ go: false, hold: false });
  });
  it("without mic checks a confirmed show counts as happened for an after-show post, not before", () => {
    expect(verdict({ show: "happened" }, { micCheckOn: false })).toEqual({ go: true });
    expect(verdict({ show: "happened" }, { micCheckOn: false }, { daysBefore: 1 })).toMatchObject({ go: false, hold: true });
  });
  it("didn't happen: goes for a canned show, skips a happened or called-off one, holds while unknown", () => {
    expect(verdict({ show: "didnt_happen" }, { lineup: lineup({ status: "canned", outcome: "canned" }) })).toEqual({ go: true });
    expect(verdict({ show: "didnt_happen" }, { lineup: lineup({ outcome: "happened" }) })).toEqual({ go: false, hold: false, reason: "Skipped: show happened" });
    expect(verdict({ show: "didnt_happen" }, { lineup: lineup({ status: "cancelled" }) })).toMatchObject({ go: false, hold: false });
    expect(verdict({ show: "didnt_happen" })).toEqual({ go: false, hold: true, reason: `Waiting for "did it happen"` });
    expect(verdict({ show: "didnt_happen" }, { overdueMin: 400 })).toMatchObject({ go: false, hold: false });
  });
  it("cancelled: only a show called off in advance", () => {
    expect(verdict({ show: "cancelled" }, { lineup: lineup({ status: "cancelled" }) })).toEqual({ go: true });
    expect(verdict({ show: "cancelled" })).toEqual({ go: false, hold: false, reason: "Skipped: show wasn't called off" });
    expect(verdict({ show: "cancelled" }, { lineup: null })).toMatchObject({ go: false, hold: false });
  });
  it("confirmed: needs a confirmed lineup, waits for one, never for a show that is off", () => {
    expect(verdict({ show: "confirmed" })).toEqual({ go: true });
    expect(verdict({ show: "confirmed" }, { lineup: lineup({ status: "draft" }) })).toEqual({ go: false, hold: true, reason: "Waiting for the lineup to be confirmed" });
    expect(verdict({ show: "confirmed" }, { lineup: lineup({ status: "draft" }), overdueMin: 999 })).toMatchObject({ go: false, hold: false });
    expect(verdict({ show: "confirmed" }, { lineup: lineup({ status: "cancelled" }) })).toMatchObject({ go: false, hold: false });
  });
});

describe("evaluatePost: lineup and repeat", () => {
  it("at least N comics, and a full lineup", () => {
    expect(verdict({ minComics: 3 })).toEqual({ go: true });
    expect(verdict({ minComics: 4 })).toEqual({ go: false, hold: false, reason: "Skipped: only 3 comics (needs 4)" });
    expect(verdict({ full: true })).toEqual({ go: false, hold: false, reason: "Skipped: lineup isn't full" });
    expect(verdict({ full: true }, { slotCount: 3 })).toEqual({ go: true });
  });
  const canned = (repeatNext?: boolean | null) => lineup({ status: "canned", outcome: "canned", repeatNext });
  it("repeats next week: reads the flag on a show that didn't happen", () => {
    expect(verdict({ show: "didnt_happen", repeats: true }, { lineup: canned(true) })).toEqual({ go: true });
    expect(verdict({ show: "didnt_happen", repeats: true }, { lineup: canned(false) })).toEqual({ go: false, hold: false, reason: "Skipped: lineup doesn't repeat next week" });
    expect(verdict({ show: "didnt_happen", repeats: false }, { lineup: canned(true) })).toEqual({ go: false, hold: false, reason: "Skipped: lineup repeats next week" });
    expect(verdict({ show: "didnt_happen", repeats: false }, { lineup: canned(false) })).toEqual({ go: true });
  });
  it("an unanswered repeat question holds, then counts as no", () => {
    expect(verdict({ show: "didnt_happen", repeats: true }, { lineup: canned() })).toEqual({ go: false, hold: true, reason: `Waiting for "repeating next week?"` });
    expect(verdict({ show: "didnt_happen", repeats: true }, { lineup: canned(), overdueMin: 361 })).toEqual({ go: false, hold: false, reason: `Skipped: no answer to "repeating next week?" in 6h` });
    expect(verdict({ show: "didnt_happen", repeats: false }, { lineup: canned(), overdueMin: 361 })).toEqual({ go: true });
  });
  it("a show that happened never repeats, and never waits for the answer", () => {
    expect(verdict({ show: "happened", repeats: false }, { lineup: lineup({ outcome: "happened" }) })).toEqual({ go: true });
    expect(verdict({ repeats: true }, { lineup: lineup({ outcome: "happened" }) })).toMatchObject({ go: false, hold: false });
  });
  it("combines with AND", () => {
    expect(verdict({ show: "happened", minComics: 2, full: true }, { lineup: lineup({ outcome: "happened" }) })).toMatchObject({ go: false, reason: "Skipped: lineup isn't full" });
  });
});

describe("templates carry sensible default criteria", () => {
  const show = { startTime: "20:00" };
  const make = (t: Parameters<typeof newGroupPost>[0]) => newGroupPost(t, show);
  it("each new template comes with its criteria and timing", () => {
    expect(make("groupThanks")).toMatchObject({ daysBefore: -1, criteria: { show: "happened" } });
    expect(make("groupDidntHappen")).toMatchObject({ daysBefore: -1, criteria: { show: "didnt_happen", repeats: false } });
    expect(make("groupCancelled")).toMatchObject({ criteria: { show: "cancelled" } });
    expect(make("groupRepeat")).toMatchObject({ daysBefore: -1, criteria: { show: "didnt_happen", repeats: true } });
    expect(make("groupSignups")).toMatchObject({ criteria: { show: "happened" } });
    expect(make("groupLatecomers")).toMatchObject({ daysBefore: 0, time: "18:00", criteria: { show: "confirmed" } });
  });
  it("the older templates and your own message have none", () => {
    for (const t of ["groupLineup", "groupVenue", "groupReminder", "groupCleanup", "custom"] as const) expect(make(t).criteria).toBeUndefined();
  });
  it("every template with criteria is in the add list, and the default criteria are well-formed", () => {
    for (const [t, c] of Object.entries(TEMPLATE_CRITERIA)) {
      expect(GROUP_POST_KEYS).toContain(t);
      expect(cleanCriteria(c)).toEqual(c);
    }
  });
  it("the repeat note and the sign-ups say next week's date", () => {
    const vars = groupPostVars({ name: "Monday Mic", startTime: "20:00" }, { name: "The Hub", mapsLink: "" }, "2026-10-26");
    const text = (t: Parameters<typeof newGroupPost>[0]) => (renderGroupPost({ messages: {} }, make(t), vars) as { body: string }).body;
    expect(text("groupRepeat")).toContain("2 Nov");
    expect(text("groupRepeat")).toContain("Monday Mic");
    expect(text("groupSignups")).toContain("2 Nov");
    expect(groupPostMessage({ messages: {} }, make("groupDidntHappen")).body).not.toContain("{{nextDate}}");
  });
  it("each template's default flows through the status it is written for", () => {
    const f = (l: CriteriaFacts["lineup"]) => facts({ lineup: l });
    const run = (t: Parameters<typeof newGroupPost>[0], l: CriteriaFacts["lineup"]) => evaluatePost(make(t), f(l));
    const canned = lineup({ status: "canned", outcome: "canned", repeatNext: false });
    expect(run("groupThanks", lineup({ outcome: "happened" })).go).toBe(true);
    expect(run("groupThanks", canned).go).toBe(false);
    expect(run("groupDidntHappen", canned).go).toBe(true);
    expect(run("groupDidntHappen", { ...canned, repeatNext: true }).go).toBe(false);
    expect(run("groupRepeat", { ...canned, repeatNext: true }).go).toBe(true);
    expect(run("groupRepeat", canned).go).toBe(false);
    expect(run("groupCancelled", lineup({ status: "cancelled" })).go).toBe(true);
    expect(run("groupCancelled", lineup()).go).toBe(false);
    expect(run("groupLatecomers", lineup()).go).toBe(true);
  });
});

describe("summary and cleaning", () => {
  it("one line for the post row", () => {
    expect(criteriaSummary(undefined)).toBe("");
    expect(criteriaSummary({})).toBe("");
    expect(criteriaSummary({ show: "happened" })).toBe("only if it happened");
    expect(criteriaSummary({ show: "didnt_happen", repeats: false })).toBe("only if it didn't happen and the lineup doesn't repeat");
    expect(criteriaSummary({ minComics: 1, full: true })).toBe("only if at least 1 comic and the lineup is full");
  });
  it("drops empty values", () => {
    expect(cleanCriteria({ minComics: 0, waitHours: 9 })).toBeNull();
    expect(cleanCriteria({ show: "happened", waitHours: 6 })).toEqual({ show: "happened" });
    expect(cleanCriteria({ show: "happened", waitHours: 99 })).toEqual({ show: "happened", waitHours: 20 });
  });
  it("counts minutes past the send time", () => {
    expect(minutesOverdue({ time: "10:00" }, { time: "10:45" })).toBe(45);
    expect(minutesOverdue({ time: "10:00" }, { time: "09:00" })).toBe(0);
  });
});

describe("skip reasons are recorded and shown", () => {
  const show = { id: "s1", weekday: 1, groupId: "g", groupPosts: [{ id: "p1", template: "groupThanks", daysBefore: -1, time: "10:00", enabled: true, criteria: { show: "happened" } }], groupPostsSent: { p1: "2026-10-26" } } as unknown as Show;
  const now = { date: "2026-10-27", time: "12:00" };
  const nameOf = () => "x";
  it("a skipped run reads as 'wasn't posted' with its reason, not as posted", () => {
    const l = { id: "x", date: "2026-10-26", status: "canned", slots: [], activity: [{ at: 1, kind: "post", tone: "info", text: "The thank-you wasn't posted", detail: ["Skipped: show didn't happen"], ref: "p1" }] } as unknown as Lineup;
    const rows = lineupActivity({ lineup: l, show, now, nameOf });
    expect(rows.map((r) => r.text)).toEqual(["The thank-you wasn't posted"]);
    expect(rows[0].detail).toEqual(["Skipped: show didn't happen"]);
  });
  it("a held post shows what it is waiting for", () => {
    const l = { id: "x", date: "2026-10-26", status: "confirmed", slots: [] } as unknown as Lineup;
    const held = { ...show, groupPostsSent: {}, groupPostStatus: { p1: { showDate: "2026-10-26", state: "waiting", text: `Waiting for "did it happen"`, at: 1 } } } as unknown as Show;
    expect(lineupActivity({ lineup: l, show: held, now, nameOf }).map((r) => r.text)).toEqual([`The thank-you: Waiting for "did it happen"`]);
  });
  it("posts written for an off show still show as coming; others don't", () => {
    const l = { id: "x", date: "2026-10-26", status: "cancelled", slots: [] } as unknown as Lineup;
    const s = { ...show, groupPostsSent: {}, groupPosts: [{ ...show.groupPosts![0], daysBefore: 1, criteria: { show: "cancelled" } }, { id: "p2", template: "groupVenue", daysBefore: 1, time: "10:00", enabled: true }] } as unknown as Show;
    const rows = lineupActivity({ lineup: l, show: s, now: { date: "2026-10-24", time: "09:00" }, nameOf });
    expect(rows.map((r) => r.text)).toEqual(["The thank-you goes out, only if it was called off"]);
  });
  it("the status chip hides once a later show date has gone out", () => {
    const st = { showDate: "2026-10-26", state: "skipped" as const, text: "Skipped: show didn't happen", at: 1 };
    expect(postStatusToShow(st, "2026-10-26")).toBe(st);
    expect(postStatusToShow(st, "2026-11-02")).toBeNull();
    expect(postStatusToShow({ ...st, state: "sent" }, "2026-10-26")).toBeNull();
  });
});
