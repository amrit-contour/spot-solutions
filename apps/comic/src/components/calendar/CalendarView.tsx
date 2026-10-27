import { useMemo, useRef } from "react";
import { isoAddDays, SPOT_SOURCE_LABEL, type CalendarSpot, type SpotSource } from "@spot/shared";
import { IconArrowLeft, IconArrowRight, Segmented } from "@spot/ui";
import { addMonths, dayNum, monthGrid, monthName, SOURCE_DOT, SOURCE_DOT_ON_FILL, SOURCE_ORDER, sourcesByDate, weekDates } from "./dates";
import { SwipePager, type PagerHandle } from "./SwipePager";

export type CalendarMode = "week" | "month";
const WEEKDAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];
const MODE_KEY = "nbc.calendarMode";
export const readMode = (): CalendarMode => {
  try {
    return localStorage.getItem(MODE_KEY) === "month" ? "month" : "week";
  } catch {
    return "week";
  }
};
const writeMode = (m: CalendarMode) => {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* private window: the choice just isn't remembered */
  }
};

function Dots({ sources, onFill }: { sources: SpotSource[]; onFill?: boolean }) {
  return (
    <span className="flex h-1.5 items-center justify-center gap-0.5" aria-hidden>
      {SOURCE_ORDER.filter((s) => sources.includes(s)).map((s) => (
        <span key={s} className={`size-1.5 rounded-full ${(onFill ? SOURCE_DOT_ON_FILL : SOURCE_DOT)[s]}`} />
      ))}
    </span>
  );
}

function DayCell({ date, today, selected, dim, sources, onSelect, tall }: { date: string; today: string; selected: boolean; dim?: boolean; sources: SpotSource[]; onSelect: () => void; tall?: boolean }) {
  const isToday = date === today;
  const count = sources.length;
  return (
    <button
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${dayNum(date)} ${monthName(date)}${isToday ? ", today" : ""}${count ? `, ${count} kind${count === 1 ? "" : "s"} of spot` : ""}`}
      className={`pressable relative mx-auto flex w-full min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg transition-colors duration-150 ${tall ? "h-[4.25rem]" : "h-11"} ${selected ? "bg-primary text-on-primary" : isToday ? "bg-primary-container text-on-primary-container" : "text-on-surface"} ${dim && !selected ? "opacity-45" : ""}`}
    >
      <span className="type-title-m tabular leading-none">{dayNum(date)}</span>
      <Dots sources={sources} onFill={selected} />
    </button>
  );
}

/**
 * The comic's calendar: a swipeable week strip or a month grid, a dot per kind of spot on each day.
 * `selected` is the one piece of state; the week or month shown follows it.
 */
export function CalendarView({ spots, today, selected, onSelect, mode, onMode }: { spots: CalendarSpot[]; today: string; selected: string; onSelect: (d: string) => void; mode: CalendarMode; onMode: (m: CalendarMode) => void }) {
  const pager = useRef<PagerHandle>(null);
  const by = useMemo(() => sourcesByDate(spots), [spots]);
  const used = useMemo(() => SOURCE_ORDER.filter((s) => spots.some((x) => x.source === s && x.status !== "cancelled")), [spots]);
  const shift = (d: -1 | 1) => onSelect(mode === "week" ? isoAddDays(selected, 7 * d) : addMonths(selected, d));
  const yr = (d: string) => (d.slice(0, 4) === today.slice(0, 4) ? "" : ` ${d.slice(0, 4)}`);
  const wk = weekDates(selected);
  const heading = mode === "month" || wk[0]!.slice(0, 7) === wk[6]!.slice(0, 7) ? `${monthName(selected)}${yr(selected)}` : `${monthName(wk[0]!).slice(0, 3)} / ${monthName(wk[6]!).slice(0, 3)}${yr(wk[6]!)}`;
  return (
    <section aria-label="Calendar" className="min-w-0 rounded-lg bg-surface-low p-3 pb-2">
      <div className="mb-1 flex min-w-0 items-center gap-2 px-1.5">
        <h2 className="min-w-0 truncate type-title-m">{heading}</h2>
        {selected !== today && (
          <button onClick={() => onSelect(today)} className="state-layer pressable h-11 flex-none rounded-full px-3 type-label-l text-primary">
            Today
          </button>
        )}
        <span className="flex-1" />
        <span className="hidden flex-none items-center sm:flex">
          <button onClick={() => pager.current?.go(-1)} aria-label={mode === "week" ? "Previous week" : "Previous month"} className="state-layer pressable grid size-11 place-items-center rounded-full">
            <IconArrowLeft className="icon size-5" />
          </button>
          <button onClick={() => pager.current?.go(1)} aria-label={mode === "week" ? "Next week" : "Next month"} className="state-layer pressable grid size-11 place-items-center rounded-full">
            <IconArrowRight className="icon size-5" />
          </button>
        </span>
        <div className="w-40 flex-none">
          <Segmented
            full
            value={mode}
            onChange={(m) => {
              writeMode(m);
              onMode(m);
            }}
            options={[
              { value: "week", label: "Week" },
              { value: "month", label: "Month" },
            ]}
          />
        </div>
      </div>
      <div className="grid grid-cols-7 px-0.5" aria-hidden>
        {WEEKDAY_LETTERS.map((l, i) => (
          <span key={i} className="py-1 text-center type-label-m text-on-surface-variant">{l}</span>
        ))}
      </div>
      <SwipePager ref={pager} onShift={shift} resetKey={`${mode}:${mode === "week" ? weekDates(selected)[0] : selected.slice(0, 7)}`} label={mode === "week" ? "Weeks, swipe sideways" : "Months, swipe sideways"}>
        {(o) =>
          mode === "week" ? (
            <div role="group" aria-label={`Week of ${weekDates(selected, o)[0]}`} className="grid grid-cols-7 px-0.5">
              {weekDates(selected, o).map((d) => (
                <DayCell key={d} tall date={d} today={today} selected={d === selected} sources={by.get(d) ?? []} onSelect={() => onSelect(d)} />
              ))}
            </div>
          ) : (
            <div role="group" aria-label={`${monthName(addMonths(selected, o))} grid`} className="flex flex-col gap-0.5 px-0.5">
              {monthGrid(selected, o).map((row) => (
                <div key={row[0]} className="grid grid-cols-7">
                  {row.map((d) => (
                    <DayCell key={d} date={d} today={today} selected={d === selected} dim={d.slice(0, 7) !== addMonths(selected, o).slice(0, 7)} sources={by.get(d) ?? []} onSelect={() => onSelect(d)} />
                  ))}
                </div>
              ))}
            </div>
          )
        }
      </SwipePager>
      {used.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap items-center justify-center gap-x-3.5 gap-y-1 px-1.5 type-label-m text-on-surface-variant" aria-label="Key">
          {used.map((s) => (
            <li key={s} className="inline-flex items-center gap-1.5">
              <span className={`size-2 rounded-full ${SOURCE_DOT[s]}`} aria-hidden />
              {SPOT_SOURCE_LABEL[s]}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
