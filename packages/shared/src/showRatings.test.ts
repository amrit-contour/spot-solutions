import { describe, expect, it } from "vitest";
import {
  MIC_CHECK_DEFAULT_HOURS,
  applySlotRatings,
  formatRatingAsk,
  micCheckDue,
  micCheckDueAt,
  micDelayHours,
  parseRatings,
  ratingAskDue,
  ratingReply,
  ratingSummary,
  unrated,
  withHistory,
  withRating,
  type Lineup,
  type Slot,
  type SpotHistoryEntry,
} from "./index.ts";

const show = { startTime: "20:00" };
const lineup = (o: Partial<Lineup> = {}): Lineup => ({ id: "w_s", weekOf: "2026-10-26", showId: "s", date: "2026-10-26", slots: [], status: "confirmed", ...o });

describe("mic check timing: start + 2 hours", () => {
  it("defaults to 2 hours and ignores silly settings", () => {
    expect(MIC_CHECK_DEFAULT_HOURS).toBe(2);
    expect(micDelayHours(undefined)).toBe(2);
    expect(micDelayHours({})).toBe(2);
    expect(micDelayHours({ afterHours: 3 })).toBe(3);
    expect(micDelayHours({ afterHours: 0 })).toBe(0);
    expect(micDelayHours({ afterHours: -1 })).toBe(2);
    expect(micDelayHours({ afterHours: 500 })).toBe(2);
    expect(micDelayHours({ afterHours: Number.NaN })).toBe(2);
  });
  it("is due exactly two hours after the start, not before", () => {
    expect(micCheckDueAt("2026-10-26", "20:00", 2)).toBe("2026-10-26 22:00");
    expect(micCheckDue(lineup(), show, { date: "2026-10-26", time: "21:59" }, 2)).toBe(false);
    expect(micCheckDue(lineup(), show, { date: "2026-10-26", time: "22:00" }, 2)).toBe(true);
    expect(micCheckDue(lineup(), show, { date: "2026-10-27", time: "09:00" }, 2)).toBe(true);
  });
  it("rolls past midnight for late shows", () => {
    expect(micCheckDueAt("2026-10-26", "23:30", 2)).toBe("2026-10-27 01:30");
    expect(micCheckDue(lineup(), { startTime: "23:30" }, { date: "2026-10-26", time: "23:59" }, 2)).toBe(false);
    expect(micCheckDue(lineup(), { startTime: "23:30" }, { date: "2026-10-27", time: "01:30" }, 2)).toBe(true);
  });
  it("follows the account's setting", () => {
    expect(micCheckDue(lineup(), show, { date: "2026-10-26", time: "22:00" }, 3)).toBe(false);
    expect(micCheckDue(lineup(), show, { date: "2026-10-26", time: "23:00" }, 3)).toBe(true);
  });
  it("never asks about an answered, unconfirmed, recorded or unknown show", () => {
    const late = { date: "2026-10-30", time: "12:00" };
    expect(micCheckDue(lineup({ outcome: "happened" }), show, late, 2)).toBe(false);
    expect(micCheckDue(lineup({ status: "draft" }), show, late, 2)).toBe(false);
    expect(micCheckDue(lineup({ backfilled: true }), show, late, 2)).toBe(false);
    expect(micCheckDue(lineup(), undefined, late, 2)).toBe(false);
  });
});

describe("parseRatings", () => {
  const left3 = [1, 2, 3];
  it("reads number-then-rating pairs", () => {
    expect(parseRatings("1 4, 2 5, 3 3", 3, left3)).toEqual({ ratings: { 1: 4, 2: 5, 3: 3 }, skip: false });
    expect(parseRatings("1:4 , 2:5", 3, left3)?.ratings).toEqual({ 1: 4, 2: 5 });
    expect(parseRatings("1=4; 3=2", 3, left3)?.ratings).toEqual({ 1: 4, 3: 2 });
    expect(parseRatings("2 5", 3, left3)?.ratings).toEqual({ 2: 5 });
    expect(parseRatings("1-4\n2-5", 3, left3)?.ratings).toEqual({ 1: 4, 2: 5 });
    expect(parseRatings("1 4 and 2 5", 3, left3)?.ratings).toEqual({ 1: 4, 2: 5 });
    expect(parseRatings("1 4/5, 2 5/5", 3, left3)?.ratings).toEqual({ 1: 4, 2: 5 });
  });
  it("reads one rating per comic left, in order", () => {
    expect(parseRatings("4 5 3", 3, left3)?.ratings).toEqual({ 1: 4, 2: 5, 3: 3 });
    expect(parseRatings("5", 3, [2])?.ratings).toEqual({ 2: 5 });
    expect(parseRatings("4 2", 4, [2, 4])?.ratings).toEqual({ 2: 4, 4: 2 });
  });
  it("reads pairs separated only by spaces when the count isn't one-each", () => {
    expect(parseRatings("1 4 2 5", 3, left3)?.ratings).toEqual({ 1: 4, 2: 5 });
  });
  it("a single pair when one comic is left or the count differs", () => {
    expect(parseRatings("3 4", 3, [3])?.ratings).toEqual({ 3: 4 });
    expect(parseRatings("2 4", 3, left3)?.ratings).toEqual({ 2: 4 });
  });
  it("everyone the same", () => {
    expect(parseRatings("all 4", 3, left3)?.ratings).toEqual({ 1: 4, 2: 4, 3: 4 });
    expect(parseRatings("everyone 5", 3, [2, 3])?.ratings).toEqual({ 2: 5, 3: 5 });
  });
  it("skip stops asking", () => {
    for (const t of ["skip", "Skip", "later", "not now", "none"]) expect(parseRatings(t, 3, left3)).toEqual({ ratings: {}, skip: true });
  });
  it("is strict: anything else isn't a rating reply", () => {
    for (const t of ["add Rohan to Tuesday", "yes", "no", "who's on Monday", "1 7", "0 4", "4 9, 1 3", "9 4", "", "hello 4", "7"]) expect(parseRatings(t, 3, left3), t).toBeNull();
  });
  it("list numbers beyond the lineup are refused", () => {
    expect(parseRatings("4 5", 3, left3)).toBeNull();
  });
});

describe("ratings on slots and history", () => {
  const slots: Slot[] = [{ comicId: "a" }, { comicId: "b", rating: 3 }, { comicId: "c" }];
  it("applySlotRatings sets and clears by comic id", () => {
    expect(applySlotRatings(slots, { a: 5 }).map((s) => s.rating)).toEqual([5, 3, undefined]);
    expect(applySlotRatings(slots, { b: null })[1]).toEqual({ comicId: "b" });
    expect(applySlotRatings(slots, { zzz: 4 })).toEqual(slots);
    expect(applySlotRatings(slots, { a: 9 })[0]).toEqual({ comicId: "a" });
  });
  it("unrated lists who is left with their list numbers", () => {
    expect(unrated(slots)).toEqual([{ n: 1, comicId: "a" }, { n: 3, comicId: "c" }]);
  });
  const h = (o: Partial<SpotHistoryEntry> = {}): SpotHistoryEntry => ({ date: "2026-10-26", showId: "s", showName: "Mic", status: "confirmed", ...o });
  it("withRating edits one entry and never invents a spot", () => {
    expect(withRating([h(), h({ date: "2026-10-19" })], "2026-10-26", "s", 4)?.map((x) => x.rating)).toEqual([4, undefined]);
    expect(withRating([h({ rating: 4 })], "2026-10-26", "s", null)?.[0]).not.toHaveProperty("rating");
    const none = [h()];
    expect(withRating(none, "2030-01-01", "s", 3)).toBe(none);
    expect(withRating(undefined, "2026-10-26", "s", 3)).toBeUndefined();
  });
  it("re-recording a spot keeps its rating, unless the night didn't happen", () => {
    expect(withHistory([h({ rating: 5 })], h())[0]!.rating).toBe(5);
    expect(withHistory([h({ rating: 5 })], h({ status: "canned" }))[0]!.rating).toBeUndefined();
    expect(withHistory([h({ rating: 5 })], h({ rating: 2 }))[0]!.rating).toBe(2);
  });
  it("ratingSummary averages what is rated", () => {
    expect(ratingSummary([h({ rating: 4 }), h({ date: "2026-10-19", rating: 5 }), h({ date: "2026-10-12" })])).toEqual({ avg: 4.5, count: 2 });
    expect(ratingSummary([h({ status: "canned", rating: 1 })])).toBeNull();
    expect(ratingSummary(undefined)).toBeNull();
  });
});

describe("when the agent asks for ratings", () => {
  const l = (o: Partial<Lineup> = {}) => lineup({ outcome: "happened", slots: [{ comicId: "a" }], ...o });
  it("asks once, for a recent show that happened and has someone unrated", () => {
    expect(ratingAskDue(l(), "2026-10-26")).toBe(true);
    expect(ratingAskDue(l(), "2026-10-28")).toBe(true);
    expect(ratingAskDue(l(), "2026-11-15")).toBe(false); // old: rate in the app
    expect(ratingAskDue(l({ ratingAskedOn: "2026-10-26" }), "2026-10-27")).toBe(false);
    expect(ratingAskDue(l({ ratingsSkipped: true }), "2026-10-27")).toBe(false);
    expect(ratingAskDue(l({ outcome: null }), "2026-10-27")).toBe(false);
    expect(ratingAskDue(l({ status: "canned" }), "2026-10-27")).toBe(false);
    expect(ratingAskDue(l({ backfilled: true }), "2026-10-27")).toBe(false);
    expect(ratingAskDue(l({ slots: [] }), "2026-10-27")).toBe(false);
    expect(ratingAskDue(l({ slots: [{ comicId: "a", rating: 4 }] }), "2026-10-27")).toBe(false);
    expect(ratingAskDue(l(), "2026-10-25")).toBe(false); // not yet the show day
  });
});

describe("the messages", () => {
  it("lists the lineup, numbered, with an example that fits", () => {
    const t = formatRatingAsk({ showName: "Bloom Mic", date: "2026-10-26", rows: [{ name: "Rohan" }, { name: "Priya", rating: 4 }, { name: "Sam" }] });
    expect(t).toContain("*Bloom Mic*");
    expect(t).toContain("1. Rohan");
    expect(t).toContain("2. Priya (4/5)");
    expect(t).toContain("3. Sam");
    expect(t).toContain("*1 4, 3 5*");
    expect(t).toContain("*skip*");
  });
  it("answers with what was saved and who is left", () => {
    expect(ratingReply({ saved: [{ name: "Rohan", rating: 4 }], left: [{ n: 2, name: "Priya" }] })).toBe("Saved: Rohan 4/5. Still to rate: 2. Priya. Reply like *2 4*, or *skip*.");
    expect(ratingReply({ saved: [{ name: "Rohan", rating: 4 }], left: [] })).toContain("That's everyone");
    expect(ratingReply({ saved: [], left: [], skipped: true })).toContain("in the app");
  });
});
