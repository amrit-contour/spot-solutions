import { Link, useNavigate } from "react-router-dom";
import { alertDayLabel, clashNote, localDate, timeLeft, timesShort } from "@spot/shared";
import { Button, IconBell, IconSend } from "@spot/ui";
import { TZ, splitAlerts, useClock, useMySpotList, useSpotAlerts, useWatchedGroups } from "../lib/alerts";

/**
 * "Open spots now": offers from your watched groups that you can still take, soonest to end first, each with Ask for it.
 * Mount it on the Today page: `<OpenSpotsNow uid={uid} />`. Shows nothing while there is nothing open (pass `showEmpty` to say so).
 */
export function OpenSpotsNow({ uid, max = 3, showEmpty }: { uid: string; max?: number; showEmpty?: boolean }) {
  const nav = useNavigate();
  const alerts = useSpotAlerts(uid);
  const spots = useMySpotList(uid);
  const groups = useWatchedGroups(uid);
  const now = useClock();
  const today = localDate(new Date(now), TZ);
  const { open } = splitAlerts(alerts.data, now);
  if (alerts.loading) return null;
  if (!open.length) {
    if (!showEmpty) return null;
    return (
      <section aria-label="Open spots now" className="flex min-w-0 items-center gap-3 rounded-lg bg-surface-low p-4">
        <IconBell aria-hidden className="icon size-5 flex-none text-on-surface-variant" />
        <p className="min-w-0 flex-1 type-body-m text-on-surface-variant">
          {groups.data.length ? "No spots on offer right now. You'll be notified." : "Pick the groups to watch and offered spots show up here."}
        </p>
        <Link to={groups.data.length ? "/alerts" : "/groups"} className="type-label-l text-primary">
          {groups.data.length ? "Alerts" : "Pick groups"}
        </Link>
      </section>
    );
  }
  return (
    <section aria-label="Open spots now" className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="type-title-m">Open spots now</h2>
        {open.length > max && (
          <Link to="/alerts" className="type-label-l text-primary">
            All {open.length}
          </Link>
        )}
      </div>
      <ul className="flex flex-col gap-2">
        {open.slice(0, max).map((a) => {
          const clash = clashNote(a, spots.data);
          return (
            <li key={a.id} className="flex min-w-0 items-center gap-3 rounded-lg bg-surface-low p-3 pl-4">
              <Link to={`/alerts?alert=${encodeURIComponent(a.id)}`} className="min-w-0 flex-1">
                <span className="block truncate type-title-s">{a.roomName ?? "A room"}</span>
                <span className="block truncate type-body-s text-on-surface-variant">
                  {alertDayLabel(a.date, today)}
                  {a.times.length ? ` · ${timesShort(a.times)}` : ""} · {timeLeft(a.expiresAt, now)}
                  {clash || a.clash ? " · clashes" : ""}
                </span>
              </Link>
              <Button size="sm" icon={IconSend} onClick={() => nav(`/alerts?alert=${encodeURIComponent(a.id)}&ask=1`)}>
                Ask
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
