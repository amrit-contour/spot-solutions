// Month: a full grid with event chips on desktop, a compact dotted month plus the chosen day's shows on phones.
import { DAY_SHORT } from "@spot/shared";
import { dayNum, fmtDayLong, fmtHour, monthKey, monthWeeks, weekDates, type CalView } from "../../lib/calendarDates";
import { cx } from "@spot/ui";
import { DayEvents } from "./DayView";
import { DayNumber } from "./WeekGrid";
import { EventPopover, NotToldMark, fillOf, pendingCount, toneOf, useCal } from "./shared";

const HEAD = [1, 2, 3, 4, 5, 6, 0] as const;
const MAX_CHIPS = 3;

function Weekdays({ short }: { short?: boolean }) {
  return (
    <div className="grid grid-cols-7" aria-hidden>
      {HEAD.map((d) => (
        <span key={d} className="py-2 text-center type-label-m text-on-surface-variant">
          {short ? DAY_SHORT[d][0] : DAY_SHORT[d]}
        </span>
      ))}
    </div>
  );
}

export function MonthGrid({ date }: { date: string }) {
  const cal = useCal();
  const weeks = monthWeeks(date);
  const month = monthKey(date);
  return (
    <div className="overflow-hidden rounded-lg border border-outline-variant/60 bg-surface-low">
      <div className="border-b border-outline-variant/60">
        <Weekdays />
      </div>
      <div className="grid" style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(7.5rem, auto))` }}>
        {weeks.map((w, wi) => (
          <div key={w} className={cx("grid grid-cols-7", wi > 0 && "border-t border-outline-variant/60")}>
            {weekDates(w).map((d, di) => {
              const evs = cal.eventsOn(d);
              const inMonth = monthKey(d) === month;
              const shown = evs.length > MAX_CHIPS ? evs.slice(0, MAX_CHIPS - 1) : evs;
              const more = evs.length - shown.length;
              return (
                <div key={d} className={cx("flex min-w-0 flex-col gap-1 p-1.5", di > 0 && "border-l border-outline-variant/60", d === cal.today && "bg-primary/[0.07]", !inMonth && "bg-surface-container/40")}>
                  <button
                    type="button"
                    onClick={() => cal.openDay(d)}
                    aria-label={`${fmtDayLong(d)}, ${evs.length ? `${evs.length} show${evs.length > 1 ? "s" : ""}` : "no shows"}. Open day`}
                    className={cx("state-layer -m-0.5 self-start rounded-full p-0.5 focus-visible:outline-offset-0!", !inMonth && "opacity-45")}
                  >
                    <DayNumber date={d} today={cal.today} size={28} />
                  </button>
                  <ul className={cx("flex min-w-0 flex-col gap-1", !inMonth && "opacity-60")}>
                    {shown.map((ev) => {
                      const tone = toneOf(ev, cal.today, cal.loading);
                      return (
                        <li key={ev.key} className="flex min-w-0">
                          <EventPopover ev={ev} anchorClassName="flex min-w-0 flex-1" className={cx("flex min-h-11 w-full min-w-0 flex-col justify-center gap-0.5 rounded-sm bg-surface-container px-1.5 py-1", d < cal.today && tone.id !== "ask" && "opacity-75")}>
                            <span className="w-full truncate type-label-m">{ev.show.name}</span>
                            <span className="flex w-full items-center gap-1 type-label-s tracking-normal text-on-surface-variant">
                              <span aria-hidden className={cx("size-1.5 flex-none rounded-full", tone.bar, tone.dashed && "bg-transparent ring-1 ring-outline ring-inset")} />
                              <span className="min-w-0 flex-1 whitespace-nowrap tabular">{fmtHour(ev.startMin)}</span>
                              <NotToldMark n={pendingCount(ev)} className="size-4" />
                              <span className="flex-none tabular">{fillOf(ev)}</span>
                            </span>
                          </EventPopover>
                        </li>
                      );
                    })}
                  </ul>
                  {more > 0 && (
                    <button type="button" onClick={() => cal.openDay(d)} className="state-layer self-start rounded-sm px-1.5 py-0.5 type-label-m text-primary">
                      +{more} more
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Phones: the whole month at a glance, dots for shows; the selected day's cards sit underneath. */
export function MonthCompact({ date, setDate }: { date: string; setDate: (d: string, v?: CalView) => void }) {
  const cal = useCal();
  const weeks = monthWeeks(date);
  const month = monthKey(date);
  return (
    <div>
      <div className="rounded-lg bg-surface-low px-1 pb-1.5">
        <Weekdays short />
        <div role="grid" aria-label="Month" className="grid grid-cols-7">
          {weeks.flatMap((w) =>
            weekDates(w).map((d) => {
              const evs = cal.eventsOn(d);
              const selected = d === date;
              const isToday = d === cal.today;
              const inMonth = monthKey(d) === month;
              return (
                <button
                  key={d}
                  type="button"
                  role="gridcell"
                  aria-selected={selected}
                  aria-label={`${fmtDayLong(d)}, ${evs.length ? `${evs.length} show${evs.length > 1 ? "s" : ""}` : "no shows"}`}
                  onClick={() => setDate(d)}
                  className={cx("pressable flex h-14 flex-col items-center justify-center gap-1 rounded-md", !inMonth && "opacity-45", selected && "bg-secondary-container")}
                >
                  <span className={cx("grid size-7 place-items-center rounded-full type-label-l tabular", isToday ? "bg-primary text-on-primary" : selected ? "text-on-secondary-container" : "text-on-surface")}>{dayNum(d)}</span>
                  <span aria-hidden className="flex h-1.5 items-center gap-0.5">
                    {evs.slice(0, 3).map((ev) => {
                      const tone = toneOf(ev, cal.today, cal.loading);
                      return <span key={ev.key} className={cx("size-1.5 rounded-full", tone.bar)} />;
                    })}
                  </span>
                </button>
              );
            }),
          )}
        </div>
      </div>
      <h2 className="mt-5 mb-3 type-title-m">{fmtDayLong(date)}</h2>
      <DayEvents date={date} />
    </div>
  );
}
