import { describe, expect, it } from "vitest";
import {
  ATTENDANCE,
  allTags,
  applySlotReviews,
  cleanTags,
  parseAttendanceMarks,
  performed,
  reliability,
  unrated,
  cleanNote,
  formatReviewAsk,
  hasReview,
  mergeReview,
  parseShowReview,
  reviewAskDue,
  reviewProgress,
  reviewReply,
  withHistory,
  withSpotReview,
  type Lineup,
  type Slot,
  type SpotHistoryEntry,
} from "./index.ts";

const lineup = (o: Partial<Lineup> = {}): Lineup => ({ id: "w_s", weekOf: "2026-10-26", showId: "s", date: "2026-10-26", slots: [{ comicId: "a", rating: 4 }], status: "confirmed", outcome: "happened", ...o });
const entry = (o: Partial<SpotHistoryEntry> = {}): SpotHistoryEntry => ({ date: "2026-10-26", showId: "s", showName: "Mon", status: "confirmed", ...o });

describe("parseShowReview", () => {
  it("reads a rating then notes", () => {
    expect(parseShowReview("4 great crowd, sound was bad")).toEqual({ rating: 4, notes: "great crowd, sound was bad", skip: false });
    expect(parseShowReview("5")).toEqual({ rating: 5, notes: null, skip: false });
    expect(parseShowReview("  3 - slow start ")).toEqual({ rating: 3, notes: "slow start", skip: false });
    expect(parseShowReview("2, packed but cold")).toEqual({ rating: 2, notes: "packed but cold", skip: false });
  });
  it("accepts the usual ways of writing a rating", () => {
    expect(parseShowReview("4/5 good night")?.rating).toBe(4);
    expect(parseShowReview("4 out of 5")).toEqual({ rating: 4, notes: null, skip: false });
    expect(parseShowReview("3 stars, quiet")).toEqual({ rating: 3, notes: "quiet", skip: false });
    expect(parseShowReview("Rating: 5 loved it")).toEqual({ rating: 5, notes: "loved it", skip: false });
  });
  it("skip works", () => {
    expect(parseShowReview("skip")).toEqual({ rating: null, notes: null, skip: true });
    expect(parseShowReview("Not now")?.skip).toBe(true);
  });
  it("is strict: only a leading rating counts", () => {
    for (const t of ["", "great crowd", "add Rohan to Tuesday", "45 people came", "4.5", "10", "0 bad", "6", "4pm start", "yes", "show was a 4"]) expect(parseShowReview(t), t).toBeNull();
  });
  it("caps very long notes", () => {
    expect(parseShowReview(`4 ${"x".repeat(2000)}`)!.notes!.length).toBeLessThanOrEqual(600);
  });
});

describe("notes and merging a review", () => {
  it("cleanNote trims, caps and turns blank into null", () => {
    expect(cleanNote("  hi  ", 10)).toBe("hi");
    expect(cleanNote("   ", 10)).toBeNull();
    expect(cleanNote(undefined, 10)).toBeNull();
    expect(cleanNote("abcdefghij", 4)).toBe("abcd");
  });
  it("mergeReview patches parts, keeps the rest, and is null when empty", () => {
    const a = mergeReview(null, { rating: 4, notes: " great " }, 1)!;
    expect(a).toEqual({ at: 1, rating: 4, notes: "great" });
    const b = mergeReview(a, { crowd: "packed" }, 2)!;
    expect(b).toEqual({ at: 2, rating: 4, notes: "great", crowd: "packed" });
    expect(mergeReview(b, { rating: null, notes: "", crowd: null }, 3)).toBeNull();
    expect(mergeReview(null, { rating: 9 as number }, 1)).toBeNull();
    expect(Object.values(mergeReview(null, { rating: 3 }, 1)!)).not.toContain(undefined);
  });
  it("hasReview", () => {
    expect(hasReview(lineup())).toBe(false);
    expect(hasReview(lineup({ review: { at: 1, notes: "ok" } }))).toBe(true);
    expect(hasReview(lineup({ review: { at: 1 } }))).toBe(false);
  });
});

describe("comic reviews on slots and history", () => {
  const slots: Slot[] = [{ comicId: "a", rating: 4, note: "tight set" }, { comicId: "b" }];
  it("sets and clears rating and note independently, leaves others, never writes undefined", () => {
    const out = applySlotReviews(slots, { a: { note: null }, b: { rating: 5, note: " ran long " } });
    expect(out[0]).toEqual({ comicId: "a", rating: 4 });
    expect(out[1]).toEqual({ comicId: "b", rating: 5, note: "ran long" });
    expect(applySlotReviews(slots, { a: { rating: null } })[0]).toEqual({ comicId: "a", note: "tight set" });
    expect(applySlotReviews(slots, { zzz: { rating: 1 } })).toEqual(slots);
    expect(Object.values(out[0]!)).not.toContain(undefined);
  });
  it("spot history gets the same, and a missing spot is not invented", () => {
    const h = [entry({ rating: 3 }), entry({ date: "2026-10-19" })];
    const out = withSpotReview(h, "2026-10-26", "s", { note: "crowd loved the closer" })!;
    expect(out[0]).toMatchObject({ rating: 3, note: "crowd loved the closer" });
    expect(out[1]).toEqual(h[1]);
    expect(withSpotReview(h, "2026-01-01", "s", { rating: 5 })).toBe(h);
    expect(withSpotReview(undefined, "2026-10-26", "s", { rating: 5 })).toBeUndefined();
  });
  it("re-recording a confirmed spot keeps its note; a canned night does not", () => {
    const h = [entry({ rating: 4, note: "great" })];
    expect(withHistory(h, entry())[0]).toMatchObject({ rating: 4, note: "great" });
    expect(withHistory(h, entry({ status: "canned" }))[0]!.note).toBeUndefined();
  });
  it("reviewProgress counts", () => {
    expect(reviewProgress(lineup({ slots, review: { at: 1, rating: 5 } }))).toEqual({ rated: 1, noted: 1, total: 2, show: 5 });
  });
});

describe("the overall question", () => {
  it("is due once, after every comic is rated, for a recent happened show", () => {
    expect(reviewAskDue(lineup(), "2026-10-26")).toBe(true);
    expect(reviewAskDue(lineup({ slots: [{ comicId: "a" }] }), "2026-10-26")).toBe(false); // still unrated: the rating question first
    expect(reviewAskDue(lineup({ reviewAskedOn: "2026-10-26" }), "2026-10-26")).toBe(false);
    expect(reviewAskDue(lineup({ review: { at: 1, rating: 4 } }), "2026-10-26")).toBe(false);
    expect(reviewAskDue(lineup({ ratingsSkipped: true }), "2026-10-26")).toBe(false);
    expect(reviewAskDue(lineup({ outcome: null }), "2026-10-26")).toBe(false);
    expect(reviewAskDue(lineup({ backfilled: true }), "2026-10-26")).toBe(false);
    expect(reviewAskDue(lineup(), "2026-11-20")).toBe(false);
    expect(reviewAskDue(lineup({ date: "2026-10-30" }), "2026-10-26")).toBe(false);
  });
  it("wording", () => {
    expect(formatReviewAsk("Monday Mic")).toContain("How was *Monday Mic* overall?");
    expect(reviewReply({ rating: 4, notes: "great crowd" })).toBe('Saved the show review: 4/5, "great crowd". Thanks.');
    expect(reviewReply({ rating: 5, notes: null })).toBe("Saved the show review: 5/5. Thanks.");
    expect(reviewReply({ rating: null, notes: null, skipped: true })).toMatch(/leave the show review/);
  });
});

describe("attendance and tags", () => {
  it("offers the five attendance choices and treats a missing one as showed up", () => {
    expect(ATTENDANCE.map((a) => a.value)).toEqual(["showed", "late", "no_show", "cancelled", "swapped"]);
    expect(performed(undefined)).toBe(true);
    expect(performed("late")).toBe(true);
    for (const a of ["no_show", "cancelled", "swapped"] as const) expect(performed(a)).toBe(false);
  });
  it("tags are cleaned, de-duplicated and capped; the offered set adds custom tags once", () => {
    expect(cleanTags(["  Killed ", "killed", "", "Hack  job"])).toEqual(["Killed", "Hack job"]);
    expect(cleanTags(Array.from({ length: 30 }, (_, i) => `t${i}`))).toHaveLength(12);
    expect(cleanTags(undefined)).toEqual([]);
    const all = allTags(["Great closer", "killed"]);
    expect(all.slice(0, 3)).toEqual(["Killed", "Destroyed", "Did very well"]);
    expect(all).toContain("Great closer");
    expect(all.filter((t) => t.toLowerCase() === "killed")).toHaveLength(1);
  });
  it("stores attendance and tags on slots and history; showed up is stored as nothing", () => {
    const slots: Slot[] = [{ comicId: "a", rating: 4 }, { comicId: "b" }];
    const out = applySlotReviews(slots, { a: { attendance: "late", tags: ["Killed", "killed", "Clean"] }, b: { attendance: "showed" } });
    expect(out[0]).toEqual({ comicId: "a", rating: 4, attendance: "late", tags: ["Killed", "Clean"] });
    expect(out[1]).toEqual({ comicId: "b" });
    const h = withSpotReview([entry()], "2026-10-26", "s", { attendance: "late", tags: ["Hack"], rating: 2 })!;
    expect(h[0]).toMatchObject({ attendance: "late", tags: ["Hack"], rating: 2 });
  });
  it("a no-show, cancelled or swapped comic loses the rating and tags, keeps the note, and needs no rating", () => {
    const slots: Slot[] = [{ comicId: "a", rating: 5, tags: ["Killed"], note: "n" }, { comicId: "b" }, { comicId: "c" }];
    const out = applySlotReviews(slots, { a: { attendance: "no_show" }, b: { attendance: "cancelled" } });
    expect(out[0]).toEqual({ comicId: "a", attendance: "no_show", note: "n" });
    expect(unrated(out)).toEqual([{ n: 3, comicId: "c" }]);
    expect(applySlotReviews(out, { a: { attendance: "showed" } })[0]).toEqual({ comicId: "a", note: "n" });
    const swapped = applySlotReviews([{ comicId: "x", rating: 3 }], { x: { attendance: "swapped", rating: 3 } })[0]!;
    expect(swapped.rating).toBeUndefined();
  });
  it("reliability counts past confirmed spots only", () => {
    const h = [entry({ date: "2026-10-01", attendance: "no_show" }), entry({ date: "2026-10-08", attendance: "late" }), entry({ date: "2026-10-15", attendance: "late" }), entry({ date: "2026-10-20" }), entry({ date: "2026-12-01", attendance: "no_show" }), entry({ date: "2026-10-22", status: "cancelled", attendance: "no_show" })];
    expect(reliability(h, "2026-10-28")).toMatchObject({ noShows: 1, late: 2, total: 4, line: "No-shows 1 · Late 2 of 4" });
    expect(reliability([entry()], "2026-10-28")).toBeNull();
    expect(reliability(undefined, "2026-10-28")).toBeNull();
  });
  it("parseAttendanceMarks reads '2 no show', '3 late' and leaves the rest alone", () => {
    expect(parseAttendanceMarks("2 no show", 3)).toEqual({ marks: { 2: "no_show" }, rest: "" });
    expect(parseAttendanceMarks("3 late, 1 4", 3)).toEqual({ marks: { 3: "late" }, rest: "1 4" });
    expect(parseAttendanceMarks("1 no-show and 2 cancelled; 3 swapped", 3)?.marks).toEqual({ 1: "no_show", 2: "cancelled", 3: "swapped" });
    expect(parseAttendanceMarks("2 didn't show up", 3)?.marks).toEqual({ 2: "no_show" });
    for (const t of ["1 killed", "4 late", "add Rohan late", "late", "1 4, 2 5", "skip"]) expect(parseAttendanceMarks(t, 3), t).toBeNull();
  });
});
