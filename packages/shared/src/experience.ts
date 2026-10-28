import type { Comic, ExperienceThresholds, ExperienceResult, SpotHistoryEntry } from "./types.ts";

export const DEFAULT_EXPERIENCE_THRESHOLDS: Required<Required<ExperienceThresholds>> = {
  newSpotsMax: 5,
  newbieMonths: 6,
  beginnerYears: 1,
  seniorYears: 3,
  killerMinRating: 4.3,
  killerMinRated: 5,
};

const one = <T extends object>(d: Partial<T>, k: keyof T, v: T[keyof T]): T[keyof T] => (d[k] === undefined ? v : d[k]) as T[keyof T];

function mergeThresholds(t?: ExperienceThresholds): Required<ExperienceThresholds> {
  return {
    newSpotsMax: one(t ?? {}, "newSpotsMax", DEFAULT_EXPERIENCE_THRESHOLDS.newSpotsMax),
    newbieMonths: one(t ?? {}, "newbieMonths", DEFAULT_EXPERIENCE_THRESHOLDS.newbieMonths),
    beginnerYears: one(t ?? {}, "beginnerYears", DEFAULT_EXPERIENCE_THRESHOLDS.beginnerYears),
    seniorYears: one(t ?? {}, "seniorYears", DEFAULT_EXPERIENCE_THRESHOLDS.seniorYears),
    killerMinRating: one(t ?? {}, "killerMinRating", DEFAULT_EXPERIENCE_THRESHOLDS.killerMinRating),
    killerMinRated: one(t ?? {}, "killerMinRated", DEFAULT_EXPERIENCE_THRESHOLDS.killerMinRated),
  };
}

const monthsBetween = (from: Date, to: Date) => (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth()) - (to.getDate() < from.getDate() ? 1 : 0);

// Parse "YYYY" or "YYYY-MM" into a date at its start month. Missing -> null.
export function parseComedySince(raw: string | undefined | null): Date | null {
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec((raw ?? "").trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) - 1 : 0;
  const d = new Date(y, mo, 1);
  return isNaN(d.getTime()) ? null : d;
}

function ratedHistory(h: SpotHistoryEntry[] | undefined): SpotHistoryEntry[] {
  return (h ?? []).filter((x) => typeof x.rating === "number");
}

export function experienceOf(comic: Partial<Pick<Comic, "comedySince" | "history" | "tagsPinned" | "tagsHidden">>, now: Date, thresholds?: ExperienceThresholds | null): ExperienceResult {
  const t = mergeThresholds(thresholds ?? undefined);
  const since = parseComedySince(comic.comedySince);
  const hist = comic.history ?? [];
  const spots = hist.length;
  const months = since ? Math.max(0, monthsBetween(since, now)) : 0;
  const years = since ? months / 12 : 0;
  const rated = ratedHistory(hist).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const average = rated.length ? rated.reduce((s, x) => s + (x.rating as number), 0) / rated.length : null;
  const last5 = rated.slice(0, 5);
  const older5 = rated.slice(5, 10);
  let trend: "up" | "steady" | "down" | null = null;
  if (last5.length >= 3 && older5.length >= 3) {
    const a = last5.reduce((s, x) => s + (x.rating as number), 0) / last5.length;
    const b = older5.reduce((s, x) => s + (x.rating as number), 0) / older5.length;
    trend = a - b > 0.15 ? "up" : b - a > 0.15 ? "down" : "steady";
  }
  // Inactive if the last spot is more than 6 months old. "Inactive since <month>".
  const lastSpot = hist.map((x) => x.date).sort().reverse()[0];
  let inactiveSince: string | null = null;
  if (lastSpot) {
    const ls = new Date(lastSpot);
    if (monthsBetween(ls, now) > 6) inactiveSince = `${["January","February","March","April","May","June","July","August","September","October","November","December"][ls.getMonth()]} ${ls.getFullYear()}`;
  }
  const computed: string[] = [];
  if (spots < t.newSpotsMax || months < t.newbieMonths) computed.push("New");
  if (months < 12 && months >= t.newbieMonths && spots >= t.newSpotsMax) computed.push("Beginner");
  if (since && years >= t.seniorYears) computed.push("Senior");
  if (average !== null && rated.length >= t.killerMinRated && average >= t.killerMinRating) computed.push("Killer");
  // Manual overrides
  const hidden = new Set(comic.tagsHidden ?? []);
  const tags = [...new Set([...(comic.tagsPinned ?? []), ...computed.filter((x) => !hidden.has(x))])];
  return { years: Math.floor(years), months: Math.max(0, Math.floor(months - Math.floor(years) * 12)), spots, rated: rated.length, averageRating: average === null ? null : Math.round(average * 100) / 100, trend, inactiveSince, tags };
}
