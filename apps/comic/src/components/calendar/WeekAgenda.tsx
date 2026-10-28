import { SPOT_SOURCE_LABEL, SPOT_STATE_LABEL, bySpotTime, formatTime, spotState, type CalendarSpot, type PlannedAsk } from "@spot/shared";
import { Chip, IconPlus, IconSend, boolPref, cx, usePref } from "@spot/ui";

/** "Hide empty days" in the Week view, remembered with the account. */
const HIDE_EMPTY_DAYS_PREF = boolPref("hideEmptyDays", "nbc.calendar.hideEmptyDays", false);
import { Section } from "../ui";
import { SOURCE_DOT, dayLong, weekDates } from "./dates";

const TONE = { upcoming: "neutral", tonight: "primary", to_check: "error", happened: "success", didnt: "neutral", cancelled: "neutral" } as const;
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const wd = (d: string) => WD[new Date(`${d}T00:00:00Z`).getUTCDay()]!;

/**
 * The Week view's list: the whole week grouped by day, each day under its own header with compact rows.
 * Days with nothing on fold to one thin line (or go away with "Hide empty days"). Tapping a day's header opens it in Day view.
 */
export function WeekAgenda({ date, today, spots, asks, onOpenDay, onAdd, onOpen }: { date: string; today: string; spots: CalendarSpot[]; asks: PlannedAsk[]; onOpenDay: (d: string) => void; onAdd: (d: string) => void; onOpen: (s: CalendarSpot) => void }) {
  const [hideEmpty, setHideEmpty] = usePref(HIDE_EMPTY_DAYS_PREF);
  const days = weekDates(date).map((d) => ({
    d,
    spots: spots.filter((s) => s.date === d && s.status !== "cancelled").sort((a, b) => bySpotTime(a, b)),
    asks: asks.filter((a) => a.showDate === d),
  }));
  const empty = days.filter((x) => !x.spots.length && !x.asks.length).length;
  const total = days.reduce((n, x) => n + x.spots.length, 0);
  return (
    <Section
      title={weekDates(date).includes(today) ? "This week" : "That week"}
      label={`Spots, week of ${dayLong(weekDates(date)[0]!)}`}
      action={
        empty > 0 && total > 0 ? (
          <button type="button" aria-pressed={hideEmpty} onClick={() => setHideEmpty(!hideEmpty)} className="state-layer pressable inline-flex min-h-11 items-center rounded-full px-3 type-label-l text-primary">
            {hideEmpty ? "Show empty days" : "Hide empty days"}
          </button>
        ) : undefined
      }
    >
      <ol className="flex flex-col gap-1">
        {days.map(({ d, spots: ss, asks: as }) => {
          const none = !ss.length && !as.length;
          if (none && hideEmpty) return null;
          const isToday = d === today;
          return (
            <li key={d} className={cx("rounded-lg", !none && "bg-surface-low p-2", d < today && "opacity-80")}>
              <div className={cx("flex min-h-11 items-center gap-2", none && "px-2")}>
                <button type="button" onClick={() => onOpenDay(d)} aria-label={`Open ${dayLong(d)}`} className="state-layer pressable -ml-1 flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-full px-2 text-left">
                  <span className={cx("grid size-8 flex-none place-items-center rounded-full type-title-s tabular", isToday ? "bg-primary text-on-primary" : "bg-surface-high text-on-surface")}>{Number(d.slice(8, 10))}</span>
                  <span className="type-title-s">{wd(d)}</span>
                  {isToday && <Chip tone="primary" className="flex-none">Today</Chip>}
                  {none && <span className="ml-auto type-body-s text-on-surface-variant">No spots</span>}
                </button>
                {!none && <span className="flex-none type-label-m text-on-surface-variant tabular">{ss.length} spot{ss.length === 1 ? "" : "s"}</span>}
                <button type="button" onClick={() => onAdd(d)} aria-label={`Add a spot on ${dayLong(d)}`} title="Add a spot" className="state-layer pressable grid size-11 flex-none place-items-center rounded-full border border-outline-variant text-primary">
                  <IconPlus className="icon size-4" />
                </button>
              </div>
              {!none && (
                <ul className="mt-1 flex flex-col gap-1">
                  {ss.map((s) => {
                    const state = s.skippedRegular ? null : spotState(s, today);
                    return (
                      <li key={s.id}>
                        <button type="button" disabled={s.skippedRegular} onClick={() => onOpen(s)} aria-label={`Open ${s.roomName ?? "spot"}`} className={cx("state-layer pressable flex min-h-12 w-full min-w-0 items-center gap-3 rounded-md bg-surface px-3 py-2 text-left", (s.skippedRegular || state === "didnt") && "opacity-60")}>
                          <span className="w-[4.25rem] flex-none whitespace-nowrap type-label-l tabular">{s.time ? formatTime(s.time) : "No time"}</span>
                          <span className={cx("size-2 flex-none rounded-full", SOURCE_DOT[s.source])} aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate type-title-s">{s.roomName || "Somewhere"}</span>
                            <span className="block truncate type-body-s text-on-surface-variant">{SPOT_SOURCE_LABEL[s.source]}</span>
                          </span>
                          <Chip tone={state ? TONE[state] : "neutral"} className="flex-none">{state ? SPOT_STATE_LABEL[state] : "Skipped"}</Chip>
                        </button>
                      </li>
                    );
                  })}
                  {as.length > 0 && (
                    <li className="flex min-h-10 items-center gap-3 rounded-md border border-dashed border-outline-variant px-3 text-on-surface-variant">
                      <IconSend aria-hidden className="icon size-4 flex-none" />
                      <span className="min-w-0 flex-1 truncate type-body-s">{as.length} ask{as.length === 1 ? "" : "s"} to make for this day</span>
                    </li>
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
