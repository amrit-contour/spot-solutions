// "Did the mic happen?" is due a set time after the show starts (default 2 hours). Until then nothing is asked; after it, the question
// stays pending in the app until answered.
import { useEffect, useState } from "react";
import { localNow, micCheckDue, micDelayHours, type Lineup, type Show } from "@spot/shared";
import { useApp } from "./app";

/** A clock that moves every 30 seconds, so a card that becomes due appears without a reload. */
export function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Is this lineup's mic check due right now (confirmed, started + delay passed, not answered)? */
export function useMicDue(): (lineup: Lineup | undefined | null, show: Show | undefined) => boolean {
  const { settings } = useApp();
  const now = localNow(new Date(useClock()), settings.timezone);
  const hours = micDelayHours(settings.micCheck);
  return (lineup, show) => Boolean(lineup && micCheckDue(lineup, show, now, hours));
}
