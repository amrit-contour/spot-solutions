// Regular spots in the comic app: the computed occurrences merged into the spots, and the actions on one (mark, skip, notes).
// A mySpots doc is written only when the comic interacts with an occurrence (id = reg_{regularId}_{date}, so it is idempotent).
import { useCallback, useMemo } from "react";
import { materializeRegular, mergeRegulars, regularWindow, type CalendarSpot, type MySpot } from "@spot/shared";
import { useAsks } from "./asks";

export const newRegularId = () => `reg${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Every spot: stored ones plus the regulars' occurrences from 60 days back to 45 ahead (what stats, clashes and the to-check list read). */
export function useAllSpots(today: string): CalendarSpot[] {
  const { spots, regulars } = useAsks();
  return useMemo(() => {
    const w = regularWindow(today);
    return mergeRegulars(spots, regulars, w.from, w.to);
  }, [spots, regulars, today]);
}

/** The spots (and skipped-regular placeholders) shown on the calendar over [from, to]. */
export function useSpotsBetween(from: string, to: string): CalendarSpot[] {
  const { spots, regulars } = useAsks();
  return useMemo(() => mergeRegulars(spots, regulars, from, to, true), [spots, regulars, from, to]);
}

/** What can be done to a spot on the calendar, computed or stored. */
export function useSpotActions() {
  const store = useAsks();
  const save = useCallback((spot: CalendarSpot) => store.saveSpot(materializeRegular(spot)), [store]);
  const rule = useCallback((id?: string) => store.regulars.find((r) => r.id === id), [store.regulars]);
  const setSkipped = useCallback(
    async (spot: Pick<MySpot, "regularId" | "date">, skip: boolean) => {
      const r = rule(spot.regularId);
      if (!r) return;
      const rest = (r.skipped ?? []).filter((d) => d !== spot.date);
      await store.saveRegular({ ...r, skipped: skip ? [...rest, spot.date].sort() : rest });
    },
    [rule, store],
  );
  return {
    save,
    mark: (spot: CalendarSpot, happened: boolean) => save({ ...spot, happened }),
    skip: (spot: Pick<MySpot, "regularId" | "date">) => setSkipped(spot, true),
    unskip: (spot: Pick<MySpot, "regularId" | "date">) => setSkipped(spot, false),
    rule,
  };
}

