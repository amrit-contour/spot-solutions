// A list of days with their shows: the Week view on phones, and "the next 7 days" in the Day view.
import { formatTime } from "@spot/shared";
import { fmtDayShort } from "../../lib/calendarDates";
import { useApp } from "../../lib/app";
import { cx } from "@spot/ui";
import { IconMap } from "@spot/ui";
import { EventPopover, NotToldMark, fillOf, pendingCount, toneOf, useCal } from "./shared";

export function Agenda({ dates, label }: { dates: string[]; label: string }) {
  const cal = useCal();
  const { venues } = useApp();
  return (
    <ol aria-label={label} className="flex flex-col">
      {dates.map((d) => {
        const evs = cal.eventsOn(d);
        const isToday = d === cal.today;
        return (
          <li key={d} className={cx("border-b border-outline-variant/40 py-2.5 last:border-b-0", d < cal.today && "opacity-70")}>
            <div className="flex min-h-8 items-center gap-2">
              <button type="button" onClick={() => cal.openDay(d)} className={cx("state-layer -ml-2 rounded-full px-2 py-1 type-title-s", isToday ? "text-primary" : "text-on-surface")}>
                {fmtDayShort(d)}
              </button>
              {isToday && <span className="rounded-sm bg-primary px-1.5 type-label-s leading-4 text-on-primary">Today</span>}
              {!evs.length && <span className="ml-auto type-body-s text-on-surface-variant/70">No shows</span>}
            </div>
            {evs.length > 0 && (
              <ul className="mt-1 flex flex-col gap-1.5">
                {evs.map((ev) => {
                  const tone = toneOf(ev, cal.today, cal.loading);
                  const venue = venues.find((v) => v.id === ev.show.venueId);
                  return (
                    <li key={ev.key} className="flex">
                      <EventPopover ev={ev} anchorClassName="relative flex min-w-0 flex-1" className="relative flex min-h-16 w-full min-w-0 items-center gap-3 overflow-hidden rounded-md bg-surface-low py-2.5 pr-3 pl-4">
                        <span aria-hidden className={cx("absolute inset-y-0 left-0 w-1", tone.bar)} />
                        <span className="w-14 flex-none type-label-m text-on-surface-variant tabular">{formatTime(ev.show.startTime)}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate type-title-s">{ev.show.name}</span>
                          {venue && (
                            <span className="mt-0.5 flex items-center gap-1 type-body-s text-on-surface-variant">
                              <IconMap className="icon size-3.5 flex-none" />
                              <span className="truncate">{venue.name}</span>
                            </span>
                          )}
                        </span>
                        <span className="flex flex-none flex-col items-end gap-1">
                          <span className="flex items-center gap-1">
                            <NotToldMark n={pendingCount(ev)} />
                            <span className={cx("inline-flex h-5 items-center rounded-sm px-1.5 type-label-m whitespace-nowrap", tone.block)}>{tone.label}</span>
                          </span>
                          <span className="type-label-m text-on-surface-variant tabular">{fillOf(ev)}</span>
                        </span>
                      </EventPopover>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
