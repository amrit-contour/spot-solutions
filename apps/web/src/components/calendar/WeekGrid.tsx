// Week on a time grid: seven dated columns, an hour rail trimmed to the evenings shows actually run in,
// and each show as a tinted block sitting at its start time. Days without shows stay in the grid, just empty.
import { DAY_SHORT, formatTime } from "@spot/shared";
import { dayNum, fmtDayLong, fmtHour, weekDates, weekdayOf } from "../../lib/calendarDates";
import { cx } from "../ui";
import { EventPopover, NotToldMark, fillOf, pendingCount, toneOf, useCal, type CalEvent } from "./shared";

const HOUR = 72; // px per hour
const RAIL = 48; // px, the hour labels
const COLS = `${RAIL}px repeat(7, minmax(0, 1fr))`;

/** Shows that overlap in time sit side by side: each gets a lane and the width of its busiest neighbourhood. */
function layout(evs: CalEvent[]) {
  const out: { ev: CalEvent; lane: number; lanes: number }[] = [];
  let cluster: { ev: CalEvent; lane: number }[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((c) => c.lane + 1));
    cluster.forEach((c) => out.push({ ...c, lanes }));
    cluster = [];
  };
  for (const ev of [...evs].sort((a, b) => a.startMin - b.startMin)) {
    if (cluster.length && ev.startMin >= clusterEnd) flush();
    const taken = new Set(cluster.filter((c) => c.ev.endMin > ev.startMin).map((c) => c.lane));
    let lane = 0;
    while (taken.has(lane)) lane++;
    cluster.push({ ev, lane });
    clusterEnd = Math.max(clusterEnd, ev.endMin);
  }
  flush();
  return out;
}

export function DayNumber({ date, today, size = 32 }: { date: string; today: string; size?: number }) {
  return (
    <span
      style={{ width: size, height: size }}
      className={cx("grid flex-none place-items-center rounded-full type-title-m tabular", date === today ? "bg-primary text-on-primary" : "text-on-surface")}
    >
      {dayNum(date)}
    </span>
  );
}

export function WeekGrid({ monday }: { monday: string }) {
  const cal = useCal();
  const dates = weekDates(monday);
  const perDay = dates.map((d) => cal.eventsOn(d));
  const all = perDay.flat();
  const lo = all.length ? Math.min(...all.map((e) => e.startMin)) : 18 * 60;
  const hi = all.length ? Math.max(...all.map((e) => e.endMin)) : 22 * 60;
  let startH = Math.max(0, Math.floor(lo / 60) - 1);
  let endH = Math.min(24, Math.ceil(hi / 60) + 1);
  // Never a thin sliver: at least six hours, padded after the last show first.
  while (endH - startH < 6) {
    if (endH < 24) endH++;
    else if (startH > 0) startH--;
    else break;
  }
  const height = (endH - startH) * HOUR;
  const y = (min: number) => ((min - startH * 60) / 60) * HOUR;
  const lines = { backgroundImage: "linear-gradient(color-mix(in srgb, var(--md-sys-color-outline-variant) 55%, transparent) 0 1px, transparent 1px)", backgroundSize: `100% ${HOUR}px` };
  const nowY = cal.nowMin >= startH * 60 && cal.nowMin <= endH * 60 ? y(cal.nowMin) : null;

  return (
    <div className="overflow-hidden rounded-lg border border-outline-variant/60 bg-surface-low">
      <div className="grid border-b border-outline-variant/60" style={{ gridTemplateColumns: COLS }}>
        <div />
        {dates.map((d) => {
          const isToday = d === cal.today;
          const n = perDay[dates.indexOf(d)].length;
          return (
            <button
              key={d}
              type="button"
              onClick={() => cal.openDay(d)}
              aria-label={`${fmtDayLong(d)}, ${n ? `${n} show${n > 1 ? "s" : ""}` : "no shows"}. Open day`}
              className={cx("state-layer flex min-w-0 flex-col items-center gap-0.5 focus-visible:outline-offset-[-3px]! border-l border-outline-variant/60 py-2", d < cal.today && "opacity-70")}
            >
              <span className={cx("type-label-m", isToday ? "text-primary" : "text-on-surface-variant")}>{DAY_SHORT[weekdayOf(d)]}</span>
              <DayNumber date={d} today={cal.today} />
            </button>
          );
        })}
      </div>

      <div className="grid" style={{ gridTemplateColumns: COLS }}>
        <div className="relative" style={{ height }} aria-hidden>
          {Array.from({ length: endH - startH }, (_, i) =>
            i === 0 ? null : (
              <span key={i} className="absolute right-2 -translate-y-1/2 type-label-s text-on-surface-variant tabular" style={{ top: i * HOUR }}>
                {fmtHour((startH + i) * 60)}
              </span>
            ),
          )}
        </div>
        {dates.map((d, di) => {
          const isToday = d === cal.today;
          const past = d < cal.today;
          return (
            <div key={d} role="group" aria-label={fmtDayLong(d)} className={cx("relative border-l border-outline-variant/60", isToday && "bg-primary/[0.07]")} style={{ height, ...lines }}>
              {layout(perDay[di]).map(({ ev, lane, lanes }) => {
                const tone = toneOf(ev, cal.today, cal.loading);
                const h = ((ev.endMin - ev.startMin) / 60) * HOUR - 4;
                const filled = ev.lineup?.slots.length ?? 0;
                return (
                  <EventPopover
                    key={ev.key}
                    ev={ev}
                    anchorClassName="absolute"
                    anchorStyle={{ top: y(ev.startMin) + 2, height: h, left: `calc(${(lane / lanes) * 100}% + 3px)`, width: `calc(${100 / lanes}% - 6px)` }}
                    className={cx("relative flex size-full flex-col gap-0.5 overflow-hidden rounded-md py-1.5 pr-1.5 pl-3", tone.block, past && tone.id !== "ask" && "opacity-75")}
                  >
                    <span aria-hidden className={cx("absolute inset-y-0 left-0 w-1", tone.bar)} />
                    <span className="flex items-start gap-1">
                      <span className="line-clamp-2 min-w-0 flex-1 type-label-l leading-4 break-words">{ev.show.name}</span>
                      <NotToldMark n={pendingCount(ev)} />
                    </span>
                    <span className="truncate type-body-s tabular opacity-80">{formatTime(ev.show.startTime)}</span>
                    <span className="mt-auto flex items-center gap-1.5">
                      <span aria-hidden className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-current/15">
                        <span className="block h-full rounded-full bg-current" style={{ width: `${Math.min(100, (filled / Math.max(1, ev.show.slotCount)) * 100)}%` }} />
                      </span>
                      <span className="flex-none type-label-s tabular">{fillOf(ev)}</span>
                    </span>
                  </EventPopover>
                );
              })}
              {isToday && nowY !== null && (
                <div aria-hidden className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: nowY }}>
                  <span className="-ml-1 size-2 flex-none rounded-full bg-error" />
                  <span className="h-px flex-1 bg-error" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
