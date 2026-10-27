// "Did the mic happen?" timing and "how did they do?" ratings.
//   - The mic check is due a fixed time after the show STARTS (default 2 hours), not "the morning after".
//   - After a yes, the agent lists the lineup and the curator rates each comic 1-5 by text ("1 4, 2 5, 3 3"). The same rating can be
//     given or changed in the app. It lives on the lineup slot and on the comic's spot history entry, so it outlives the lineup.
import type { Lineup, Show, Slot, SpotHistoryEntry } from "./types.ts";
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
  return slots.map((s, i) => ({ n: i + 1, comicId: s.comicId, rating: s.rating })).filter((x) => !isRating(x.rating)).map(({ n, comicId }) => ({ n, comicId }));
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
    `Reply with the number and the rating, like *${example}*${left.length > 1 ? `, or just *${left.slice(0, 3).map((_, i) => [4, 5, 3][i]).join(" ")}* in order` : ""}. *skip* leaves it for the app.`,
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
export function ratingReply(o: { saved: { name: string; rating: number }[]; left: { n: number; name: string }[]; skipped?: boolean }): string {
  if (o.skipped) return "Okay, I'll leave the ratings. You can rate them in the app, on the show or in each comic's spot history.";
  const got = o.saved.length ? `Saved: ${o.saved.map((s) => `${s.name} ${s.rating}/5`).join(", ")}.` : "I didn't get a rating from that.";
  if (!o.left.length) return `${got} That's everyone, thanks.`;
  return `${got} Still to rate: ${o.left.map((l) => `${l.n}. ${l.name}`).join(", ")}. Reply like *${o.left[0]!.n} 4*, or *skip*.`;
}
