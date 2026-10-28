import { describe, expect, it } from "vitest";
import {
  WHY_PRESETS, cleanReasonOptions, composeNoNotes, parseNoNote, repeatSlots, voteRepeat,
  RATING_ASK_GAP_MS, RATING_POLL_TTL_MS, addRatingPolls, applySlotReviews, inQuiet, isCatchUp, overallPollSpec,  ratingAskGate, ratingHeader, ratingPollRef, ratingPollSpec, slotsToRate, voteOverall, voteReview,
  type Comic, type Slot,
} from "./index.ts";

const comic = (id: string, name: string, extra: Partial<Comic> = {}) => ({ id, name, phone: id.split("@")[0], ...extra }) as Comic;

describe("fresh answers versus catch-ups, quiet hours and no bursts", () => {
  const now = 1e12;
  it("a fresh answer goes at any hour", () => {
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
  it("a fresh answer is never a catch-up; a yes older than 12 hours is", () => {
    const now = { date: "2026-10-28", time: "10:00" };
    const nowMs = Date.parse("2026-10-28T04:30:00Z");
    expect(isCatchUp({ outcomeAt: nowMs - 60_000 }, "2026-10-26 22:00", now, nowMs)).toBe(false);
    expect(isCatchUp({ outcomeAt: nowMs - 13 * 3_600_000 }, "2026-10-27 22:00", now, nowMs)).toBe(true);
    // no recorded answer time: measured from when the mic check was due
    expect(isCatchUp({}, "2026-10-27 22:00", now, nowMs)).toBe(false);
    expect(isCatchUp({}, "2026-10-27 21:59", now, nowMs)).toBe(true);
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

describe("the didn't-happen questions", () => {
  it("model reasons are cleaned (3 to 8, no repeats, Other last); unusable ones fall back", () => {
    expect(cleanReasonOptions({ reasons: ["Rain", "rain", "No audience", "Other", "Venue shut", " "] })).toEqual(["Rain", "No audience", "Venue shut", "Other"]);
    expect(cleanReasonOptions(["a b", "c d", "e f"])).toEqual(["a b", "c d", "e f", "Other"]);
    expect(cleanReasonOptions({ reasons: ["Only one"] })).toBeNull();
    expect(cleanReasonOptions("nope")).toBeNull();
    expect(WHY_PRESETS.at(-1)).toBe("Other");
  });
  it("votes, notes and typed notes", () => {
    expect(voteRepeat(["Repeat"])).toBe("repeat");
    expect(voteRepeat(["Don't repeat"])).toBe("no");
    expect(voteRepeat(["Not decided"])).toBe("later");
    expect(voteRepeat([])).toBeNull();
    expect(composeNoNotes(["No audience", "Weather/rain"], "road flooded")).toBe("Didn't happen: No audience, Weather/rain. road flooded");
    expect(composeNoNotes([], "")).toBeNull();
    expect(parseNoNote("note: rain all day")).toBe("rain all day");
    expect(parseNoNote("because the venue flooded")).toBe("the venue flooded");
    expect(parseNoNote("Monday lineup?")).toBeNull();
    expect(parseNoNote("notes are great")).toBeNull();
  });
  it("only seeds an empty next week, with who and how long and nothing else", () => {
    const prev = { slots: [{ comicId: "a", minutes: 5, rating: 3, note: "x" }, { comicId: "b" }] };
    expect(repeatSlots(prev, undefined)).toEqual([{ comicId: "a", minutes: 5 }, { comicId: "b" }]);
    expect(repeatSlots(prev, { slots: [] })).toHaveLength(2);
    expect(repeatSlots(prev, { slots: [{ comicId: "z" }] })).toBeNull();
    expect(repeatSlots({ slots: [] }, undefined)).toBeNull();
  });
});
