// Landing page: the calendar. Day, Week and Month views of the shows, each opening the same card with every quick
// action the Lineup page has, and a side column for Updates, requests and next week's asks.
// The URL carries the view and date (/?view=month&date=2026-10-26) so any view can be linked; the last view is remembered.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { where } from "firebase/firestore";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { DAY_SHORT, formatDate, isClearedRequest, localNow, pendingRejections, shiftWeek, type Lineup, type Show, type SpotRequest, type Weekday } from "@spot/shared";
import { useApp } from "../lib/app";
import { useCollection, useNow } from "../lib/data";
import { useUpdates } from "../lib/updates";
import {
  CAL_VIEWS,
  addDays,
  fmtDayLong,
  fmtMonth,
  fmtWeekRange,
  isISODate,
  mondayOf,
  monthKey,
  readView,
  saveView,
  stepDate,
  toMinutes,
  useMedia,
  weekDates,
  weeksFor,
  weekdayOf,
  type CalView,
} from "../lib/calendarDates";
import { PageHeader } from "@spot/ui";
import { Count } from "../components/updates/shared";
import { Button, Chip, Empty, IconButton, Segmented, cx } from "@spot/ui";
import { IconArrowLeft, IconArrowRight, IconCalendarMark, IconChat, IconInbox } from "@spot/ui";
import { ToolButton } from "@spot/ui";
import { Agenda } from "../components/calendar/Agenda";
import { DayView } from "../components/calendar/DayView";
import { MonthCompact, MonthGrid } from "../components/calendar/MonthViews";
import { TONE_LEGEND, CalProvider, legendBar, makeEvent, type CalData, type CalEvent } from "../components/calendar/shared";
import { WeekGrid } from "../components/calendar/WeekGrid";
import { listNames } from "../components/calendar/EventCard";
import { laneOf, type Lane } from "../lib/lanes";
import { ComicAvatar } from "../lib/photos";

/** "/" used to be Requests. Old links like /?view=updates keep working by moving to /requests. */
export function Home() {
  const [params] = useSearchParams();
  const v = params.get("view");
  if (v && !(CAL_VIEWS as string[]).includes(v)) return <Navigate to={`/requests?${params.toString()}`} replace />;
  return <Calendar />;
}

const VIEW_OPTIONS = [
  { value: "day" as const, label: "Day" },
  { value: "week" as const, label: "Week" },
  { value: "month" as const, label: "Month" },
];

/** How the next view arrives: sliding in from a side (prev/next), a plain fade (view switch), or not at all (keyboard). */
type Arrive = "none" | "fade" | -1 | 1;

function Calendar() {
  const { uid, week, setWeek, currentWeek, shows, comicsById, settings } = useApp();
  const now = useNow(30_000);
  const local = localNow(new Date(now), settings.timezone);
  const today = local.date;
  const nowMin = toMinutes(local.time);
  const nextWeek = shiftWeek(currentWeek, 1);
  const [params, setParams] = useSearchParams();
  const phone = useMedia("(max-width: 639px)");
  const reduce = useReducedMotion();
  const arrive = useRef<Arrive>("none");
  const [side, setSide] = useSide();
  const wide = useMedia("(min-width: 1024px)");

  const viewParam = params.get("view");
  const view: CalView = (CAL_VIEWS as string[]).includes(viewParam ?? "") ? (viewParam as CalView) : (readView() ?? "week");
  const dateParam = params.get("date");
  const date = isISODate(dateParam) ? dateParam : mondayOf(today) === week ? today : week;

  const go = useCallback(
    (d: string, v: CalView = view, how: Arrive = "fade") => {
      arrive.current = how;
      setParams({ view: v, date: d }, { replace: true });
    },
    [view, setParams],
  );

  // `week` (app state, used by the other pages) follows the date; a week changed from elsewhere moves the date.
  const prev = useRef<{ week: string; date: string } | null>(null);
  useEffect(() => {
    const p = prev.current;
    prev.current = { week, date };
    if (!p || p.date !== date) {
      if (mondayOf(date) !== week) setWeek(mondayOf(date));
    } else if (p.week !== week && mondayOf(date) !== week) {
      arrive.current = "fade";
      setParams({ view, date: mondayOf(today) === week ? today : week }, { replace: true });
    }
  }, [week, date, today, view, setWeek, setParams]);

  const weeks = useMemo(() => weeksFor(view, date), [view, date]);
  const rangeKey = weeks.join(",");
  const requests = useCollection<SpotRequest>(uid, "requests", [where("weekOf", "in", weeks)], rangeKey);
  const lineups = useCollection<Lineup>(uid, "lineups", [where("weekOf", "in", weeks)], rangeKey);
  const nextRequests = useCollection<SpotRequest>(uid, "requests", [where("weekOf", "==", nextWeek)], nextWeek);
  const updates = useUpdates();

  const active = useMemo(() => shows.filter((s) => s.active), [shows]);
  const lineupBy = useMemo(() => new Map(lineups.data.map((l) => [`${l.weekOf}_${l.showId}`, l])), [lineups.data]);
  const asksByWeek = useMemo(() => {
    const m = new Map<string, SpotRequest[]>();
    for (const r of requests.data) m.set(r.weekOf, [...(m.get(r.weekOf) ?? []), r]);
    return m;
  }, [requests.data]);
  const weekRequests = asksByWeek.get(week) ?? [];
  const byLane = useMemo(() => groupByLane(weekRequests), [weekRequests]);
  const nextByLane = useMemo(() => groupByLane(nextRequests.data), [nextRequests.data]);

  // Same rule as the Lineup page: the regret note on Confirm shows when this is the last open show of that week.
  const regretInfo = useMemo(() => {
    const m = new Map<string, { openIds: string[]; regrets: number }>();
    for (const w of weeks) {
      const placed = new Set(lineups.data.filter((l) => l.weekOf === w).flatMap((l) => l.slots.map((x) => x.comicId)));
      const regrets = pendingRejections(asksByWeek.get(w) ?? [], placed).length;
      const openIds = active.filter((s) => !["confirmed", "cancelled"].includes(lineupBy.get(`${w}_${s.id}`)?.status ?? "draft")).map((s) => s.id);
      m.set(w, { openIds, regrets });
    }
    return m;
  }, [weeks, lineups.data, asksByWeek, active, lineupBy]);

  const cal = useMemo<CalData>(
    () => ({
      today,
      nowMin,
      loading: lineups.loading,
      comicsById,
      asksByWeek,
      lineups: lineups.data,
      eventsOn: (d: string): CalEvent[] => {
        const w = mondayOf(d);
        const wd = weekdayOf(d);
        return active.filter((s) => s.weekday === wd).map((s) => makeEvent(s, d, w, lineupBy.get(`${w}_${s.id}`))).sort((a, b) => a.startMin - b.startMin);
      },
      regretsFor: (ev) => {
        const r = regretInfo.get(ev.week);
        return r && r.openIds.length === 1 && r.openIds[0] === ev.show.id ? r.regrets : 0;
      },
      openDay: (d) => go(d, "day"),
    }),
    [today, nowMin, lineups.loading, lineups.data, comicsById, asksByWeek, active, lineupBy, regretInfo, go],
  );

  const chooseView = (v: CalView) => {
    saveView(v);
    go(date, v);
  };
  const step = (dir: -1 | 1, how: Arrive = dir) => go(stepDate(view, date, dir), view, how);
  const atToday = view === "day" ? date === today : view === "week" ? mondayOf(date) === mondayOf(today) : monthKey(date) === monthKey(today);
  const goToday = () => go(today, view, "fade");

  // Keyboard: ← → move, T is today, D W M switch view. Skipped while typing or while a dialog is open. No animation: these repeat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      if (document.querySelector('[role="dialog"],[role="menu"],[role="listbox"]')) return;
      const k = e.key.toLowerCase();
      if (k === "arrowleft") step(-1, "none");
      else if (k === "arrowright") step(1, "none");
      else if (k === "t") go(today, view, "none");
      else if (k === "d" || k === "w" || k === "m") {
        const v = ({ d: "day", w: "week", m: "month" } as const)[k];
        saveView(v);
        go(date, v, "none");
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const weekEvents = weekDates(mondayOf(date)).flatMap((d) => cal.eventsOn(d));
  const todo = weekEvents.filter((e) => e.lineup && e.date >= today && e.lineup.status === "draft" && e.lineup.slots.length > 0).length;
  const rel = (d: string) => (d === today ? "Today" : d === addDays(today, 1) ? "Tomorrow" : d === addDays(today, -1) ? "Yesterday" : fmtDayLong(d));
  const period = view === "month" ? fmtMonth(date) : view === "week" ? fmtWeekRange(mondayOf(date)) : rel(date);
  const title = view === "week" ? (week === currentWeek ? "This week" : week === nextWeek ? "Next week" : week === shiftWeek(currentWeek, -1) ? "Last week" : "Week of " + formatDate(week)) : period;
  const base = !active.length ? "Your shows, lineups and what's waiting on you" : `${active.length} show${active.length > 1 ? "s" : ""}${todo ? ` · ${todo} to confirm` : ""}`;
  const subtitle = view === "week" ? `${period} · ${base}` : view === "day" ? `${fmtDayLong(date)} · ${base}` : base;

  const anchor = view === "day" ? date : view === "week" ? mondayOf(date) : monthKey(date);
  const slide = typeof arrive.current === "number" && !reduce ? arrive.current * 28 : 0;
  const animate = arrive.current !== "none";

  return (
    <div className="w-full">
      <PageHeader
        title={title}
        subtitle={subtitle}
        // Part of the header's own sticky box: one element pins, so the date bar cannot lag, jump or scroll away.
        bar={
<div className="flex items-center gap-1.5 sm:gap-2" role="toolbar" aria-label="Calendar">
              <div className="flex items-center">
                <IconButton icon={IconArrowLeft} label={`Previous ${view}`} onClick={() => step(-1)} className="size-10 sm:size-9" />
                <IconButton icon={IconArrowRight} label={`Next ${view}`} onClick={() => step(1)} className="size-10 sm:size-9" />
              </div>
              <Button size="sm" variant={atToday ? "text" : "outlined"} onClick={goToday} title="Go to today (T)" aria-label={`Today, ${fmtDayLong(today)}`} className={cx(atToday && "text-on-surface-variant")}>
                Today
              </Button>
              <div className="ml-auto">
                <Segmented value={view} onChange={chooseView} options={VIEW_OPTIONS} size="sm" compact />
              </div>
            </div>
        }
      />
      <div
        style={{ "--side-w": side ? "3.5rem" : undefined } as React.CSSProperties}
        className="px-4 pb-10 sm:px-8 lg:grid lg:grid-cols-[minmax(0,1fr)_var(--side-w,20rem)] lg:items-start lg:gap-8 lg:transition-[grid-template-columns] lg:duration-300 lg:ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none xl:grid-cols-[minmax(0,1fr)_var(--side-w,21.25rem)]"
      >
        <div className="min-w-0">
          {!active.length ? (
            <Empty icon={IconCalendarMark} title="No shows yet" action={<Link to="/shows"><Button icon={IconCalendarMark}>Set up shows</Button></Link>}>
              Add the mics you curate (venue, day, time, slot count) and they show up here on their day.
            </Empty>
          ) : (
            <CalProvider value={cal}>
              {/* overflow-x-clip is what keeps a sliding view from widening the page; the side padding gives focus and selection rings room inside it. */}
              <div className="-mx-2 mt-1 overflow-x-clip px-2 pt-2 pb-2">
                <AnimatePresence initial={false} mode="popLayout">
                  <motion.div
                    key={`${view}:${anchor}`}
                    initial={animate ? { opacity: 0, transform: `translateX(${slide}px)` } : false}
                    animate={{ opacity: 1, transform: "translateX(0px)", transition: { duration: reduce ? 0.12 : 0.24, ease: [0.23, 1, 0.32, 1] } }}
                    exit={{ opacity: 0, transition: { duration: 0.08 } }}
                  >
                    {view === "week" ? (phone ? <Agenda week dates={weekDates(mondayOf(date))} label="This week by day" /> : <WeekGrid monday={mondayOf(date)} />) : null}
                    {view === "month" ? (phone ? <MonthCompact date={date} setDate={(d) => go(d, "month", "none")} /> : <MonthGrid date={date} />) : null}
                    {view === "day" ? <DayView date={date} /> : null}
                  </motion.div>
                </AnimatePresence>
              </div>
              {!phone && view !== "day" && <Legend />}
            </CalProvider>
          )}
        </div>

        <aside aria-label="Summary" className="relative mt-6 min-w-0 lg:sticky lg:top-[calc(var(--page-header-h,0px)+1rem)] lg:-mx-1 lg:mt-3 lg:overflow-x-clip lg:px-1 lg:py-1">
          {/* Collapsed (large screens only): a slim rail of icons with counts. */}
          <div className={cx("absolute inset-x-1 top-1 hidden flex-col items-center gap-1 transition-opacity duration-200 motion-reduce:transition-none", side ? "lg:flex" : "lg:hidden")} aria-hidden={!side}>
            <ToolButton icon={IconArrowLeft} label="Show the side column" tone="accent" onClick={() => setSide(false)} />
            <span className="my-1 h-px w-6 bg-outline-variant" aria-hidden />
            <ToolButton icon={IconInbox} label="Updates" count={updates.total} tone="accent" onClick={() => setSide(false)} />
            <ToolButton icon={IconChat} label="Requests this week" tone="accent" count={byLane.asked.length + byLane.maybe.length} onClick={() => setSide(false)} />
            <ToolButton icon={IconCalendarMark} label="Asking for next week" tone="accent" count={nextByLane.asked.length + nextByLane.maybe.length + nextByLane.held.length} onClick={() => setSide(false)} />
          </div>
          <div className={cx("flex min-w-0 flex-col gap-4 lg:w-[19.5rem] xl:w-[21rem]", side && "lg:invisible lg:opacity-0")} inert={side && wide ? true : undefined} style={{ transition: "opacity 200ms" }}>
            <div className="hidden items-center justify-between lg:flex">
              <span className="px-1 type-label-l text-on-surface-variant">At a glance</span>
              <IconButton icon={IconArrowRight} label="Hide the side column" onClick={() => setSide(true)} className="size-9" />
            </div>
            <UpdatesCard total={updates.total} needsYou={updates.needsYou} />
            <RequestsCard title={week === currentWeek ? "Requests this week" : `Requests · ${formatDate(week)}`} by={byLane} loading={requests.loading} />
            <NextWeekCard
              by={nextByLane}
              loading={nextRequests.loading}
              viewing={week === nextWeek}
              onOpen={() => setWeek(nextWeek)}
              shows={active}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}

const SIDE_KEY = "spot.calendar.sideCollapsed";
/** Whether the side column is folded into its rail. Remembered; blocked storage just means it isn't. */
function useSide() {
  const [side, set] = useState(() => {
    try {
      // Folded by default; only an explicit "show" is remembered as open.
      return localStorage.getItem(SIDE_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const setSide = useCallback((v: boolean) => {
    set(v);
    try {
      localStorage.setItem(SIDE_KEY, v ? "1" : "0");
    } catch {
      /* not remembered */
    }
  }, []);
  return [side, setSide] as const;
}

function Legend() {
  return (
    <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 type-body-s text-on-surface-variant" aria-label="Status colours">
      {TONE_LEGEND.map((t) => (
        <li key={t.id} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cx("size-2 rounded-full", legendBar(t.id))} />
          {t.label}
        </li>
      ))}
    </ul>
  );
}

function groupByLane(list: SpotRequest[]) {
  const g: Record<Lane, SpotRequest[]> = { asked: [], maybe: [], held: [], placed: [], closed: [] };
  for (const r of list) if (!isClearedRequest(r)) g[laneOf(r)].push(r);
  for (const k of Object.keys(g) as Lane[]) g[k].sort((a, b) => a.createdAt - b.createdAt);
  return g;
}

/* ---------- Side column ---------- */

function SideCard({ title, to, onNavigate, action, children }: { title: string; to: string; onNavigate?: () => void; action: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg bg-surface-low p-4">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate type-title-m">{title}</h2>
        <Link to={to} onClick={onNavigate} className="state-layer -mr-2 inline-flex h-8 flex-none items-center gap-1 rounded-full px-3 type-label-m text-primary">
          {action} <IconArrowRight className="icon size-4" />
        </Link>
      </div>
      {children}
    </section>
  );
}

function UpdatesCard({ total, needsYou }: { total: number; needsYou: number }) {
  return (
    <SideCard title="Updates" to="/requests?view=updates" action="Open">
      <div className="mt-3 flex items-center gap-3">
        <Count value={total} className={cx("grid min-w-9 place-items-center rounded-full px-2 py-1 type-title-m", total ? "bg-primary text-on-primary" : "bg-surface-high text-on-surface-variant")} />
        <p className="min-w-0 flex-1 type-body-m text-on-surface-variant">
          {total === 0 ? "All caught up." : needsYou > 0 ? `${needsYou} need${needsYou === 1 ? "s" : ""} you: replies, mic checks and new faces.` : "Only notices, nothing needs you."}
        </p>
      </div>
    </SideCard>
  );
}

const SUMMARY_LANES: { id: Lane; label: string }[] = [
  { id: "asked", label: "Asked" },
  { id: "maybe", label: "Maybe" },
  { id: "held", label: "Held" },
  { id: "placed", label: "Placed" },
];

function RequestsCard({ title, by, loading }: { title: string; by: Record<Lane, SpotRequest[]>; loading: boolean }) {
  const none = SUMMARY_LANES.every((l) => by[l.id].length === 0);
  return (
    <SideCard title={title} to="/requests" action="Requests">
      {loading ? (
        <div className="mt-3 h-28 animate-pulse rounded-md bg-surface-container" />
      ) : none ? (
        <p className="mt-3 type-body-m text-on-surface-variant">No requests.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1">
          {SUMMARY_LANES.map((l) => (
            <li key={l.id} className="flex min-h-10 items-center gap-3 rounded-md px-1 py-1">
              <span className="w-14 flex-none type-label-l text-on-surface-variant">{l.label}</span>
              <span className={cx("grid min-w-7 flex-none place-items-center rounded-full px-1.5 type-label-m tabular", by[l.id].length && l.id === "asked" ? "bg-primary text-on-primary" : "bg-surface-high text-on-surface-variant")}>{by[l.id].length}</span>
              <span className="min-w-0 flex-1 truncate type-body-s text-on-surface-variant">{by[l.id].length ? listNames(by[l.id].map((r) => r.comicName), 3) : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </SideCard>
  );
}

function NextWeekCard({ by, loading, viewing, onOpen, shows }: { by: Record<Lane, SpotRequest[]>; loading: boolean; viewing: boolean; onOpen: () => void; shows: Show[] }) {
  const navigate = useNavigate();
  const live = [...by.asked, ...by.maybe, ...by.held];
  const dayCount = (wd: Weekday) => live.filter((r) => r.intent.preferredDays.includes(wd)).length;
  const days = [...new Set(shows.map((s) => s.weekday))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return (
    <SideCard title="Asking for next week" to="/requests" onNavigate={onOpen} action="See">
      {loading ? (
        <div className="mt-3 h-16 animate-pulse rounded-md bg-surface-container" />
      ) : live.length === 0 ? (
        <p className="mt-3 type-body-m text-on-surface-variant">Nobody has asked for next week yet.</p>
      ) : (
        <>
          {days.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {days.map((wd) => (
                <Chip key={wd} tone={dayCount(wd) ? "primary" : "neutral"}>{DAY_SHORT[wd]} · {dayCount(wd)}</Chip>
              ))}
            </div>
          )}
          <ul className="mt-3 flex flex-col gap-1.5">
            {live.slice(0, 5).map((r) => (
              <li key={r.id} className="flex h-10 items-center gap-2.5">
                <ComicAvatar id={r.comicId} name={r.comicName} size={28} tone="secondary" />
                <span className="min-w-0 flex-1 truncate type-body-m">{r.comicName}</span>
                <span className="flex-none type-label-s text-on-surface-variant">{r.intent.preferredDays.length ? r.intent.preferredDays.map((d) => DAY_SHORT[d]).join(" ") : "Any day"}</span>
              </li>
            ))}
          </ul>
          {live.length > 5 && <p className="mt-1 type-body-s text-on-surface-variant">+{live.length - 5} more</p>}
        </>
      )}
      {!viewing && (
        <Button size="sm" variant="tonal" icon={IconCalendarMark} className="mt-3" onClick={() => { onOpen(); navigate("/"); }}>
          Plan next week
        </Button>
      )}
    </SideCard>
  );
}
