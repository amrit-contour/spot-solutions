// One show on its day, with its lineup, what still needs doing and every quick action.
// Used full-size in the Day view and inside the event popover / bottom sheet in the Week and Month views.
import { useEffect, useRef, useState } from "react";
import { updateDoc } from "firebase/firestore";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  DAY_SHORT,
  diffLineup,
  formatTime,
  groupModeOf,
  sentSnapshot,
  shiftWeek,
  type Comic,
  type Lineup,
  type Show,
  type SpotRequest,
} from "@spot/shared";
import { useApp } from "../../lib/app";
import { userDoc } from "../../lib/data";
import { markCanned } from "../../lib/lineup";
import { answerMicCheck } from "../../lib/updates";
import { ConfirmSheet } from "../ConfirmSheet";
import { SendUpdatesSheet } from "../SendUpdatesSheet";
import { OfferSheet } from "../OfferSheet";
import { BackfillSheet } from "../BackfillSheet";
import { GroupSyncSheet } from "../GroupSyncSheet";
import { PillRow, comicPills, type TellState } from "../Pills";
import { Avatar, Button, Chip, buttonClass, cx } from "@spot/ui";
import { IconArrowRight, IconCheck, IconClock, IconHistory, IconInbox, IconMap, IconMic, IconSend, IconSparkle, IconUserPlus } from "@spot/ui";
import { laneOf } from "../../routes/Requests";

const first = (name: string) => name.split(" ")[0];

export function listNames(names: string[], max = 3) {
  const f = names.map(first);
  return f.length <= max ? f.join(", ") : `${f.slice(0, max).join(", ")} +${f.length - max}`;
}

export function EventCard({ show, date, today, week, lineup, loading, asks, comicsById, regretsAfter, bare }: { show: Show; date: string; today: string; /** The week this date belongs to (its Monday). */ week: string; lineup?: Lineup; loading: boolean; asks: SpotRequest[]; comicsById: Map<string, Comic>; regretsAfter: number; /** Inside a popover: no card of its own. */ bare?: boolean }) {
  const { uid, venues, currentWeek } = useApp();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [offerOpen, setOfferOpen] = useState(false);
  const [backfillOpen, setBackfillOpen] = useState(false);
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
    <li id={`show-${show.id}-${date}`} className={cx("flex min-w-0 scroll-mt-4 flex-col", !bare && "rounded-lg bg-surface-low p-4", !bare && isToday && "ring-2 ring-primary")}>
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
        <div className="flex-none">
          {statusChip}
          {isToday && <span className="sr-only"> Today</span>}
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
            const pills = comicPills({ comic: comicsById.get(s.comicId), request: asks.find((r) => r.comicId === s.comicId), show, lastWeek, states: statesFor(s.comicId), days: false, adhoc: s.adhoc }, s.comicId);
            return (
              <li key={s.comicId} className="flex h-10 items-center gap-2.5 rounded-md bg-surface-container pr-3 pl-2">
                <span className="w-4 flex-none text-center type-label-m text-on-surface-variant tabular">{i + 1}</span>
                <Avatar name={name(s.comicId)} size={28} />
                <span className="min-w-0 flex-1 truncate type-body-m">{name(s.comicId)}</span>
                <PillRow pills={pills} max={4} compact className="flex-none" />
              </li>
            );
          })}
          {open && !off && !past && (
            <li className={cx("grid place-items-center rounded-md border border-dashed border-outline-variant px-4 py-2 text-center type-body-s text-balance text-on-surface-variant/70", slots.length ? "min-h-10" : "min-h-14")}>
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
      {/* One row in every card, never wrapping: primary action left, Offer a spot (icon only in a narrow card), Open lineup pinned right. */}
      <footer className="@container mt-3 border-t border-outline-variant/40 pt-3">
        <div className="flex h-10 flex-nowrap items-center gap-2">
          {canAct && !confirmed && slots.length > 0 && (
            <Button size="sm" icon={IconSend} onClick={() => setConfirmOpen(true)} className="flex-none">Confirm & send</Button>
          )}
          {canAct && confirmed && changes && changes.total > 0 && (
            <Button size="sm" icon={IconSend} onClick={() => setUpdatesOpen(true)} className="flex-none">Send updates</Button>
          )}
          {canAct && confirmed && !(changes && changes.total > 0) && (
            <span className="inline-flex min-w-0 items-center gap-1.5 type-label-m text-on-surface-variant"><IconCheck className="icon size-4 flex-none text-primary" /><span className="truncate">Everyone's been told</span></span>
          )}
          {past && (
            <Button size="sm" variant="tonal" icon={IconHistory} onClick={() => setBackfillOpen(true)} className="flex-none">Record who performed</Button>
          )}
          {canAct && !slots.length && (
            <Link to="/lineup" className={buttonClass({ size: "sm", variant: "tonal", icon: true, className: "flex-none" })}><IconMic className="icon size-4" />Start lineup</Link>
          )}
          {canAct && open && (
            <button
              type="button"
              onClick={() => setOfferOpen(true)}
              aria-label="Offer a spot"
              title="Offer a spot"
              className={buttonClass({ size: "sm", variant: "outlined", icon: true, className: "flex-none @max-[24rem]:size-8 @max-[24rem]:px-0" })}
            >
              <IconUserPlus className="icon size-4" />
              <span className="@max-[24rem]:hidden">Offer a spot</span>
            </button>
          )}
          <Link to="/lineup" aria-label="Open lineup" title="Open lineup" className="state-layer pressable -mr-2 ml-auto grid size-10 flex-none place-items-center rounded-full text-primary">
            <IconArrowRight className="icon size-5" />
          </Link>
        </div>
      </footer>

      <ConfirmSheet open={confirmOpen} onClose={() => setConfirmOpen(false)} onSending={() => (armed.current = mode === "confirm")} show={show} ids={ids} lineup={lineup} regretsAfter={regretsAfter} />
      {lineup && baseline && <SendUpdatesSheet open={updatesOpen} onClose={() => setUpdatesOpen(false)} show={show} lineup={lineup} baseline={baseline} onSent={() => void (armed.current = mode === "confirm")} />}
      <BackfillSheet open={backfillOpen} onClose={() => setBackfillOpen(false)} show={show} week={week} />
      <OfferSheet open={offerOpen} onClose={() => setOfferOpen(false)} show={show} exclude={ids} />
      {lineup && <GroupSyncSheet open={syncOpen} onClose={() => setSyncOpen(false)} show={show} lineup={lineup} />}
    </li>
  );
}
