// One day: its shows as full cards, who is asking for that weekday, and the days that follow.
import { DAY_NAMES, DAY_SHORT } from "@spot/shared";
import { addDays, fmtDayLong, mondayOf, weekdayOf } from "../../lib/calendarDates";
import { laneOf } from "../../routes/Requests";
import { Avatar, cx } from "../ui";
import { IconCalendarMark } from "../icons";
import { Agenda } from "./Agenda";
import { EventCard, listNames } from "./EventCard";
import { useCal } from "./shared";

/** The day's shows as cards. Used by the Day view and under the compact month on phones. */
export function DayEvents({ date }: { date: string }) {
  const cal = useCal();
  const evs = cal.eventsOn(date);
  if (!evs.length)
    return (
      <div className="flex items-center gap-3 rounded-lg border border-dashed border-outline-variant px-4 py-6 text-on-surface-variant">
        <IconCalendarMark className="icon size-6 flex-none" />
        <p className="type-body-m">No shows on {fmtDayLong(date)}.</p>
      </div>
    );
  return (
    <ul className="flex flex-col gap-4">
      {evs.map((ev) => (
        <EventCard key={ev.key} show={ev.show} date={ev.date} today={cal.today} week={ev.week} lineup={ev.lineup} loading={cal.loading} asks={cal.asksByWeek.get(ev.week) ?? []} comicsById={cal.comicsById} regretsAfter={cal.regretsFor(ev)} />
      ))}
    </ul>
  );
}

export function DayView({ date }: { date: string }) {
  const cal = useCal();
  const wd = weekdayOf(date);
  const asks = (cal.asksByWeek.get(mondayOf(date)) ?? []).filter((r) => ["asked", "maybe"].includes(laneOf(r)));
  const wants = asks.filter((r) => r.intent.preferredDays.includes(wd));
  const anyDay = asks.filter((r) => !r.intent.preferredDays.length);
  const next = Array.from({ length: 7 }, (_, i) => addDays(date, i + 1));
  const has = cal.eventsOn(date).length > 0;

  return (
    <div className="grid gap-8 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] md:items-start">
      <section aria-label={fmtDayLong(date)}>
        <DayEvents date={date} />
      </section>

      <div className="flex flex-col gap-8">
        <section aria-labelledby="day-asking">
          <h2 id="day-asking" className="mb-2 type-title-m">Asking for {DAY_NAMES[wd]}</h2>
          {wants.length === 0 && anyDay.length === 0 ? (
            <p className="type-body-m text-on-surface-variant">{has ? "Nobody is waiting for this day." : `Nobody has asked for ${DAY_NAMES[wd]}.`}</p>
          ) : (
            <>
              {wants.length > 0 && (
                <ul className="flex flex-col">
                  {wants.map((r) => (
                    <li key={r.id} className="flex h-12 items-center gap-3 border-b border-outline-variant/40 last:border-b-0">
                      <Avatar name={r.comicName} size={32} tone="secondary" />
                      <span className="min-w-0 flex-1 truncate type-body-m">{r.comicName}</span>
                      <span className="flex-none type-label-m text-on-surface-variant">{r.intent.preferredDays.map((x) => DAY_SHORT[x]).join(" ")}</span>
                    </li>
                  ))}
                </ul>
              )}
              {anyDay.length > 0 && (
                <p className={cx("type-body-m text-on-surface-variant", wants.length > 0 && "mt-2")}>
                  {anyDay.length} open to any day: {listNames(anyDay.map((r) => r.comicName), 4)}.
                </p>
              )}
            </>
          )}
        </section>

        <section aria-labelledby="day-next">
          <h2 id="day-next" className="mb-1 type-title-m">Next 7 days</h2>
          <Agenda dates={next} label="Next 7 days" />
        </section>
      </div>
    </div>
  );
}
