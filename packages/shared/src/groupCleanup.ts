// After-show group cleanup: the day after a mic, thank the group and clear it for next week's comics. POCs, regulars,
// co-hosts, admins, you, and anyone already on next week's lineup stay. If the mic didn't happen (or the curator wants to
// decide each time), it asks first: the same comics may be repeating next week. Pure rules; the worker runs them.
import { addDays } from "./groupPosts.ts";
import { diffGroup } from "./groupSync.ts";
import type { MessageOverride } from "./messages.ts";
import type { Lineup, Show } from "./types.ts";

export interface GroupCleanup {
  enabled: boolean;
  /** auto: clear it when the mic happened, ask when it didn't. ask: always ask first. */
  mode: "auto" | "ask";
  /** Local time on the day after the show, "HH:MM". */
  time: string;
  /** The message sent before clearing. Missing: the "After the show" template in Settings → Messages. Empty string: none. */
  message?: MessageOverride | null;
}

export const DEFAULT_CLEANUP: GroupCleanup = { enabled: false, mode: "auto", time: "11:00" };

/** What happened with one lineup's cleanup. Written by the worker (and by the curator's answer). */
export interface LineupCleanup {
  status: "asked" | "done" | "kept" | "skipped";
  at: number;
  removed?: number;
  failed?: number;
  /** Why it asked: the mic didn't happen, or the show is set to ask every time. */
  reason?: "canned" | "ask";
}

/** Past this many days after the show, a cleanup that never ran is dropped (a server that was off for a week). */
export const CLEANUP_WINDOW_DAYS = 3;

export type CleanupStep = "run" | "ask" | "skip";

/**
 * What to do now for this lineup, or null for nothing yet. `micCheckOn`: without mic checks there's never an answer, so a
 * confirmed show counts as having happened.
 */
export function cleanupStep(
  show: Pick<Show, "groupId" | "cleanup" | "active">,
  lineup: Pick<Lineup, "date" | "status" | "outcome" | "cleanup"> & { backfilled?: boolean },
  now: { date: string; time: string },
  micCheckOn: boolean,
): CleanupStep | null {
  const c = show.cleanup;
  if (lineup.backfilled) return null; // a past show recorded afterwards: the group was never ours to clear
  if (!c?.enabled || !show.groupId || !lineup.date || lineup.cleanup) return null;
  if (lineup.status !== "confirmed" && lineup.status !== "canned") return null;
  const day = addDays(lineup.date, 1);
  if (now.date < day || (now.date === day && now.time < c.time)) return null;
  if (now.date > addDays(lineup.date, CLEANUP_WINDOW_DAYS)) return "skip";
  const off = lineup.outcome === "canned" || lineup.status === "canned";
  if (off) return "ask";
  const happened = lineup.outcome === "happened" || (!micCheckOn && lineup.status === "confirmed");
  if (!happened) return null; // waiting for the mic check answer
  return c.mode === "auto" ? "run" : "ask";
}

/** Who leaves the group: everyone except POCs, regulars, co-hosts, admins, you, and next week's lineup. */
export function cleanupRemovals(
  participants: { id: string; isAdmin: boolean }[],
  show: Pick<Show, "regulars" | "protected" | "pocs">,
  self: string,
  nextWeek: string[],
): string[] {
  return diffGroup({ participants, confirmed: nextWeek, regulars: show.regulars ?? [], protected: [...(show.protected ?? []), ...(show.pocs ?? [])], self }).toRemove;
}
