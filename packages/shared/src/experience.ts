// A comic's experience, worked out from data instead of a fixed tier: how long they've done comedy (from "doing comedy since",
// so it ticks up by itself), the spots they actually did, their average rating with a trend, and tags (New, Beginner, Senior,
// Killer) the curator can pin or hide. Regular is per show (show.regulars / regularOf), never an experience tag.
import { performed } from "./showRatings.ts";
import type { Comic, ExperienceResult, ExperienceThresholds, SpotHistoryEntry } from "./types.ts";

export const EXPERIENCE_TAGS = ["New", "Beginner", "Senior", "Killer"] as const;

export const DEFAULT_EXPERIENCE_THRESHOLDS: Required<ExperienceThresholds> = {
  newSpotsMax: 5,
  newbieMonths: 6,
  beginnerYears: 1,
  seniorYears: 3,
  killerMinRating: 4.3,
  killerMinRated: 5,
};

/** No spot for this long: "Inactive since <month>" instead of counting the years up. */
const INACTIVE_MONTHS = 6;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function thresholdsOf(t?: ExperienceThresholds | null): Required<ExperienceThresholds> {
  const out = { ...DEFAULT_EXPERIENCE_THRESHOLDS };
  for (const k of Object.keys(out) as (keyof ExperienceThresholds)[]) {
    const v = t?.[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Whole months from `from` to `to` (calendar months, not 30-day blocks). */
const monthsBetween = (from: Date, to: Date) =>
  (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth()) - (to.getUTCDate() < from.getUTCDate() ? 1 : 0);

/** "YYYY" or "YYYY-MM" as the first day of that month (UTC). Anything else: null. */
export function parseComedySince(raw: string | undefined | null): Date | null {
  const m = /^(\d{4})(?:-(\d{1,2}))?$/.exec((raw ?? "").trim());
  if (!m) return null;
  const mo = m[2] ? Number(m[2]) - 1 : 0;
  if (mo < 0 || mo > 11) return null;
  return new Date(Date.UTC(Number(m[1]), mo, 1));
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Spots they actually did: confirmed, on or before today, and they turned up. */
export function doneSpots(history: SpotHistoryEntry[] | undefined, now: Date): SpotHistoryEntry[] {
  const today = isoDay(now);
  return (history ?? []).filter((h) => h.status === "confirmed" && h.date <= today && performed(h.attendance));
}

/** Spots per calendar year, oldest year first, with empty years in between kept (so a break shows as a gap). */
export function spotsByYear(history: SpotHistoryEntry[] | undefined, now: Date): { year: number; spots: number }[] {
  const counts = new Map<number, number>();
  for (const h of doneSpots(history, now)) {
    const y = Number(h.date.slice(0, 4));
    if (Number.isFinite(y)) counts.set(y, (counts.get(y) ?? 0) + 1);
  }
  if (!counts.size) return [];
  const years = [...counts.keys()];
  const out: { year: number; spots: number }[] = [];
  for (let y = Math.min(...years); y <= Math.max(...years); y++) out.push({ year: y, spots: counts.get(y) ?? 0 });
  return out;
}

const avg = (xs: SpotHistoryEntry[]) => xs.reduce((s, x) => s + (x.rating as number), 0) / xs.length;

export function experienceOf(comic: Partial<Pick<Comic, "comedySince" | "history" | "tagsPinned" | "tagsHidden">>, now: Date, thresholds?: ExperienceThresholds | null): ExperienceResult {
  const t = thresholdsOf(thresholds);
  const since = parseComedySince(comic.comedySince);
  const done = doneSpots(comic.history, now).sort((a, b) => b.date.localeCompare(a.date));
  const spots = done.length;
  const months = since ? Math.max(0, monthsBetween(since, now)) : null;

  // Ratings, newest first; the trend compares the last 5 rated shows with the 5 before them.
  const rated = done.filter((h) => typeof h.rating === "number");
  const averageRating = rated.length ? Math.round(avg(rated) * 100) / 100 : null;
  const recent = rated.slice(0, 5);
  const before = rated.slice(5, 10);
  let trend: ExperienceResult["trend"] = null;
  if (recent.length >= 3 && before.length >= 3) {
    const diff = avg(recent) - avg(before);
    trend = diff > 0.15 ? "up" : diff < -0.15 ? "down" : "steady";
  }

  const last = done[0]?.date;
  const lastDate = last ? new Date(`${last}T00:00:00Z`) : null;
  const inactiveSince = lastDate && monthsBetween(lastDate, now) > INACTIVE_MONTHS ? `${MONTHS[lastDate.getUTCMonth()]} ${lastDate.getUTCFullYear()}` : null;

  // Without a "comedy since" date only the spot count speaks; the years-based tags need the date.
  const computed: string[] = [];
  // Nothing known at all (no spots, no start date): no tag rather than a guess.
  const isNew = (months !== null || spots > 0) && (spots < t.newSpotsMax || (months !== null && months < t.newbieMonths));
  if (isNew) computed.push("New");
  else if (months !== null && months < t.beginnerYears * 12) computed.push("Beginner");
  if (months !== null && months >= t.seniorYears * 12) computed.push("Senior");
  if (averageRating !== null && rated.length >= t.killerMinRated && averageRating >= t.killerMinRating) computed.push("Killer");

  const hidden = new Set(comic.tagsHidden ?? []);
  const tags = [...new Set([...(comic.tagsPinned ?? []), ...computed.filter((x) => !hidden.has(x))])];
  return {
    years: months === null ? 0 : Math.floor(months / 12),
    months: months === null ? 0 : months % 12,
    known: months !== null,
    spots,
    rated: rated.length,
    averageRating,
    trend,
    inactiveSince,
    tags,
    computed,
  };
}

/** "3 yrs 2 mo", "8 months", or null when they haven't said. */
export function experienceLabel(e: Pick<ExperienceResult, "years" | "months" | "known">): string | null {
  if (!e.known) return null;
  if (!e.years) return `${e.months} month${e.months === 1 ? "" : "s"}`;
  return `${e.years} yr${e.years === 1 ? "" : "s"}${e.months ? ` ${e.months} mo` : ""}`;
}
