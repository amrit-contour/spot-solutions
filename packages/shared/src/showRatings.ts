// "Did the mic happen?" timing and "how did they do?" ratings.
//   - The mic check is due a fixed time after the show STARTS (default 2 hours), not "the morning after".
//   - After a yes, the agent lists the lineup and the curator rates each comic 1-5 by text ("1 4, 2 5, 3 3"). The same rating can be
//     given or changed in the app. It lives on the lineup slot and on the comic's spot history entry, so it outlives the lineup.
import type { Attendance, CrowdLevel, Lineup, Show, ShowReview, Slot, SpotHistoryEntry } from "./types.ts";
import { formatDate } from "./week.ts";

/** Hours after a show starts that the "did it happen?" question is due, unless the curator changed it. */
export const MIC_CHECK_DEFAULT_HOURS = 2;
export const RATING_MIN = 1;
export const RATING_MAX = 5;
/** The agent waits this long for ratings before leaving them to the app. */
export const RATING_ASK_TTL_MS = 36 * 3_600_000;
/** Only shows this recent get a rating question on their own (older ones are rated in the app). */
export const RATING_ASK_DAYS = 3;

export const RATING_WORDS: Record<number, string> = { 1: "Rough", 2: "Below par", 3: "Solid", 4: "Strong", 5: "Killed it" };

export const isRating = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= RATING_MIN && n <= RATING_MAX;

/** Hours from the account's setting (missing or silly values fall back to 2). */
export function micDelayHours(m: { afterHours?: number | null } | undefined): number {
  const h = m?.afterHours;
  return typeof h === "number" && Number.isFinite(h) && h >= 0 && h <= 48 ? h : MIC_CHECK_DEFAULT_HOURS;
}

const wall = (date: string, time: string) => Date.parse(`${date}T${/^\d{2}:\d{2}/.test(time) ? time.slice(0, 5) : "00:00"}:00Z`);

/** When the question is due, as a local wall clock "YYYY-MM-DD HH:MM" (start + the delay; late shows roll past midnight). */
export function micCheckDueAt(date: string, startTime: string, hours: number): string {
  return new Date(wall(date, startTime) + hours * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
}

/** Is this lineup's mic check due now? `now` is the curator's local {date, time} (localNow). */
export function micCheckDue(lineup: Pick<Lineup, "date" | "status" | "outcome" | "backfilled">, show: Pick<Show, "startTime"> | undefined, now: { date: string; time: string }, hours: number): boolean {
  if (lineup.status !== "confirmed" || lineup.outcome || lineup.backfilled || !lineup.date || !show) return false;
  return micCheckDueAt(lineup.date, show.startTime, hours) <= `${now.date} ${now.time}`;
}

/** "2 hours", "1 hour", "30 minutes" for settings and messages. */
export function delayLabel(hours: number): string {
  if (hours === 0) return "right at the start";
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------- ratings on a lineup

/** Slots with the ratings applied (by comic id). A rating of null clears it. Comics not on the lineup are ignored. */
export function applySlotRatings(slots: Slot[], ratings: Record<string, number | null>): Slot[] {
  return slots.map((s) => {
    if (!(s.comicId in ratings)) return s;
    const r = ratings[s.comicId];
    const { rating: _old, ...rest } = s;
    return isRating(r) ? { ...rest, rating: r } : rest;
  });
}

/** Set (or clear) the rating on one spot-history entry. A missing entry is left missing: a rating doesn't invent a spot. */
export function withRating(history: SpotHistoryEntry[] | undefined, date: string, showId: string, rating: number | null): SpotHistoryEntry[] | undefined {
  if (!history?.some((h) => h.date === date && h.showId === showId)) return history;
  return history.map((h) => {
    if (h.date !== date || h.showId !== showId) return h;
    const { rating: _old, ...rest } = h;
    return isRating(rating) ? { ...rest, rating } : rest;
  });
}

/** Everyone on the lineup who hasn't been rated yet, in lineup order, with their 1-based number in the list. */
export function unrated(slots: Slot[]): { n: number; comicId: string }[] {
  return slots.map((s, i) => ({ n: i + 1, comicId: s.comicId, rating: s.rating, off: !performed(s.attendance) })).filter((x) => !isRating(x.rating) && !x.off).map(({ n, comicId }) => ({ n, comicId }));
}

/** Should the agent ask for ratings for this lineup (by itself, once)? */
export function ratingAskDue(l: Pick<Lineup, "outcome" | "status" | "backfilled" | "slots" | "ratingAskedOn" | "ratingsSkipped" | "date">, today: string): boolean {
  if (l.outcome !== "happened" || l.status === "canned" || l.status === "cancelled" || l.backfilled || l.ratingAskedOn || l.ratingsSkipped) return false;
  if (!l.date || l.date > today) return false;
  const oldest = new Date(Date.parse(`${today}T00:00:00Z`) - RATING_ASK_DAYS * 86_400_000).toISOString().slice(0, 10);
  return l.date >= oldest && unrated(l.slots).length > 0;
}

/** Average and count of the ratings in a spot history (null when none). */
export function ratingSummary(history: SpotHistoryEntry[] | undefined): { avg: number; count: number } | null {
  const rs = (history ?? []).filter((h) => h.status === "confirmed" && isRating(h.rating)).map((h) => h.rating as number);
  if (!rs.length) return null;
  return { avg: Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 10) / 10, count: rs.length };
}

// ---------------------------------------------------------------- the WhatsApp question and its answer

/** The one message that asks for the whole lineup's ratings. `rows`: every slot in order, with a name and the rating it has (if any). */
export function formatRatingAsk(o: { showName: string; date: string; rows: { name: string; rating?: number | null }[] }): string {
  const lines = o.rows.map((r, i) => `${i + 1}. ${r.name}${isRating(r.rating) ? ` (${r.rating}/5)` : ""}`);
  const left = o.rows.map((r, i) => ({ r, n: i + 1 })).filter((x) => !isRating(x.r.rating));
  const example = left.slice(0, 3).map((x, i) => `${x.n} ${[4, 5, 3][i]}`).join(", ") || "1 4";
  return [
    `🎤 How did everyone do at *${o.showName}* on ${formatDate(o.date)}? Rate 1 (rough) to 5 (killed it).`,
    "",
    ...lines,
    "",
    `Reply with the number and the rating, like *${example}*${left.length > 1 ? `, or just *${left.slice(0, 3).map((_, i) => [4, 5, 3][i]).join(" ")}* in order` : ""}. Didn't turn up? *2 no show*, *3 late*. *skip* leaves it for the app.`,
  ].join("\n");
}

export interface ParsedRatings {
  /** 1-based list number -> rating. */
  ratings: Record<number, number>;
  /** "skip": stop asking. */
  skip: boolean;
}

const SKIP = /^(?:skip|skip (?:it|all|them)|later|not now|never ?mind|none|no ratings?|cancel|pass)$/i;
const isDigit15 = (t: string) => /^[1-5]$/.test(t);

/**
 * Read a reply to the rating question, strictly: only things that are plainly ratings count, so "add Rohan to Tuesday" never
 * does. `total` is how many comics were listed; `left` the list numbers still unrated (in order).
 *   "1 4, 2 5, 3 3" / "1:4 2:5" / "1=4; 2=5"   number, then rating
 *   "4 5 3"                                    one rating per comic still to rate, in order
 *   "all 4" / "everyone 4"                     the same rating for everyone left
 *   "skip"                                     stop asking
 * Returns null when it isn't a rating reply.
 */
export function parseRatings(text: string, total: number, left: number[]): ParsedRatings | null {
  const t = text.trim().toLowerCase().replace(/\bout of 5\b|\/ ?5\b/g, "").replace(/[★⭐]/g, "").trim();
  if (!t) return null;
  if (SKIP.test(t)) return { ratings: {}, skip: true };
  const all = t.match(/^(?:all|everyone|everybody|all of them)\s*[:=-]?\s*([1-5])$/);
  if (all) return { ratings: Object.fromEntries(left.map((n) => [n, Number(all[1])])), skip: false };

  const hasSep = /[,;:=\n]|\band\b|&/.test(t);
  const parts = t.split(/\s*(?:,|;|\n|\band\b|&)\s*/).filter(Boolean);
  // "number rating" pairs, one per part
  const pairs: Record<number, number> = {};
  let pairsOk = parts.length > 0;
  for (const p of parts) {
    const m = p.match(/^(?:#)?(\d{1,2})\s*[:=-]?\s*([1-5])$/) ?? p.match(/^(\d{1,2})\s*[:=-]\s*([1-5])$/);
    if (!m) {
      pairsOk = false;
      break;
    }
    const n = Number(m[1]);
    if (n < 1 || n > total) {
      pairsOk = false;
      break;
    }
    pairs[n] = Number(m[2]);
  }
  const bare = t.split(/[\s,;]+/).filter(Boolean);
  // Several pairs separated by spaces only ("1 4 2 5"): read it as pairs when it isn't one rating per comic left.
  const spaced = !hasSep && bare.length >= 4 && bare.length % 2 === 0 && bare.length !== left.length;
  if (spaced) {
    const sp: Record<number, number> = {};
    for (let i = 0; i < bare.length; i += 2) {
      const n = Number(bare[i]);
      if (!/^\d{1,2}$/.test(bare[i]!) || n < 1 || n > total || !isDigit15(bare[i + 1]!)) return null;
      sp[n] = Number(bare[i + 1]);
    }
    return { ratings: sp, skip: false };
  }
  // One rating each, in order ("4 5 3", "453" is not accepted). Wins over a single pair when the count matches what's left.
  if (!hasSep && bare.length === left.length && bare.every(isDigit15)) {
    return { ratings: Object.fromEntries(left.map((n, i) => [n, Number(bare[i])])), skip: false };
  }
  if (pairsOk && Object.keys(pairs).length) return { ratings: pairs, skip: false };
  return null;
}

/** What the agent says after a rating reply. */
export function ratingReply(o: { saved: { name: string; rating: number }[]; left: { n: number; name: string }[]; skipped?: boolean; marked?: { name: string; attendance: Attendance }[] }): string {
  if (o.skipped) return "Okay, I'll leave the ratings. You can rate them in the app, on the show or in each comic's spot history.";
  const marked = o.marked?.length ? `Marked: ${o.marked.map((m) => `${m.name} ${attendanceLabel(m.attendance).toLowerCase()}`).join(", ")}.` : "";
  const got = [o.saved.length ? `Saved: ${o.saved.map((s) => `${s.name} ${s.rating}/5`).join(", ")}.` : "", marked].filter(Boolean).join(" ") || "I didn't get a rating from that.";
  if (!o.left.length) return `${got} That's everyone, thanks.`;
  return `${got} Still to rate: ${o.left.map((l) => `${l.n}. ${l.name}`).join(", ")}. Reply like *${o.left[0]!.n} 4*, or *skip*.`;
}

// ---------------------------------------------------------------- the review of the show itself, and a note on each comic

export const SHOW_NOTES_MAX = 600;
export const COMIC_NOTE_MAX = 200;
export const CROWD_LEVELS: { value: CrowdLevel; label: string }[] = [
  { value: "quiet", label: "Quiet" },
  { value: "good", label: "Good" },
  { value: "packed", label: "Packed" },
];
export const isCrowd = (v: unknown): v is CrowdLevel => CROWD_LEVELS.some((c) => c.value === v);

/** Trimmed free text capped at `max`; empty becomes null (so a cleared note is removed, never stored blank). */
export function cleanNote(text: string | null | undefined, max: number): string | null {
  const t = (text ?? "").replace(/[ \t]+\n/g, "\n").trim();
  return t ? t.slice(0, max).trim() : null;
}

export interface ReviewPatch {
  rating?: number | null;
  notes?: string | null;
  crowd?: CrowdLevel | null;
}

/** The review after applying a patch (a key that is present replaces that part; null clears it). Null when nothing is left. */
export function mergeReview(prev: ShowReview | null | undefined, patch: ReviewPatch, at: number): ShowReview | null {
  const rating = "rating" in patch ? patch.rating : prev?.rating;
  const notes = "notes" in patch ? cleanNote(patch.notes, SHOW_NOTES_MAX) : cleanNote(prev?.notes, SHOW_NOTES_MAX);
  const crowd = "crowd" in patch ? patch.crowd : prev?.crowd;
  const out: ShowReview = { at };
  if (isRating(rating)) out.rating = rating;
  if (notes) out.notes = notes;
  if (isCrowd(crowd)) out.crowd = crowd;
  return out.rating == null && !out.notes && !out.crowd ? null : out;
}

/** Does the lineup have a show review with anything in it? */
export const hasReview = (l: Pick<Lineup, "review"> | undefined): boolean => Boolean(l?.review && (isRating(l.review.rating) || l.review.notes || l.review.crowd));

/** What the curator wrote for one comic (a missing key is left as it is, null clears it). */
export interface SpotReview {
  rating?: number | null;
  note?: string | null;
  attendance?: Attendance | null;
  tags?: string[] | null;
}

export const ATTENDANCE: { value: Attendance; label: string; short: string }[] = [
  { value: "showed", label: "Showed up", short: "Showed up" },
  { value: "late", label: "Late", short: "Late" },
  { value: "no_show", label: "No-show", short: "No-show" },
  { value: "cancelled", label: "Cancelled in advance", short: "Cancelled" },
  { value: "swapped", label: "Swapped / gave spot away", short: "Swapped" },
];
export const isAttendance = (v: unknown): v is Attendance => ATTENDANCE.some((a) => a.value === v);
/** Did they take the stage? No-show, cancelled and swapped did not (so no rating or tags); a missing value means they showed up. */
export const performed = (a: Attendance | null | undefined): boolean => a !== "no_show" && a !== "cancelled" && a !== "swapped";
export const attendanceLabel = (a: Attendance | null | undefined): string => ATTENDANCE.find((x) => x.value === a)?.short ?? "Showed up";

/** The built-in performance tags, in the order they are offered. */
export const PERFORMANCE_TAGS = ["Killed", "Destroyed", "Did very well", "Solid", "New material", "Tried new bits", "Went over time", "Short set", "Bombed", "Hack", "Crowd work", "Clean", "Too blue for the room"];
export const TAG_MAX = 24;
export const TAGS_PER_SPOT_MAX = 12;

/** A tag as typed: trimmed, single spaces, capped; empty is null. */
export function cleanTag(t: string): string | null {
  const c = t.replace(/\s+/g, " ").trim().slice(0, TAG_MAX).trim();
  return c || null;
}

/** Tags cleaned, de-duplicated (case-insensitively, keeping the first spelling) and capped. */
export function cleanTags(tags: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags ?? []) {
    const c = cleanTag(t);
    if (c && !seen.has(c.toLowerCase())) (seen.add(c.toLowerCase()), out.push(c));
  }
  return out.slice(0, TAGS_PER_SPOT_MAX);
}

/** Everything offered as a tag: the built-ins, then the curator's own (without repeats). */
export const allTags = (custom: readonly string[] | null | undefined): string[] => dedupe([...PERFORMANCE_TAGS, ...(custom ?? [])]);
function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  return list.map(cleanTag).filter((t): t is string => Boolean(t) && !seen.has(t!.toLowerCase()) && (seen.add(t!.toLowerCase()), true));
}

type Reviewable = { rating?: number | null; note?: string | null; attendance?: Attendance | null; tags?: string[] | null };

/** One slot or history entry with a review applied. Did-not-perform attendance drops the rating and tags; "showed up" is stored as nothing. */
function applyReview<T extends Reviewable>(item: T, r: SpotReview): T {
  const { rating: oldRating, note: oldNote, attendance: oldAtt, tags: oldTags, ...rest } = item;
  const att = "attendance" in r ? r.attendance : oldAtt;
  const attendance = isAttendance(att) && att !== "showed" ? att : null;
  const on = performed(attendance);
  const rating = "rating" in r ? r.rating : oldRating;
  const note = "note" in r ? cleanNote(r.note, COMIC_NOTE_MAX) : oldNote;
  const tags = cleanTags("tags" in r ? r.tags : oldTags);
  return { ...rest, ...(attendance ? { attendance } : {}), ...(on && isRating(rating) ? { rating } : {}), ...(note ? { note } : {}), ...(on && tags.length ? { tags } : {}) } as T;
}

/** Slots with each comic's review applied. Comics not on the lineup are ignored. */
export function applySlotReviews(slots: Slot[], reviews: Record<string, SpotReview>): Slot[] {
  return slots.map((s) => (reviews[s.comicId] ? applyReview(s, reviews[s.comicId]!) : s));
}

/** One spot-history entry with a review applied. A missing entry stays missing, like withRating. */
export function withSpotReview(history: SpotHistoryEntry[] | undefined, date: string, showId: string, r: SpotReview): SpotHistoryEntry[] | undefined {
  if (!history?.some((h) => h.date === date && h.showId === showId)) return history;
  return history.map((h) => (h.date === date && h.showId === showId ? applyReview(h, r) : h));
}

/** "No-shows 1 · Late 2 of 12": how reliable they are over the spots they were booked for (past, confirmed). Null when nothing to flag. */
export function reliability(history: SpotHistoryEntry[] | undefined, today: string): { noShows: number; late: number; cancelled: number; total: number; line: string } | null {
  const past = (history ?? []).filter((h) => h.status === "confirmed" && h.date <= today);
  const noShows = past.filter((h) => h.attendance === "no_show").length;
  const late = past.filter((h) => h.attendance === "late").length;
  const cancelled = past.filter((h) => h.attendance === "cancelled").length;
  if (!noShows && !late && !cancelled) return null;
  const bits = [noShows ? `No-shows ${noShows}` : null, late ? `Late ${late}` : null, cancelled ? `Cancelled ${cancelled}` : null].filter(Boolean);
  return { noShows, late, cancelled, total: past.length, line: `${bits.join(" · ")} of ${past.length}` };
}

/** Counts for the one-line review summary on a show. */
export function reviewProgress(l: Pick<Lineup, "slots" | "review">): { rated: number; noted: number; total: number; show: number | null } {
  return {
    rated: l.slots.filter((s) => isRating(s.rating)).length,
    noted: l.slots.filter((s) => s.note).length,
    total: l.slots.length,
    show: isRating(l.review?.rating) ? (l.review!.rating as number) : null,
  };
}

/** Is a "how was the show overall?" question due for this lineup? Once; only after every comic is rated (or there is nothing to rate). */
export function reviewAskDue(l: Pick<Lineup, "outcome" | "status" | "backfilled" | "slots" | "review" | "reviewAskedOn" | "ratingsSkipped" | "date">, today: string): boolean {
  if (l.outcome !== "happened" || l.status === "canned" || l.status === "cancelled" || l.backfilled || l.reviewAskedOn || l.ratingsSkipped || hasReview(l)) return false;
  if (!l.date || l.date > today || unrated(l.slots).length > 0) return false;
  const oldest = new Date(Date.parse(`${today}T00:00:00Z`) - RATING_ASK_DAYS * 86_400_000).toISOString().slice(0, 10);
  return l.date >= oldest;
}

/** The question the agent asks after the comics are rated. */
export function formatReviewAsk(showName: string): string {
  return `How was *${showName}* overall? Reply 1 to 5 and any notes, like *4 great crowd, sound was bad*. *skip* leaves it for the app.`;
}

export interface ParsedReview {
  rating: number | null;
  notes: string | null;
  skip: boolean;
}

/**
 * Read the answer to "how was the show overall?", strictly: it must start with a rating on its own (1-5, optionally "4/5",
 * "4 out of 5", "4 stars", "rating 4"), then anything after is the notes. "45", "4.5", "10 people came" and notes with no rating
 * are not accepted, so an ordinary message is never swallowed. "skip" stops the question. Returns null when it isn't an answer.
 */
export function parseShowReview(text: string): ParsedReview | null {
  const raw = text.trim();
  if (!raw) return null;
  if (SKIP.test(raw)) return { rating: null, notes: null, skip: true };
  const m = raw.match(/^(?:rating\s*[:=-]?\s*|rated\s+)?([1-5])(?:\s*(?:\/\s*5|out of 5|stars?|★|⭐))?(?![\d.]|\w)\s*[,:;.\-–—]*\s*([\s\S]*)$/i);
  if (!m) return null;
  return { rating: Number(m[1]), notes: cleanNote(m[2], SHOW_NOTES_MAX), skip: false };
}

/** What the agent says after it saves the show review. */
export function reviewReply(o: { rating: number | null; notes: string | null; skipped?: boolean }): string {
  if (o.skipped) return "Okay, I'll leave the show review. You can add it in the app, on the show.";
  const bits = [o.rating ? `${o.rating}/5` : null, o.notes ? `"${o.notes.length > 80 ? `${o.notes.slice(0, 79)}…` : o.notes}"` : null].filter(Boolean);
  return `Saved the show review: ${bits.join(", ")}. Thanks.`;
}

// ---------------------------------------------------------------- attendance by text ("2 no show", "3 late")

const ATT_WORDS: [RegExp, Attendance][] = [
  [/^(?:no[ -]?show|noshow|didn'?t (?:show|turn) up|did not show(?: up)?|absent)$/, "no_show"],
  [/^(?:late|came late|showed up late|arrived late)$/, "late"],
  [/^(?:cancel(?:l?ed)?|cancelled in advance|dropped(?: out)?)$/, "cancelled"],
  [/^(?:swap(?:ped)?|gave (?:the |their )?spot away|gave away)$/, "swapped"],
];

/**
 * Pull attendance marks out of a reply to the rating question. A part counts only when it is a list number then a plain
 * attendance word ("2 no show", "3 late", "1 cancelled", "4 swapped"); everything else is handed back untouched in `rest`
 * (so "1 4, 2 no show" still rates comic 1). Tags are not read from WhatsApp: they are set in the app.
 * Returns null when no part is an attendance mark.
 */
export function parseAttendanceMarks(text: string, total: number): { marks: Record<number, Attendance>; rest: string } | null {
  const parts = text.trim().toLowerCase().split(/\s*(?:,|;|\n|\band\b|&)\s*/).filter(Boolean);
  const marks: Record<number, Attendance> = {};
  const rest: string[] = [];
  for (const p of parts) {
    const m = p.match(/^#?(\d{1,2})\s*[:=-]?\s*(.+)$/);
    const hit = m ? ATT_WORDS.find(([re]) => re.test(m[2]!.trim())) : undefined;
    const n = m ? Number(m[1]) : 0;
    if (m && hit && n >= 1 && n <= total) marks[n] = hit[1];
    else rest.push(p);
  }
  return Object.keys(marks).length ? { marks, rest: rest.join(", ") } : null;
}
