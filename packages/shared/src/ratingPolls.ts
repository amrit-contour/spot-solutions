// Rating a show by tapping: one WhatsApp poll per comic ("Mohit, how did they do?") and one for the show overall, instead of a
// numbered text the curator types into. A poll's message id maps to a lineup slot (or the show), so a vote on ANY of them, at any
// time inside the window, even a changed vote, sets that slot's rating or attendance. Typed replies ("1 4, 2 no show") still work.
// Also: when rating questions may go out (quiet hours) and how fast (never a burst, e.g. after a restart).
import type { Comic, Lineup } from "./types.ts";
import { cleanNote, mergeReview, type SpotReview } from "./showRatings.ts";
import { POLL_QUESTION_MAX } from "./messages.ts";

// ---------------------------------------------------------------- when to ask

/** Quiet hours for CATCH-UP asks only (a show answered long ago, e.g. found after a restart). Overridable by settings.micCheck.quiet. */
export const QUIET_FROM = "22:30";
export const QUIET_UNTIL = "09:30";
/** A rating ask more than this long after its trigger (the yes) is a catch-up, not an answer to a fresh yes. */
export const CATCH_UP_AFTER_MIN = 12 * 60;
/** Between catch-up asks about different shows. */
export const RATING_ASK_GAP_MS = 20 * 60_000;
/** How long a rating poll keeps counting. */
export const RATING_POLL_TTL_MS = 3 * 86_400_000;

const wallMs = (d: string) => Date.parse(`${d.replace(" ", "T")}:00Z`);

/**
 * Is this ask a catch-up (backlog)? The trigger is the answer: a fresh yes (or no) is never a catch-up. Without a recorded answer time
 * (older lineups, an answer written by the app before this existed) it is measured from when the mic check was due, `micDue`
 * as local "YYYY-MM-DD HH:MM". `now` is the curator's local {date, time}.
 */
export function isCatchUp(l: { outcomeAt?: number | null }, micDue: string, now: { date: string; time: string }, nowMs: number): boolean {
  if (l.outcomeAt) return nowMs - l.outcomeAt > CATCH_UP_AFTER_MIN * 60_000;
  return wallMs(`${now.date} ${now.time}`) - wallMs(micDue) > CATCH_UP_AFTER_MIN * 60_000;
}

export function inQuiet(time: string, q?: { from: string; to: string } | null): boolean {
  const from = q?.from ?? QUIET_FROM;
  const to = q?.to ?? QUIET_UNTIL;
  return from <= to ? time >= from && time < to : time >= from || time < to;
}

/**
 * May a rating question go out right now? A fresh answer always goes at once. Catch-up asks wait out quiet hours ("quiet": sent from the end of them) and go one show at a time
 * with a gap ("spaced"), so a restart that finds several shows due never bursts.
 */
export function ratingAskGate(o: { time: string; nowMs: number; lastAskAt?: number | null; catchUp?: boolean; quiet?: { from: string; to: string } | null }): "go" | "quiet" | "spaced" {
  if (!o.catchUp) return "go";
  if (inQuiet(o.time, o.quiet)) return "quiet";
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
  /** What it asks: a comic's rating (default), "why" the show didn't happen, or whether to "repeat" the lineup next week. */
  kind?: "rate" | "why" | "repeat";
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


// ---------------------------------------------------------------- "didn't happen": what happened, and repeat next week?

/** Used when no model is available (or its answer is unusable). "Other" is always last. */
export const WHY_PRESETS = ["No audience", "Too few comics", "Venue cancelled", "Weather/rain", "Clash/event at venue", "Called off by me", "Other"];
export const REPEAT_OPTIONS = ["Repeat", "Don't repeat", "Not decided"];

/** The model's suggested reasons (an array of short strings), cleaned: 3 to 8, no repeats, "Other" last. Null when unusable (use the presets). */
export function cleanReasonOptions(raw: unknown): string[] | null {
  const list = Array.isArray(raw) ? raw : (raw as { reasons?: unknown } | null)?.reasons;
  if (!Array.isArray(list)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of list) {
    const t = typeof r === "string" ? r.replace(/\s+/g, " ").trim() : "";
    if (!t || t.length > 40 || /^other$/i.test(t) || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.length >= 3 ? [...out.slice(0, 7), "Other"] : null;
}

export function whyPollSpec(showName: string, options: string[] = WHY_PRESETS): RatingPollSpec {
  const q = `What happened at ${showName}?`;
  return { question: q.length <= POLL_QUESTION_MAX ? q : "What happened at the show?", options };
}
export const repeatPollSpec = (): RatingPollSpec => ({ question: "Repeat this lineup next week?", options: [...REPEAT_OPTIONS] });

/** A vote on the repeat poll. Taking it back counts as nothing. */
export function voteRepeat(selected: string[]): "repeat" | "no" | "later" | null {
  return ({ Repeat: "repeat", "Don't repeat": "no", "Not decided": "later" } as const)[selected[0] as "Repeat"] ?? null;
}

/** The note on the show review: the reasons ticked, then the curator's own words. Null when there is neither. */
export function composeNoNotes(reasons: string[] | null | undefined, note: string | null | undefined): string | null {
  const head = reasons?.length ? `Didn't happen: ${reasons.join(", ")}.` : "";
  return cleanNote([head, note ?? ""].filter(Boolean).join(" "), 600);
}

/** "note: rain all day" / "because the venue flooded": a typed note for the question above. Strict, so ordinary messages are never swallowed. */
export function parseNoNote(text: string): string | null {
  const m = text.trim().match(/^(?:note|reason|because|why)\b\s*[:\-–—]?\s*([\s\S]{2,400})$/i);
  return m ? cleanNote(m[1]!, 400) : null;
}

/** The review with the reasons and note applied (kept in the review sheet's notes, so it shows in the app and in show history). */
export const reviewWithNoNotes = (prev: Parameters<typeof mergeReview>[0], reasons: string[] | null | undefined, note: string | null | undefined, at: number) => mergeReview(prev, { notes: composeNoNotes(reasons, note) }, at);

// ---------------------------------------------------------------- repeat next week

/** The slots to put on next week's lineup from this one, or null when next week already has people (or this one has none). Only who and for how long: no ratings, notes, tags or live pills. */
export function repeatSlots(prev: Pick<Lineup, "slots">, next: Pick<Lineup, "slots"> | undefined): { comicId: string; minutes?: number | null }[] | null {
  if (!prev.slots.length || next?.slots.length) return null;
  return prev.slots.map((s) => ({ comicId: s.comicId, ...(s.minutes != null ? { minutes: s.minutes } : {}) }));
}
