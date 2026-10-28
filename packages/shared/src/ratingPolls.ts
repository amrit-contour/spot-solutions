// Rating a show by tapping: one WhatsApp poll per comic ("Mohit, how did they do?") and one for the show overall, instead of a
// numbered text the curator types into. A poll's message id maps to a lineup slot (or the show), so a vote on ANY of them, at any
// time inside the window, even a changed vote, sets that slot's rating or attendance. Typed replies ("1 4, 2 no show") still work.
// Also: when rating questions may go out (quiet hours) and how fast (never a burst, e.g. after a restart).
import type { Comic, Lineup } from "./types.ts";
import type { SpotReview } from "./showRatings.ts";
import { POLL_QUESTION_MAX } from "./messages.ts";

// ---------------------------------------------------------------- when to ask

/** No rating question between these local times; whatever is due waits for RATING_ASK_RELEASE. */
export const QUIET_FROM = "22:30";
export const QUIET_UNTIL = "09:00";
export const RATING_ASK_RELEASE = "09:30";
/** After asking about one show, wait this long before the next show's questions (a restart with two shows due never bursts). */
export const RATING_ASK_GAP_MS = 20 * 60_000;
/** How long a rating poll keeps counting. */
export const RATING_POLL_TTL_MS = 3 * 86_400_000;

export const inQuietHours = (time: string): boolean => time >= QUIET_FROM || time < QUIET_UNTIL;

/**
 * May a rating question go out right now? "quiet": it is the middle of the night (it is sent from RATING_ASK_RELEASE on, because
 * nothing is marked asked until it is actually sent); "spaced": another show was asked about less than the gap ago; "go".
 */
export function ratingAskGate(o: { time: string; nowMs: number; lastAskAt?: number | null }): "go" | "quiet" | "spaced" {
  if (o.time >= QUIET_FROM || o.time < RATING_ASK_RELEASE) return "quiet";
  if (o.lastAskAt && o.nowMs - o.lastAskAt < RATING_ASK_GAP_MS) return "spaced";
  return "go";
}

// ---------------------------------------------------------------- the polls

/** The options of a per-comic poll (multi-select): five ratings, then "Late" and "No-show". */
export const RATING_LABELS: { label: string; rating: number }[] = [
  { label: "5 Killed it", rating: 5 },
  { label: "4 Good", rating: 4 },
  { label: "3 OK", rating: 3 },
  { label: "2 Rough", rating: 2 },
  { label: "1 Bombed", rating: 1 },
];
export const LATE_LABEL = "Late";
export const NO_SHOW_LABEL = "No-show";
export const RATING_POLL_OPTIONS: string[] = [...RATING_LABELS.map((r) => r.label), LATE_LABEL, NO_SHOW_LABEL];

export const OVERALL_POLL_OPTIONS: { label: string; rating: number | null }[] = [
  { label: "5 Great", rating: 5 },
  { label: "4 Good", rating: 4 },
  { label: "3 OK", rating: 3 },
  { label: "2 Rough", rating: 2 },
  { label: "1 Bad", rating: 1 },
  { label: "Skip", rating: null },
];

export interface RatingPollSpec {
  question: string;
  options: string[];
}

/** "Mohit Comic BLR, how did they do?" */
export function ratingPollSpec(name: string): RatingPollSpec {
  const n = name.replace(/\s+/g, " ").trim() || "This comic";
  const q = `${n}, how did they do?`;
  return { question: q.length <= POLL_QUESTION_MAX ? q : `${n.slice(0, POLL_QUESTION_MAX - 22)}…, how did they do?`, options: [...RATING_POLL_OPTIONS] };
}

export function overallPollSpec(showName: string): RatingPollSpec {
  const q = `How was ${showName} overall?`;
  return { question: q.length <= POLL_QUESTION_MAX ? q : "How was the show overall?", options: OVERALL_POLL_OPTIONS.map((o) => o.label) };
}

/**
 * What a vote on a per-comic multi-select poll records, from everything ticked now (the whole set is read on every update, so a
 * changed vote replaces the old one). No-show wins (and clears the rating); else the highest rating ticked, with Late marking
 * attendance late; a rating alone means they showed up; nothing ticked clears both. `multiple`: several ratings were ticked.
 */
export function voteReview(selected: string[]): { review: SpotReview; multiple: boolean } {
  const ratings = RATING_LABELS.filter((r) => selected.includes(r.label)).map((r) => r.rating);
  if (selected.includes(NO_SHOW_LABEL)) return { review: { attendance: "no_show", rating: null }, multiple: false };
  const rating = ratings.length ? Math.max(...ratings) : null;
  return { review: { rating, attendance: selected.includes(LATE_LABEL) ? "late" : null }, multiple: ratings.length > 1 };
}

/** What a vote on the overall poll means: a rating, "skip", or nothing. */
export function voteOverall(selected: string[]): { rating: number } | { skip: true } | null {
  const hit = OVERALL_POLL_OPTIONS.find((o) => o.label === selected[0]);
  if (!hit) return null;
  return hit.rating === null ? { skip: true } : { rating: hit.rating };
}

/** The comics to ask about for a lineup: everyone who still needs a rating (the curator is a comic too). Same indexes as the lineup's slots. */
export function slotsToRate(l: Pick<Lineup, "slots">, comics: Map<string, Comic>): { n: number; comicId: string; name: string }[] {
  return l.slots
    .map((s, i) => ({ s, n: i + 1 }))
    .filter(({ s }) => !(s.rating != null && s.rating >= 1) && s.attendance !== "no_show" && s.attendance !== "cancelled" && s.attendance !== "swapped")
    .map(({ s, n }) => ({ n, comicId: s.comicId, name: comics.get(s.comicId)?.name ?? "A comic" }));
}

// ---------------------------------------------------------------- remembering which poll is which

/** What one of the agent's rating polls rates (comicId null: the show overall). Kept in the agent's memory for RATING_POLL_TTL_MS. */
export interface RatingPollRef {
  /** The poll's WhatsApp message id. */
  id: string;
  lineupId: string;
  comicId: string | null;
  at: number;
}
const RATING_POLL_CAP = 200;

/** The list with these polls added and expired (or beyond-cap oldest) ones dropped. A re-added id replaces the old entry. */
export function addRatingPolls(list: RatingPollRef[] | undefined, added: RatingPollRef[], now: number): RatingPollRef[] {
  const ids = new Set(added.map((r) => r.id));
  return [...(list ?? []).filter((r) => !ids.has(r.id)), ...added].filter((r) => now - r.at < RATING_POLL_TTL_MS).slice(-RATING_POLL_CAP);
}

/** The reference for a poll id when it is still inside its window. */
export function ratingPollRef(list: RatingPollRef[] | undefined, pollId: string, now: number): RatingPollRef | null {
  const r = list?.find((x) => x.id === pollId);
  return r && now - r.at < RATING_POLL_TTL_MS ? r : null;
}

/** The message above a lineup's polls. `label` is how each comic is written (an @mention placeholder, or a plain name). */
export function ratingHeader(o: { showName: string; dateLabel: string; rows: { n: number; label: string }[] }): string {
  const ex = o.rows.slice(0, 2).map((r, i) => `${r.n} ${[4, 5][i]}`).join(", ") || "1 4";
  return [`🎤 How did everyone do at *${o.showName}* (${o.dateLabel})? Tap a poll for each:`, o.rows.map((r) => `${r.n}. ${r.label}`).join("\n"), `Prefer typing? *${ex}*, *2 no show*, *3 late* or *skip*.`].join("\n");
}
