// Which lineup week the curator is working on right now. A week stays current through the day of its last show, counting
// what actually happens this week (a one-off date added for an inactive show counts, a skipped date doesn't), then rolls to
// next week. The app (Home, Requests, Lineup) and the worker (request weeks, agent, retention) both use this, so they agree.
import { isShowOn } from "./rules.ts";
import type { Show } from "./types.ts";
import { dateInWeek, rolloverDayFor, shiftWeek, weekOf } from "./week.ts";

type ShowLike = Pick<Show, "active" | "weekday" | "activeDates" | "pausedDates">;

/** Today's date (YYYY-MM-DD) in `timeZone`. */
function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** The last date (YYYY-MM-DD) in the Monday-keyed `week` on which any show is on, or null when none is. */
export function lastShowDate(shows: readonly ShowLike[], week: string): string | null {
  let last: string | null = null;
  for (let i = 0; i < 7; i++) {
    const date = dateInWeek(week, ((i + 1) % 7) as Show["weekday"]);
    if (shows.some((s) => isShowOn(s, date))) last = date;
  }
  return last;
}

/**
 * The Monday key of the week being curated at `at`. This calendar week while its last show is today or later; next week once
 * it's over (or when nothing is on this week). With no shows set up at all it falls back to the old Wednesday rollover.
 */
export function curationWeek(at: Date, timeZone: string, shows: readonly ShowLike[]): string {
  if (!shows.length) return weekOf(at, timeZone, rolloverDayFor([]));
  const week = weekOf(at, timeZone, 1);
  const last = lastShowDate(shows, week);
  return last && last >= localDate(at, timeZone) ? week : shiftWeek(week, 1);
}
