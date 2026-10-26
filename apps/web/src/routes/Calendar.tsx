// Landing page: the week as a calendar. Shows sit on their weekday with the lineup, what still needs doing, and a
// side column for requests, next week's asks and Updates. Every action here is the same one the Lineup page runs.
import { useEffect, useMemo, useRef, useState } from "react";
import { updateDoc, where } from "firebase/firestore";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  DAY_NAMES,
  DAY_SHORT,
  dateInWeek,
  diffLineup,
  formatDate,
  formatTime,
  groupModeOf,
  localNow,
  pendingRejections,
  sentSnapshot,
  shiftWeek,
  type Comic,
  type Lineup,
  type Show,
  type SpotRequest,
  type Weekday,
} from "@spot/shared";
import { useApp } from "../lib/app";
import { useCollection, useNow, userDoc } from "../lib/data";
import { markCanned } from "../lib/lineup";
import { answerMicCheck, useUpdates } from "../lib/updates";
import { PageHeader } from "../components/Shell";
import { WeekSwitcher } from "../components/WeekSwitcher";
import { ConfirmSheet } from "../components/ConfirmSheet";
import { SendUpdatesSheet } from "../components/SendUpdatesSheet";
import { OfferSheet } from "../components/OfferSheet";
import { GroupSyncSheet } from "../components/GroupSyncSheet";
import { PillRow, comicPills, type TellState } from "../components/Pills";
import { Count } from "../components/updates/shared";
import { Avatar, Button, Chip, Empty, buttonClass, cx } from "../components/ui";
import { IconArrowRight, IconCalendarMark, IconCheck, IconClock, IconInbox, IconMap, IconMic, IconSend, IconSparkle, IconUserPlus } from "../components/icons";
import { laneOf, type Lane } from "./Requests";

/** "/" used to be Requests. Old links like /?view=updates keep working by moving to /requests. */
export function Home() {
  const [params] = useSearchParams();
  if (params.has("view")) return <Navigate to={`/requests?${params.toString()}`} replace />;
  return <Calendar />;
}

// Monday first, like the week key.
const WEEK_ORDER: Weekday[] = [1, 2, 3, 4, 5, 6, 0];
const first = (name: string) => name.split(" ")[0];

function Calendar() {
  const { uid, week, setWeek, currentWeek, shows, comicsById, settings } = useApp();
  const now = useNow(30_000);
  const today = localNow(new Date(now), settings.timezone).date;
  const nextWeek = shiftWeek(currentWeek, 1);
  const requests = useCollection<SpotRequest>(uid, "requests", [where("weekOf", "==", week)], week);
  const lineups = useCollection<Lineup>(uid, "lineups", [where("weekOf", "==", week)], week);
  const nextRequests = useCollection<SpotRequest>(uid, "requests", [where("weekOf", "==", nextWeek)], nextWeek);
  const updates = useUpdates();

  const active = useMemo(() => shows.filter((s) => s.active), [shows]);
  const lineupByShow = useMemo(() => new Map(lineups.data.map((l) => [l.showId, l])), [lineups.data]);
  const byLane = useMemo(() => groupByLane(requests.data), [requests.data]);
  const nextByLane = useMemo(() => groupByLane(nextRequests.data), [nextRequests.data]);
  // Same rule as the Lineup page: the regret note on Confirm shows when this is the last open show of the week.
  const regrets = useMemo(() => pendingRejections(requests.data, new Set(lineups.data.flatMap((l) => l.slots.map((x) => x.comicId)))), [requests.data, lineups.data]);
  const openShows = active.filter((s) => !["confirmed", "cancelled"].includes(lineupByShow.get(s.id)?.status ?? "draft"));

  const days = WEEK_ORDER.map((wd) => ({ wd, date: dateInWeek(week, wd), shows: active.filter((s) => s.weekday === wd) }));
  const showDays = days.filter((d) => d.shows.length);
  const title = week === currentWeek ? "This week" : week === nextWeek ? "Next week" : week === shiftWeek(currentWeek, -1) ? "Last week" : week < currentWeek ? "Week of " + formatDate(week) : "Week of " + formatDate(week);
  const todo = active.filter((s) => {
    const l = lineupByShow.get(s.id);
    return l && l.date >= today && l.status === "draft" && l.slots.length > 0;
  }).length;
  const subtitle = !active.length ? "Your shows, lineups and what's waiting on you" : `${active.length} show${active.length > 1 ? "s" : ""}${todo ? ` · ${todo} to confirm` : ""}`;

  return (
    <div className="w-full">
      <PageHeader title={title} subtitle={subtitle} actions={<WeekSwitcher />} />
      <div className="px-4 pb-10 sm:px-8 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start lg:gap-8 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0">
          <WeekStrip days={days} today={today} />
          {!active.length ? (
            <Empty icon={IconCalendarMark} title="No shows yet" action={<Link to="/shows"><Button icon={IconCalendarMark}>Set up shows</Button></Link>}>
              Add the mics you curate (venue, day, time, slot count) and they show up here on their day.
            </Empty>
          ) : (
            <ul className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-4">
              {showDays.flatMap((d) =>
                d.shows.map((show) => (
                  <EventCard
                    key={show.id}
                    show={show}
                    date={d.date}
                    today={today}
                    lineup={lineupByShow.get(show.id)}
                    loading={lineups.loading}
                    asks={requests.data}
                    comicsById={comicsById}
                    regretsAfter={openShows.length === 1 && openShows[0].id === show.id ? regrets.length : 0}
                  />
                )),
              )}
            </ul>
          )}
          {active.length > 0 && showDays.length < 7 && (
            <p className="mt-4 type-body-s text-on-surface-variant">
              No shows {days.filter((d) => !d.shows.length).map((d) => DAY_SHORT[d.wd]).join(", ")}.
            </p>
          )}
        </div>

        <aside aria-label="Summary" className="mt-6 flex min-w-0 flex-col gap-4 lg:sticky lg:top-4 lg:mt-5">
          <UpdatesCard total={updates.total} needsYou={updates.needsYou} />
          <RequestsCard title={week === currentWeek ? "Requests this week" : `Requests · ${formatDate(week)}`} by={byLane} loading={requests.loading} />
          <NextWeekCard
            by={nextByLane}
            loading={nextRequests.loading}
            viewing={week === nextWeek}
            onOpen={() => setWeek(nextWeek)}
            shows={active}
          />
        </aside>
      </div>
    </div>
  );
}

function groupByLane(list: SpotRequest[]) {
  const g: Record<Lane, SpotRequest[]> = { asked: [], maybe: [], held: [], placed: [], closed: [] };
  for (const r of list) g[laneOf(r)].push(r);
  for (const k of Object.keys(g) as Lane[]) g[k].sort((a, b) => a.createdAt - b.createdAt);
  return g;
}

/* ---------- Week strip ---------- */

function WeekStrip({ days, today }: { days: { wd: Weekday; date: string; shows: Show[] }[]; today: string }) {
  return (
    <ol className="grid grid-cols-7 gap-1 sm:gap-2" aria-label="Days of the week">
      {days.map((d) => {
        const isToday = d.date === today;
        const past = d.date < today;
        const has = d.shows.length > 0;
        const cell = (
          <>
            <span className={cx("type-label-s", isToday ? "text-on-primary" : "text-on-surface-variant")}>{DAY_SHORT[d.wd]}</span>
            <span className="type-title-m tabular">{Number(d.date.slice(8))}</span>
            <span className="flex h-1.5 items-center gap-0.5" aria-hidden>
              {d.shows.map((s) => (
                <span key={s.id} className={cx("size-1.5 rounded-full", isToday ? "bg-on-primary" : "bg-primary")} />
              ))}
            </span>
          </>
        );
        const cls = cx(
          "flex min-w-0 flex-col items-center gap-0.5 rounded-lg py-2",
          isToday ? "bg-primary text-on-primary" : has ? "bg-surface-container text-on-surface" : "text-on-surface-variant/70",
          past && !isToday && "opacity-60",
        );
        return (
          <li key={d.wd}>
            {has ? (
              <button type="button" className={cx(cls, "state-layer w-full")} onClick={() => document.getElementById(`show-${d.shows[0].id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })} aria-label={`${DAY_NAMES[d.wd]} ${formatDate(d.date)}, ${d.shows.length} show${d.shows.length > 1 ? "s" : ""}`}>
                {cell}
              </button>
            ) : (
              <div className={cls} aria-label={`${DAY_NAMES[d.wd]} ${formatDate(d.date)}, no shows`}>
                {cell}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ---------- One show on its day ---------- */

function EventCard({ show, date, today, lineup, loading, asks, comicsById, regretsAfter }: { show: Show; date: string; today: string; lineup?: Lineup; loading: boolean; asks: SpotRequest[]; comicsById: Map<string, Comic>; regretsAfter: number }) {
  const { uid, venues, currentWeek, week } = useApp();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [offerOpen, setOfferOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const venue = venues.find((v) => v.id === show.venueId);
  const status = lineup?.status;
  const confirmed = status === "confirmed";
  const off = status === "cancelled" || status === "canned";
  const mode = groupModeOf(show);
  const isToday = date === today;
  const past = date < today;
  const slots = lineup?.slots ?? [];
  const ids = slots.map((s) => s.comicId);
  const name = (id: string) => comicsById.get(id)?.name ?? `+${id.split("@")[0]}`;

  const baseline = confirmed && lineup ? (lineup.sent ?? sentSnapshot(lineup.slots, show, lineup.sentAt ?? 0)) : null;
  const changes = baseline && lineup ? diffLineup(lineup.slots, baseline, show) : null;
  const statesFor = (cid: string): TellState[] => {
    if (changes?.added.includes(cid)) return [{ kind: "new", text: "Not told yet" }];
    if (changes) {
      const m = changes.moved.find((x) => x.comicId === cid);
      if (m) return [{ kind: "moved", text: `Moved from ${m.from}` }];
    }
    return lineup?.sent?.[cid] || (confirmed && !lineup?.sent) ? [{ kind: "told", text: "Already told" }] : [];
  };
  const lastWeek = shiftWeek(week, -1);

  // Same as the Lineup page: when this show's group mode is "confirm", open the group review once the plan lands
  // after the curator pressed Confirm & send or Send updates. A plan left pending from before never pops the sheet.
  const lineupLoaded = !loading;
  const syncStatus = lineup?.groupSync?.status;
  const armed = useRef(false);
  const seen = useRef<{ status: string | undefined } | null>(null);
  useEffect(() => {
    if (!lineupLoaded) return;
    if (!seen.current) {
      seen.current = { status: syncStatus };
      return;
    }
    const before = seen.current.status;
    seen.current.status = syncStatus;
    if (before !== "pending" && syncStatus === "pending" && armed.current) {
      armed.current = false;
      setSyncOpen(true);
    }
  }, [syncStatus, lineupLoaded]);

  // Who asked for this weekday and isn't placed yet. People with no day preference are counted apart.
  const waiting = asks.filter((r) => {
    const lane = laneOf(r);
    return (lane === "asked" || lane === "maybe") && !ids.includes(r.comicId);
  });
  const wantsDay = waiting.filter((r) => r.intent.preferredDays.includes(show.weekday));
  const anyDay = waiting.filter((r) => !r.intent.preferredDays.length);
  const seeds = !lineup && !past && week >= currentWeek ? [...new Set([...(show.regulars ?? []), ...(show.protected ?? [])])].map(name) : [];

  const statusChip = past && status === "confirmed" && lineup?.outcome === "happened" ? <Chip tone="success" icon={IconCheck}>Happened</Chip>
    : status === "canned" ? <Chip tone="error">Didn't happen</Chip>
    : status === "cancelled" ? <Chip tone="error">Cancelled</Chip>
    : confirmed ? <Chip tone="success" icon={IconCheck}>Confirmed</Chip>
    : slots.length ? <Chip tone="tertiary">Draft</Chip>
    : <Chip>Not started</Chip>;

  const mic = past && confirmed && !lineup?.outcome && lineup;
  const canAct = !off && !past;
  const open = slots.length < show.slotCount;

  return (
    <li id={`show-${show.id}`} className={cx("flex min-w-0 scroll-mt-4 flex-col rounded-lg bg-surface-low p-4", isToday && "ring-2 ring-primary")}>
      <header className="flex items-start gap-3">
        <div className={cx("flex size-12 flex-none flex-col items-center justify-center rounded-md", isToday ? "bg-primary text-on-primary" : "bg-surface-high text-on-surface")}>
          <span className={cx("type-label-s uppercase", isToday ? "text-on-primary" : "text-on-surface-variant")}>{DAY_SHORT[show.weekday]}</span>
          <span className="type-title-m leading-5 tabular">{Number(date.slice(8))}</span>
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate type-title-m">{show.name}</h3>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 type-body-s text-on-surface-variant">
            <span className="inline-flex items-center gap-1"><IconClock className="icon size-3.5" />{formatTime(show.startTime)}</span>
            {venue && <span className="inline-flex min-w-0 items-center gap-1"><IconMap className="icon size-3.5 flex-none" /><span className="truncate">{venue.name}</span></span>}
          </p>
        </div>
        <div className="flex flex-none flex-col items-end gap-1.5">
          {statusChip}
          {isToday && <span className="type-label-s text-primary">Today</span>}
        </div>
      </header>

      <div className="mt-3 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-highest" role="img" aria-label={`${slots.length} of ${show.slotCount} slots filled`}>
          <div className={cx("h-full rounded-full", off ? "bg-outline" : "bg-primary")} style={{ width: `${Math.min(100, (slots.length / Math.max(1, show.slotCount)) * 100)}%` }} />
        </div>
        <span className="type-label-m text-on-surface-variant tabular">{slots.length}/{show.slotCount}</span>
      </div>

      {loading ? (
        <div className="mt-3 h-24 animate-pulse rounded-md bg-surface-container" />
      ) : (
        <ol className={cx("mt-3 flex flex-col gap-1.5", off && "opacity-60")}>
          {slots.map((s, i) => {
            const pills = comicPills({ comic: comicsById.get(s.comicId), request: asks.find((r) => r.comicId === s.comicId), show, lastWeek, states: statesFor(s.comicId), days: false }, s.comicId);
            return (
              <li key={s.comicId} className="flex h-10 items-center gap-2.5 rounded-md bg-surface-container pr-3 pl-2">
                <span className="w-4 flex-none text-center type-label-m text-on-surface-variant tabular">{i + 1}</span>
                <Avatar name={name(s.comicId)} size={28} />
                <span className="min-w-0 flex-1 truncate type-body-m">{name(s.comicId)}</span>
                <PillRow pills={pills} max={1} className="flex-none" />
              </li>
            );
          })}
          {open && !off && !past && (
            <li className={cx("grid place-items-center rounded-md border border-dashed border-outline-variant type-body-s text-on-surface-variant/70", slots.length ? "h-10" : "h-14")}>
              {slots.length ? `${show.slotCount - slots.length} open slot${show.slotCount - slots.length === 1 ? "" : "s"}` : seeds.length ? "Nobody on the lineup yet" : "No lineup yet"}
            </li>
          )}
          {!slots.length && (off || past) && <li className="px-1 type-body-s text-on-surface-variant">Nobody was on the lineup.</li>}
        </ol>
      )}

      {changes && changes.removed.length > 0 && <p className="mt-2 px-1 type-body-s text-tertiary">Removed, not told yet: {changes.removed.map((d) => first(name(d))).join(", ")}</p>}
      {lineup?.dropped?.length ? <p className="mt-2 px-1 type-body-s text-error">Dropped out: {lineup.dropped.map((d) => first(name(d.comicId))).join(", ")}</p> : null}

      {seeds.length > 0 && (
        <p className="mt-3 flex items-start gap-1.5 type-body-s text-on-surface-variant">
          <IconSparkle className="icon mt-0.5 size-4 flex-none text-primary" />
          <span>Starts with {listNames(seeds)} (regulars and co-hosts).</span>
        </p>
      )}
      {!past && !off && (wantsDay.length > 0 || anyDay.length > 0) && !confirmed && (
        <p className="mt-3 flex items-start gap-1.5 type-body-s text-on-surface-variant">
          <IconInbox className="icon mt-0.5 size-4 flex-none text-primary" />
          <span>
            {wantsDay.length > 0 ? <><span className="text-on-surface">{wantsDay.length} asking for {DAY_SHORT[show.weekday]}</span>: {listNames(wantsDay.map((r) => r.comicName))}</> : null}
            {wantsDay.length > 0 && anyDay.length > 0 ? ". " : null}
            {anyDay.length > 0 ? <>{anyDay.length} open to any day.</> : null}
          </span>
        </p>
      )}

      {mic && (
        <div className="mt-3 rounded-md bg-secondary-container p-3 text-on-secondary-container">
          <p className="type-body-m">Did <span className="type-title-s">{show.name}</span> happen?</p>
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button size="sm" variant="text" className="text-on-secondary-container" onClick={() => void markCanned(uid, mic, show, comicsById).then(() => updateDoc(userDoc(uid, "lineups", mic.id), { outcome: "canned" })).catch((e: Error) => toast.error(e.message))}>
              No
            </Button>
            <Button size="sm" icon={IconCheck} onClick={() => answerMicCheck(uid, mic, "happened")}>
              Yes, it happened
            </Button>
          </div>
        </div>
      )}
      {past && confirmed && lineup?.outcome === "happened" && slots.length > 0 && <p className="mt-3 type-body-s text-on-surface-variant">Performed: {listNames(ids.map(name))}</p>}

      <div className="min-h-3 flex-1" />
      <footer className="mt-3 flex flex-wrap items-center gap-2 border-t border-outline-variant/40 pt-3">
        {canAct && !confirmed && slots.length > 0 && (
          <Button size="sm" icon={IconSend} onClick={() => setConfirmOpen(true)}>Confirm & send</Button>
        )}
        {canAct && confirmed && changes && changes.total > 0 && (
          <Button size="sm" icon={IconSend} onClick={() => setUpdatesOpen(true)}>Send updates</Button>
        )}
        {canAct && confirmed && !(changes && changes.total > 0) && <span className="inline-flex items-center gap-1.5 type-label-m text-on-surface-variant"><IconCheck className="icon size-4 text-primary" />Everyone's been told</span>}
        {canAct && !slots.length && (
          <Link to="/lineup" className={buttonClass({ size: "sm", variant: "tonal", icon: true })}><IconMic className="icon size-4" />Start lineup</Link>
        )}
        {canAct && open && (
          <Button size="sm" variant="outlined" icon={IconUserPlus} onClick={() => setOfferOpen(true)}>Offer a spot</Button>
        )}
        <Link to="/lineup" className={buttonClass({ size: "sm", variant: "text", className: "ml-auto" })}>
          Open lineup <IconArrowRight className="icon size-4" />
        </Link>
      </footer>

      <ConfirmSheet open={confirmOpen} onClose={() => setConfirmOpen(false)} onSending={() => (armed.current = mode === "confirm")} show={show} ids={ids} lineup={lineup} regretsAfter={regretsAfter} />
      {lineup && baseline && <SendUpdatesSheet open={updatesOpen} onClose={() => setUpdatesOpen(false)} show={show} lineup={lineup} baseline={baseline} onSent={() => void (armed.current = mode === "confirm")} />}
      <OfferSheet open={offerOpen} onClose={() => setOfferOpen(false)} show={show} exclude={ids} />
      {lineup && <GroupSyncSheet open={syncOpen} onClose={() => setSyncOpen(false)} show={show} lineup={lineup} />}
    </li>
  );
}

function listNames(names: string[], max = 3) {
  const f = names.map(first);
  return f.length <= max ? f.join(", ") : `${f.slice(0, max).join(", ")} +${f.length - max}`;
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
                <Avatar name={r.comicName} size={28} tone="secondary" />
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
