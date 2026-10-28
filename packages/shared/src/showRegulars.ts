// Who counts as a regular of a show, and the one place that decides whether a "performed last week" marker applies.
// Regulars repeat from last week anyway, so the marker (and any "send them to the back" ranking) is for everyone else.
import type { Comic, Show } from "./types.ts";

type ComicLike = Pick<Comic, "id" | "tier" | "regularOf">;
type ShowLike = Pick<Show, "regulars"> & { id?: string };

/** A regular of THIS show: on its regulars list, or tier regular with this show in their shows. */
export function isRegularOf(comic: ComicLike | null | undefined, show: ShowLike | null | undefined): boolean {
  if (!comic || !show) return false;
  return Boolean(show.regulars?.includes(comic.id) || (comic.tier === "regular" && (show.id !== undefined && comic.regularOf?.includes(show.id))));
}

/** A regular of any of these shows (for places that aren't about one show: Waiting, Requests, Comics). */
export const isRegularOfAny = (comic: ComicLike | null | undefined, shows: ShowLike[]): boolean => shows.some((s) => isRegularOf(comic, s));

/**
 * Show the "performed last week" marker, or rank them down for it? Only when they did play last week and they aren't a regular
 * of `show` (pass the shows to check as a list when there is no single show).
 */
export function showsLastWeekMarker(comic: (ComicLike & Pick<Comic, "lastPerformedWeek">) | null | undefined, show: ShowLike | ShowLike[] | null | undefined, lastWeek: string | undefined): boolean {
  if (!comic || !lastWeek || comic.lastPerformedWeek !== lastWeek) return false;
  if (Array.isArray(show)) return !isRegularOfAny(comic, show);
  return !isRegularOf(comic, show);
}
