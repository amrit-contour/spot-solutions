import { describe, expect, it } from "vitest";
import {
  RATING_ASK_GAP_MS, RATING_POLL_TTL_MS, addRatingPolls, applySlotReviews, inQuiet, isCatchUp, overallPollSpec, rateAfterMinutes, ratingDue, ratingDueAt, ratingAskGate, ratingHeader, ratingPollRef, ratingPollSpec, slotsToRate, voteOverall, voteReview,
  type Comic, type Slot,
} from "./index.ts";

const comic = (id: string, name: string, extra: Partial<Comic> = {}) => ({ id, name, phone: id.split("@")[0], ...extra }) as Comic;

describe("when the polls are due", () => {
  it("start + afterHours + rateAfterMin, 5 minutes after the mic check by default", () => {
    expect(rateAfterMinutes(undefined)).toBe(5);
    expect(rateAfterMinutes({ rateAfterMin: 0 })).toBe(0);
    expect(rateAfterMinutes({ rateAfterMin: 999 })).toBe(5);
    expect(ratingDueAt("2026-10-27", "20:00", 2, 5)).toBe("2026-10-27 22:05");
    expect(ratingDueAt("2026-10-27", "20:00", 2, 0)).toBe("2026-10-27 22:00");
    expect(ratingDueAt("2026-10-27", "19:30", 3, 45)).toBe("2026-10-27 23:15");
  });
  it("rolls past midnight", () => {
    expect(ratingDueAt("2026-10-27", "22:30", 2, 5)).toBe("2026-10-28 00:35");
    expect(ratingDueAt("2026-10-31", "23:00", 1, 90)).toBe("2026-11-01 01:30");
  });
  it("due from that minute on; a yes after the time is simply already due", () => {
    const due = "2026-10-27 22:05";
    expect(ratingDue(due, { date: "2026-10-27", time: "22:04" })).toBe(false);
    expect(ratingDue(due, { date: "2026-10-27", time: "22:05" })).toBe(true);
    expect(ratingDue(due, { date: "2026-10-28", time: "01:00" })).toBe(true);
  });
});

describe("scheduled asks versus catch-ups, quiet hours and no bursts", () => {
  const now = 1e12;
  it("a scheduled ask goes at any hour: the curator chose that time and shows end late", () => {
    for (const t of ["22:35", "23:59", "00:35", "03:47", "09:00"]) expect(ratingAskGate({ time: t, nowMs: now, catchUp: false })).toBe("go");
    expect(ratingAskGate({ time: "00:35", nowMs: now, catchUp: false, lastAskAt: now - 1000 })).toBe("go");
  });
  it("a catch-up waits out quiet hours (22:30 to 09:30 by default)", () => {
    for (const t of ["22:30", "23:59", "00:00", "03:47", "09:29"]) expect(ratingAskGate({ time: t, nowMs: now, catchUp: true })).toBe("quiet");
    for (const t of ["09:30", "10:00", "22:29"]) expect(ratingAskGate({ time: t, nowMs: now, catchUp: true })).toBe("go");
    expect(inQuiet("23:00", { from: "23:30", to: "07:00" })).toBe(false);
    expect(ratingAskGate({ time: "08:00", nowMs: now, catchUp: true, quiet: { from: "23:30", to: "07:00" } })).toBe("go");
  });
  it("catch-ups are spaced one show at a time", () => {
    expect(ratingAskGate({ time: "10:00", nowMs: now, catchUp: true, lastAskAt: now - 2 * 60_000 })).toBe("spaced");
    expect(ratingAskGate({ time: "10:00", nowMs: now, catchUp: true, lastAskAt: now - RATING_ASK_GAP_MS })).toBe("go");
    expect(ratingAskGate({ time: "03:47", nowMs: now, catchUp: true, lastAskAt: now - 1e9 })).toBe("quiet");
  });
  it("more than 12 hours past due is a catch-up", () => {
    expect(isCatchUp("2026-10-27 22:05", { date: "2026-10-28", time: "10:05" })).toBe(false);
    expect(isCatchUp("2026-10-27 22:05", { date: "2026-10-28", time: "10:06" })).toBe(true);
    expect(isCatchUp("2026-10-27 22:05", { date: "2026-10-27", time: "22:10" })).toBe(false);
  });
});

describe("the polls", () => {
  it("one per comic, named for them, options in order", () => {
    const p = ratingPollSpec("Mohit Comic BLR");
    expect(p.question).toBe("Mohit Comic BLR, how did they do?");
    expect(p.options).toEqual(["5 Killed it", "4 Good", "3 OK", "2 Rough", "1 Bombed", "Late", "No-show"]);
    expect(overallPollSpec("Open Mic - Tuesday").options).toContain("Skip");
    expect(ratingPollSpec("x".repeat(400)).question.length).toBeLessThanOrEqual(255);
  });
  it("the whole ticked set is read: rating, Late, No-show, nothing", () => {
    expect(voteReview(["4 Good"])).toEqual({ review: { rating: 4, attendance: null }, multiple: false });
    expect(voteReview(["3 OK", "Late"])).toEqual({ review: { rating: 3, attendance: "late" }, multiple: false });
    expect(voteReview(["Late"])).toEqual({ review: { rating: null, attendance: "late" }, multiple: false });
    expect(voteReview(["4 Good", "No-show"])).toEqual({ review: { attendance: "no_show", rating: null }, multiple: false });
    expect(voteReview(["2 Rough", "5 Killed it"])).toEqual({ review: { rating: 5, attendance: null }, multiple: true });
    expect(voteReview([])).toEqual({ review: { rating: null, attendance: null }, multiple: false });
    expect(voteOverall(["5 Great"])).toEqual({ rating: 5 });
    expect(voteOverall(["Skip"])).toEqual({ skip: true });
    expect(voteOverall([])).toBeNull();
  });
  it("a changed vote replaces the old one on the slot", () => {
    let slots: Slot[] = [{ comicId: "a@c.us" }, { comicId: "b@c.us" }];
    const vote = (sel: string[]) => (slots = applySlotReviews(slots, { "a@c.us": voteReview(sel).review }));
    vote(["No-show"]);
    expect(slots[0]).toMatchObject({ attendance: "no_show" });
    vote(["3 OK"]);
    expect(slots[0]!.rating).toBe(3);
    expect(slots[0]!.attendance).toBeUndefined();
    vote(["Late"]);
    expect(slots[0]).toMatchObject({ attendance: "late" });
    expect(slots[0]!.rating).toBeUndefined();
    vote(["5 Killed it", "Late"]);
    expect(slots[0]).toMatchObject({ rating: 5, attendance: "late" });
    vote([]);
    expect(slots[0]).toEqual({ comicId: "a@c.us" });
    expect(slots[1]).toEqual({ comicId: "b@c.us" });
  });
});

describe("who is asked about", () => {
  const comics = new Map([["me@c.us", comic("me@c.us", "Amrit Dash (you)")], ["a@c.us", comic("a@c.us", "Asha")], ["b@c.us", comic("b@c.us", "Bo")]]);
  it("includes the curator (a comic too); skips rated comics and no-shows", () => {
    const l = { slots: [{ comicId: "me@c.us" }, { comicId: "a@c.us", rating: 4 }, { comicId: "b@c.us" }, { comicId: "x@c.us", attendance: "no_show" as const }] };
    expect(slotsToRate(l, comics).map((r) => [r.n, r.name])).toEqual([[1, "Amrit Dash (you)"], [3, "Bo"]]);
  });
  it("keeps the list numbers of the lineup so typed answers still line up", () => {
    const l = { slots: [{ comicId: "a@c.us", rating: 3 }, { comicId: "me@c.us" }, { comicId: "b@c.us" }] };
    expect(slotsToRate(l, comics).map((r) => r.n)).toEqual([2, 3]);
    const h = ratingHeader({ showName: "Open Mic - Tuesday", dateLabel: "27 Oct", rows: [{ n: 1, label: "@91" }, { n: 3, label: "Bo" }] });
    expect(h).toContain("🎤 How did everyone do at *Open Mic - Tuesday* (27 Oct)? Tap a poll for each:");
    expect(h).toContain("1. @91");
    expect(h).toContain("3. Bo");
  });
});

describe("remembering which poll is which", () => {
  const ref = (id: string, at: number, comicId: string | null = "a@c.us") => ({ id, lineupId: "l1", comicId, at });
  it("finds a poll for about 3 days, then forgets it", () => {
    const list = addRatingPolls([], [ref("p1", 1000), ref("p2", 1000, null)], 1000);
    expect(ratingPollRef(list, "p1", 1000 + RATING_POLL_TTL_MS - 1)?.comicId).toBe("a@c.us");
    expect(ratingPollRef(list, "p2", 2000)?.comicId).toBeNull();
    expect(ratingPollRef(list, "p1", 1000 + RATING_POLL_TTL_MS)).toBeNull();
    expect(ratingPollRef(list, "nope", 2000)).toBeNull();
  });
  it("adding drops the expired and replaces a repeated id", () => {
    const old = addRatingPolls([], [ref("old", 0)], 0);
    const first = addRatingPolls(old, [ref("p1", RATING_POLL_TTL_MS + 5)], RATING_POLL_TTL_MS + 5);
    const list = addRatingPolls(first, [ref("p1", RATING_POLL_TTL_MS + 6)], RATING_POLL_TTL_MS + 10);
    expect(list.map((r) => r.id)).toEqual(["p1"]);
    expect(list[0]!.at).toBe(RATING_POLL_TTL_MS + 6);
  });
});
