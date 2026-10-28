// Tags on a spot request. Two kinds, kept apart on purpose:
// - app facts: worked out from the curator's own data, never guessed (factTags below)
// - Gemma's reading: a fixed set of labels the model may attach, validated in the worker (INTENT_TAGS)
import { shiftWeek } from "./week.ts";
import { showsLastWeekMarker } from "./showRegulars.ts";
import type { Comic, IntentTag, Show, Tier } from "./types.ts";

export const INTENT_TAGS: readonly IntentTag[] = ["new_material", "flexible_days", "specific_time", "longer_set", "travelling", "bringing_audience", "first_time_here"];

export const INTENT_TAG_LABEL: Record<IntentTag, string> = {
  new_material: "New material",
  flexible_days: "Flexible",
  specific_time: "Wants a time",
  longer_set: "Longer set",
  travelling: "Travelling",
  bringing_audience: "Bringing people",
  first_time_here: "First time here",
};

/** What each tag means, for the model prompt. */
export const INTENT_TAG_HELP: Record<IntentTag, string> = {
  new_material: "they say they want to try new jokes or a new bit",
  flexible_days: "they say any day or several days work",
  specific_time: "they ask for an early or a late slot",
  longer_set: "they ask for more than the usual set length",
  travelling: "they say they are visiting or passing through the city",
  bringing_audience: "they say they are bringing people to watch",
  first_time_here: "they explicitly say it is their first time at this mic",
};

export type FactTagId = "new_to_you" | "performed_last_week" | "regular" | "co_host" | "spots";

export interface FactTag {
  id: FactTagId;
  label: string;
}

/** Past spots actually done: confirmed, on or before today. */
export function pastSpotCount(history: Comic["history"], today: string) {
  return history?.filter((h) => h.status === "confirmed" && h.date <= today).length ?? 0;
}

export interface FactInput {
  comic?: Pick<Comic, "id" | "tier" | "history" | "lastPerformedWeek"> | null;
  /** Shows that carry regulars / protected lists. */
  shows: (Pick<Show, "regulars" | "protected"> & { id?: string })[];
  week: string;
  today: string;
  /** Worker stamp: this request created the comic (they weren't on the roster before). */
  firstContact?: boolean;
  /** Worker stamp: requests this comic made in earlier weeks. */
  priorRequests?: number;
}

export const isNewToYou = (i: Pick<FactInput, "comic" | "firstContact" | "priorRequests">) =>
  Boolean(i.firstContact) || !i.comic || (!i.comic.history?.length && !i.comic.lastPerformedWeek && !i.priorRequests);

/** Facts the app knows about a sender, as pills. Pure: same input, same tags. */
export function factTags(i: FactInput): FactTag[] {
  const out: FactTag[] = [];
  const c = i.comic;
  if (isNewToYou(i)) out.push({ id: "new_to_you", label: "New to you" });
  // Regulars repeat anyway: no marker for them.
  if (showsLastWeekMarker(c, i.shows, shiftWeek(i.week, -1))) out.push({ id: "performed_last_week", label: "Performed last week" });
  if (c && (c.tier === "regular" || i.shows.some((s) => s.regulars?.includes(c.id)))) out.push({ id: "regular", label: "Regular" });
  if (c && i.shows.some((s) => s.protected?.includes(c.id))) out.push({ id: "co_host", label: "Co-host" });
  const n = pastSpotCount(c?.history, i.today);
  if (n > 0) out.push({ id: "spots", label: `Spots: ${n}` });
  return out;
}

export interface SenderFacts {
  onRoster: boolean;
  savedName: string | null;
  pastSpots: number;
  lastSpotDate: string | null;
  tier: Tier;
  performedLastWeek: boolean;
  priorRequests: number;
}

/** Facts passed to the model about the sender. Only what the app knows. */
export function senderFacts(i: { comic?: Comic | null; week: string; today: string; priorRequests?: number }): SenderFacts {
  const c = i.comic;
  const done = c?.history?.filter((h) => h.status === "confirmed" && h.date <= i.today) ?? [];
  return {
    onRoster: Boolean(c),
    savedName: c && (c.nameSource === "contact" || c.nameSource === "manual") ? c.name : null,
    pastSpots: done.length,
    lastSpotDate: done[0]?.date ?? null,
    tier: c?.tier ?? "open",
    performedLastWeek: Boolean(c?.lastPerformedWeek && c.lastPerformedWeek === shiftWeek(i.week, -1)),
    priorRequests: i.priorRequests ?? 0,
  };
}
