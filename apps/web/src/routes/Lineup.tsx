import { useEffect, useMemo, useRef, useState } from "react";
import { where } from "firebase/firestore";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  DAY_NAMES,
  DAY_SHORT,
  INTENT_THRESHOLD,
  dateInWeek,
  formatDate,
  formatTime,
  localNow,
  pendingRejections,
  renderTemplate,
  shiftWeek,
  type Comic,
  type Lineup,
  type Show,
  type Slot,
  type SpotRequest,
  type HostPoll,
  type SpotOffer,
} from "@spot/shared";
import { useApp } from "../lib/app";
import { runCommand, useCollection, useDocument } from "../lib/data";
import { OfferSheet } from "../components/OfferSheet";
import { markCanned, markRequest, placeComic, repeatLastWeek, setLineupStatus, setSlots, unplaceComic } from "../lib/lineup";
import { PageHeader } from "../components/Shell";
import { WeekSwitcher } from "../components/WeekSwitcher";
import { Menu, MenuItem } from "../components/Menu";
import { GroupSyncSheet } from "../components/GroupSyncSheet";
import { Avatar, Bubble, Button, Chip, Empty, IconButton, Sheet, cx } from "../components/ui";
import { IconAdd, IconCalendarMark, IconCancel, IconChatCross, IconCheck, IconClose, IconClock, IconGroup, IconHistory, IconMenuDots, IconMic, IconRepeat, IconSend, IconSofa, IconStar } from "../components/icons";

const BENCH = "bench";

type Columns = Record<string, string[]>;

export function LineupBoard() {
  const { uid, week, shows, comicsById } = useApp();
  const requests = useCollection<SpotRequest>(uid, "requests", [where("weekOf", "==", week)], week);
  const lineups = useCollection<Lineup>(uid, "lineups", [where("weekOf", "==", week)], week);
  const offers = useCollection<SpotOffer>(uid, "offers", [where("weekOf", "==", week)], week);
  const poll = useDocument<HostPoll>(["users", uid, "polls", week]);
  const activeShows = useMemo(() => shows.filter((s) => s.active), [shows]);
  const lastWeek = shiftWeek(week, -1);

  const lineupByShow = useMemo(() => new Map(lineups.data.map((l) => [l.showId, l])), [lineups.data]);
  const requestByComic = useMemo(() => new Map(requests.data.map((r) => [r.comicId, r])), [requests.data]);

  // Source of truth from Firestore → local columns (overridden while dragging).
  const remote = useMemo<Columns>(() => {
    const placed = new Set<string>();
    const cols: Columns = {};
    for (const s of activeShows) {
      cols[s.id] = (lineupByShow.get(s.id)?.slots ?? []).map((x) => x.comicId);
      cols[s.id].forEach((c) => placed.add(c));
    }
    cols[BENCH] = requests.data
      .filter((r) => !["dismissed", "rejected"].includes(r.status) && !placed.has(r.comicId) && (!r.hold || r.holdOverridden) && (r.intent.confidence >= INTENT_THRESHOLD || r.status !== "new"))
      .sort((a, b) => {
        const pa = comicsById.get(a.comicId)?.lastPerformedWeek === lastWeek ? 1 : 0;
        const pb = comicsById.get(b.comicId)?.lastPerformedWeek === lastWeek ? 1 : 0;
        return pa - pb || a.createdAt - b.createdAt;
      })
      .map((r) => r.comicId);
    return cols;
  }, [activeShows, lineupByShow, requests.data, comicsById, lastWeek]);

  const [cols, setCols] = useState<Columns>(remote);
  const [activeId, setActiveId] = useState<string | null>(null);
  const dragFrom = useRef<string | null>(null);
  useEffect(() => {
    if (!activeId) setCols(remote);
  }, [remote, activeId]);

  // Touch: long-press to drag, so a normal swipe still scrolls the page.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const addTo = async (cid: string, show: Show) => {
    await placeComic(uid, week, show, cid, lineups.data);
    toast.success(`${(comicsById.get(cid)?.name ?? requestByComic.get(cid)?.comicName ?? "Comic").split(" ")[0]} → ${show.name}`);
  };
  const removeFrom = (cid: string, show: Show) => unplaceComic(uid, week, show, cid, lineupByShow.get(show.id));
  const containerOf = (id: string) => (id in cols ? id : Object.keys(cols).find((k) => cols[k].includes(id)));
  const locked = (showId: string) => lineupByShow.get(showId)?.status === "confirmed";

  const onStart = ({ active }: DragStartEvent) => {
    setActiveId(String(active.id));
    dragFrom.current = containerOf(String(active.id)) ?? null;
  };

  const onOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    const from = containerOf(String(active.id));
    const to = containerOf(String(over.id));
    if (!from || !to || from === to || (to !== BENCH && locked(to))) return;
    setCols((c) => {
      const fromItems = c[from].filter((x) => x !== active.id);
      const overIdx = c[to].indexOf(String(over.id));
      const toItems = [...c[to]];
      toItems.splice(overIdx >= 0 ? overIdx : toItems.length, 0, String(active.id));
      return { ...c, [from]: fromItems, [to]: toItems };
    });
  };

  const onEnd = async ({ active, over }: DragEndEvent) => {
    const id = String(active.id);
    const origin = dragFrom.current;
    setActiveId(null);
    if (!over || !origin) return setCols(remote);
    const to = containerOf(String(over.id));
    if (!to) return setCols(remote);
    let next = cols;
    if (to === containerOf(id)) {
      const oldIdx = cols[to].indexOf(id);
      const newIdx = cols[to].indexOf(String(over.id));
      if (newIdx >= 0 && oldIdx !== newIdx) next = { ...cols, [to]: arrayMove(cols[to], oldIdx, newIdx) };
      setCols(next);
    }
    const touched = new Set([origin, to].filter((k) => k !== BENCH));
    const keepMinutes = (show: Show, ids: string[]): Slot[] => {
      const prev = new Map<string, Slot>();
      for (const l of lineups.data) for (const s of l.slots) prev.set(s.comicId, s);
      return ids.map((cid) => ({ comicId: cid, minutes: prev.get(cid)?.minutes ?? (show.includeSlotTime ? (show.defaultMinutes ?? null) : null) }));
    };
    try {
      for (const sid of touched) {
        const show = activeShows.find((s) => s.id === sid);
        if (show && !locked(sid)) await setSlots(uid, week, show, keepMinutes(show, next[sid]));
      }
      if (origin !== to) await markRequest(uid, week, id, to !== BENCH);
    } catch (e) {
      toast.error((e as Error).message);
      setCols(remote);
    }
  };

  const activeComic = activeId ? comicsById.get(activeId) : undefined;
  const placedAll = new Set(lineups.data.flatMap((l) => l.slots.map((x) => x.comicId)));
  const regrets = pendingRejections(requests.data, placedAll);
  const openShows = activeShows.filter((s) => !["confirmed", "cancelled"].includes(lineupByShow.get(s.id)?.status ?? "draft"));

  if (!activeShows.length) {
    return (
      <div className="w-full">
        <PageHeader title="Lineup" actions={<WeekSwitcher />} />
        <Empty icon={IconCalendarMark} title="No shows yet" action={<Link to="/shows"><Button icon={IconCalendarMark}>Set up shows</Button></Link>}>
          Add the mics you curate (venue, day, time, slot count) and they'll show up here as columns.
        </Empty>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Lineup"
        subtitle={`${Object.entries(cols).filter(([k]) => k !== BENCH).reduce((n, [, v]) => n + v.length, 0)} placed across ${activeShows.length} show${activeShows.length > 1 ? "s" : ""}`}
        actions={
          <>
            <HostPollButton />
            <WeekSwitcher />
          </>
        }
      />
      <RegretBanner count={regrets.length} openShows={openShows.length} />
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onStart} onDragOver={onOver} onDragEnd={onEnd} onDragCancel={() => (setActiveId(null), setCols(remote))}>
        <div className="flex flex-col gap-4 px-4 pb-10 sm:px-8 lg:flex-row lg:items-start">
          <Column id={BENCH} className="lg:sticky lg:top-4 lg:w-72 lg:flex-none">
            <div className="mb-3 flex items-center justify-between px-1">
              <div>
                <h2 className="type-title-m">Waiting</h2>
                <p className="type-body-s text-on-surface-variant"><span className="sm:hidden">Tap + or long-press to drag</span><span className="hidden sm:inline">Drag into a show</span></p>
              </div>
              <span className="rounded-full bg-surface-high px-2 py-0.5 type-label-m tabular">{cols[BENCH]?.length ?? 0}</span>
            </div>
            <SortableContext items={cols[BENCH] ?? []} strategy={verticalListSortingStrategy}>
              <ul className="flex min-h-24 flex-col gap-2">
                {(cols[BENCH] ?? []).map((cid) => (
                  <ComicTile
                    key={cid}
                    id={cid}
                    comic={comicsById.get(cid)}
                    request={requestByComic.get(cid)}
                    lastWeek={lastWeek}
                    action={
                      <Menu align="right" trigger={(t) => <IconButton icon={IconAdd} label="Add to a show" onClick={t} className="size-9" />}>
                        {(close) =>
                          activeShows.map((s) => {
                            const l = lineupByShow.get(s.id);
                            const preferred = requestByComic.get(cid)?.intent.preferredDays.includes(s.weekday);
                            return (
                              <MenuItem key={s.id} highlighted={preferred} hint={`${l?.slots.length ?? 0}/${s.slotCount}`} disabled={l?.status === "confirmed" || l?.status === "cancelled"} onClick={() => (close(), void addTo(cid, s))}>
                                {s.name}
                                <span className="block type-body-s text-on-surface-variant">{DAY_SHORT[s.weekday]} · {formatTime(s.startTime)}</span>
                              </MenuItem>
                            );
                          })
                        }
                      </Menu>
                    }
                  />
                ))}
                {!cols[BENCH]?.length && (
                  <li className="flex flex-col items-center gap-2 rounded-md border border-dashed border-outline-variant px-4 py-8 text-center type-body-m text-on-surface-variant">
                    <IconSofa className="icon size-6 text-primary" />
                    Everyone's placed.
                  </li>
                )}
              </ul>
            </SortableContext>
          </Column>

          <div className="grid flex-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {activeShows.map((show) => (
              <ShowColumn key={show.id} offers={offers.data} poll={poll.data} onAdd={(cid) => addTo(cid, show)} onRemove={(cid) => void removeFrom(cid, show)} regretsAfter={openShows.length === 1 && openShows[0].id === show.id ? regrets.length : 0} show={show} ids={cols[show.id] ?? []} lineup={lineupByShow.get(show.id)} comicsById={comicsById} requestByComic={requestByComic} lastWeek={lastWeek} />
            ))}
          </div>
        </div>
        <DragOverlay dropAnimation={{ duration: 220, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }}>
          {activeId ? (
            <motion.div initial={{ transform: "scale(1)" }} animate={{ transform: "scale(1.03)", rotate: -1 }} transition={{ type: "spring", duration: 0.3, bounce: 0.3 }} className="rounded-md shadow-xl">
              <TileBody comic={activeComic} id={activeId} request={requestByComic.get(activeId)} lastWeek={lastWeek} lifted />
            </motion.div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function Column({ id, children, className }: { id: string; children: React.ReactNode; className?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <section ref={setNodeRef} className={cx("rounded-xl bg-surface-low p-3 transition-[box-shadow] duration-150", isOver && "shadow-[inset_0_0_0_2px_var(--md-sys-color-primary)]", className)}>
      {children}
    </section>
  );
}

function TileBody({ comic, id, request, lastWeek, lifted, index, minutes, action }: { comic?: Comic; id: string; request?: SpotRequest; lastWeek: string; lifted?: boolean; index?: number; minutes?: number | null; action?: React.ReactNode }) {
  const name = comic?.name ?? request?.comicName ?? `+${id.split("@")[0]}`;
  const performed = comic?.lastPerformedWeek === lastWeek;
  return (
    <div className={cx("flex min-h-14 items-center gap-3 rounded-md py-2 pl-3", action ? "pr-1" : "pr-3", lifted ? "bg-surface-highest" : "bg-surface-container")}>
      {index !== undefined ? <span className="w-5 text-center type-label-l text-on-surface-variant tabular">{index + 1}</span> : <Avatar name={name} size={32} tone={performed ? "secondary" : "primary"} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate type-title-s">{name}</span>
          {comic?.tier && comic.tier !== "open" && <IconStar className="icon size-3.5 flex-none text-tertiary" aria-label={comic.tier} />}
        </div>
        <div className="flex items-center gap-1.5 type-body-s text-on-surface-variant">
          {performed && (
            <span className="inline-flex items-center gap-0.5">
              <IconHistory className="icon size-3.5" /> last week
            </span>
          )}
          {request?.intent.preferredDays.length ? <span>{request.intent.preferredDays.map((d) => DAY_SHORT[d]).join(" · ")}</span> : !performed && <span>any day</span>}
        </div>
      </div>
      {minutes ? (
        <span className="inline-flex items-center gap-1 type-label-m text-on-surface-variant tabular">
          <IconClock className="icon size-3.5" />
          {minutes}m
        </span>
      ) : null}
      {action && (
        // Stop the drag sensors from treating a tap on the button as the start of a drag.
        <span onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          {action}
        </span>
      )}
    </div>
  );
}

function ComicTile({ id, comic, request, lastWeek, index, minutes, disabled, action }: { id: string; comic?: Comic; request?: SpotRequest; lastWeek: string; index?: number; minutes?: number | null; disabled?: boolean; action?: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx("select-none [-webkit-touch-callout:none]", !disabled && "cursor-grab active:cursor-grabbing", isDragging && "opacity-30")}
      {...attributes}
      {...listeners}
    >
      <TileBody comic={comic} id={id} request={request} lastWeek={lastWeek} index={index} minutes={minutes} action={action} />
    </li>
  );
}

function ShowColumn({ offers, poll, onAdd, onRemove, regretsAfter, show, ids, lineup, comicsById, requestByComic, lastWeek }: { offers: SpotOffer[]; poll: HostPoll | null; onAdd: (cid: string) => Promise<void>; onRemove: (cid: string) => void; regretsAfter: number; show: Show; ids: string[]; lineup?: Lineup; comicsById: Map<string, Comic>; requestByComic: Map<string, SpotRequest>; lastWeek: string }) {
  const { uid, week, venues, settings } = useApp();
  const venue = venues.find((v) => v.id === show.venueId);
  const status = lineup?.status ?? "draft";
  const confirmed = status === "confirmed";
  const canned = status === "canned";
  // Canned and cancelled both mean the mic is off; only the label differs.
  const cancelled = status === "cancelled" || canned;
  const showDate = dateInWeek(week, show.weekday);
  const past = localNow(new Date(), settings.timezone).date >= showDate;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [offerOpen, setOfferOpen] = useState(false);
  const pendingOffers = offers.filter((o) => o.showId === show.id && o.status === "pending");
  const hostsFree = Object.entries(poll?.votes ?? {}).filter(([, v]) => v.includes(show.id)).map(([k]) => ({ id: k.replace(/_/g, "."), name: poll?.voterNames[k] ?? k }));
  const fill = Math.min(1, ids.length / Math.max(1, show.slotCount));
  const minutesOf = new Map(lineup?.slots.map((s) => [s.comicId, s.minutes]));

  // Open the group review the moment the worker finishes computing the diff.
  const syncStatus = lineup?.groupSync?.status;
  const prevSync = useRef(syncStatus);
  useEffect(() => {
    if (prevSync.current !== "pending" && syncStatus === "pending") setSyncOpen(true);
    prevSync.current = syncStatus;
  }, [syncStatus]);

  const repeat = async () => {
    const n = await repeatLastWeek(uid, week, show);
    toast(n ? `Brought back last week's ${n} comics` : "Last week's lineup was empty");
  };

  return (
    <Column id={show.id} className={cx(cancelled && "opacity-60")}>
      <header className="mb-3 px-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="type-label-m text-primary">
              {DAY_NAMES[show.weekday]} · {formatDate(dateInWeek(week, show.weekday))} · {formatTime(show.startTime)}
            </p>
            <h2 className="mt-0.5 truncate type-title-l">{show.name}</h2>
            {venue && <p className="truncate type-body-s text-on-surface-variant">{venue.name}</p>}
          </div>
          {confirmed ? (
            <div className="flex items-center gap-1">
            <Chip tone="success" icon={IconCheck}>Sent</Chip>
            <Menu align="right" trigger={(t) => <IconButton icon={IconMenuDots} label="Show options" onClick={t} className="size-9" />}>
              {(close) => (
                <>
                <MenuItem disabled={past || ids.length >= show.slotCount} hint={ids.length >= show.slotCount ? "full" : undefined} onClick={() => (close(), setOfferOpen(true))}>
                  Offer a spot…
                </MenuItem>
                <MenuItem
                  disabled={!past}
                  hint={past ? undefined : "after the show"}
                  onClick={() => {
                    close();
                    if (lineup && confirm(`Mark ${show.name} as not happening? It won't count as a spot for anyone on it.`)) void markCanned(uid, lineup, show, comicsById).then(() => toast("Marked as didn't happen"));
                  }}
                >
                  Mic didn't happen
                </MenuItem>
                </>
              )}
            </Menu>
            </div>
          ) : cancelled ? (
            <Chip tone="error" icon={IconCancel}>{canned ? "Didn't happen" : "Cancelled"}</Chip>
          ) : (
            <Menu
              align="right"
              trigger={(t) => <IconButton icon={IconMenuDots} label="Show options" onClick={t} className="size-9" />}
            >
              {(close) => (
                <>
                  <MenuItem onClick={() => (close(), void repeat())}>Repeat last week's lineup</MenuItem>
                  <MenuItem disabled={ids.length >= show.slotCount} onClick={() => (close(), setOfferOpen(true))}>Offer a spot…</MenuItem>
                  <MenuItem onClick={() => (close(), void setLineupStatus(uid, week, show, "cancelled"))}>Mark mic cancelled</MenuItem>
                </>
              )}
            </Menu>
          )}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-highest">
            <motion.div className={cx("h-full rounded-full", fill >= 1 ? "bg-tertiary" : "bg-primary")} animate={{ width: `${fill * 100}%` }} transition={{ type: "spring", duration: 0.5, bounce: 0.1 }} />
          </div>
          <span className="type-label-m tabular text-on-surface-variant">
            {ids.length}/{show.slotCount}
          </span>
        </div>
      </header>

      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ol className="flex min-h-32 flex-col gap-2">
          {ids.map((cid, i) => (
            <ComicTile key={cid} id={cid} index={i} comic={comicsById.get(cid)} request={requestByComic.get(cid)} lastWeek={lastWeek} minutes={show.includeSlotTime ? (minutesOf.get(cid) ?? show.defaultMinutes) : null} disabled={confirmed} action={confirmed || cancelled ? undefined : <IconButton icon={IconClose} label="Remove from show" onClick={() => onRemove(cid)} className="size-9" />} />
          ))}
          {Array.from({ length: Math.max(0, Math.min(3, show.slotCount - ids.length)) }).map((_, i) => (
            <li key={`empty-${i}`} className="grid h-12 place-items-center rounded-md border border-dashed border-outline-variant type-body-s text-on-surface-variant/70">
              {i === 0 && !ids.length ? "Drop comics here" : `Slot ${ids.length + i + 1}`}
            </li>
          ))}
        </ol>
      </SortableContext>

      {pendingOffers.length > 0 && (
        <p className="mt-2 px-1 type-body-s text-on-surface-variant">Offer out to {pendingOffers.map((o) => o.comicName.split(" ")[0]).join(", ")}, waiting for a reply</p>
      )}
      {hostsFree.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 px-1">
          <span className="type-label-m text-on-surface-variant">Hosts free:</span>
          {hostsFree.map((h) => (
            <Chip key={h.id} tone="tertiary" onClick={comicsById.has(h.id) && !confirmed && !cancelled ? () => void onAdd(h.id) : undefined}>
              {h.name}
            </Chip>
          ))}
        </div>
      )}
      {lineup?.dropped?.length ? (
        <p className="mt-2 px-1 type-body-s text-error">Dropped out: {lineup.dropped.map((d) => comicsById.get(d.comicId)?.name ?? "comic").join(", ")}</p>
      ) : null}

      <footer className="mt-3 flex flex-wrap items-center gap-2">
        {canned ? null : cancelled ? (
          <Button size="sm" variant="text" onClick={() => setLineupStatus(uid, week, show, "draft")}>Reopen</Button>
        ) : confirmed ? (
          <>
            <span className="inline-flex flex-1 items-center gap-1.5 type-label-m text-on-surface-variant">
              <svg viewBox="0 0 24 24" className="draw-check size-4 text-primary" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
              Confirmations sent
              {show.groupMode === "show_day" && show.groupId && <span className="text-on-surface-variant/80"> · group updates {lineup?.showDaySyncedOn ? "done" : `on the day at ${formatTime(show.showDaySyncTime ?? "12:00")}`}</span>}
            </span>
            {show.groupId && (
              <Button size="sm" variant="tonal" icon={IconGroup} onClick={() => setSyncOpen(true)}>
                Group
              </Button>
            )}
          </>
        ) : (
          <>
            {!ids.length && (
              <Button size="sm" variant="text" icon={IconRepeat} onClick={repeat}>
                Repeat last week
              </Button>
            )}
            <div className="flex-1" />
            <Button size="sm" icon={IconSend} disabled={!ids.length} onClick={() => setConfirmOpen(true)}>
              Confirm & send
            </Button>
          </>
        )}
      </footer>

      <ConfirmSheet open={confirmOpen} onClose={() => setConfirmOpen(false)} show={show} ids={ids} lineup={lineup} regretsAfter={regretsAfter} />
      <OfferSheet open={offerOpen} onClose={() => setOfferOpen(false)} show={show} exclude={ids} />
      {lineup && <GroupSyncSheet open={syncOpen} onClose={() => setSyncOpen(false)} show={show} lineup={lineup} />}
    </Column>
  );
}

function ConfirmSheet({ open, onClose, show, ids, lineup, regretsAfter }: { open: boolean; onClose: () => void; show: Show; ids: string[]; lineup?: Lineup; regretsAfter: number }) {
  const { uid, week, settings, venues, comicsById } = useApp();
  const [sending, setSending] = useState(false);
  const venue = venues.find((v) => v.id === show.venueId);
  const minutesOf = new Map(lineup?.slots.map((s) => [s.comicId, s.minutes]));
  const preview = (cid: string) =>
    renderTemplate(settings.confirm.template, {
      name: (comicsById.get(cid)?.name ?? "").split(" ")[0],
      show: show.name,
      venue: venue?.name,
      mapsLink: venue?.mapsLink,
      day: DAY_NAMES[show.weekday],
      date: formatDate(dateInWeek(week, show.weekday)),
      time: formatTime(show.startTime),
      minutes: show.includeSlotTime ? (minutesOf.get(cid) ?? show.defaultMinutes) : null,
    });

  const send = async () => {
    setSending(true);
    const t = toast.loading(`Sending ${ids.length} confirmations, a few seconds apart…`);
    try {
      await runCommand(uid, "send_confirmations", { lineupId: `${week}_${show.id}` }, 15 * 60_000);
      toast.success(`${show.name} is locked in`, { id: t });
      onClose();
    } catch (e) {
      toast.error((e as Error).message, { id: t });
    } finally {
      setSending(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Confirm ${show.name}`}
      wide
      footer={
        <>
          <Button variant="text" onClick={onClose}>Not yet</Button>
          <Button icon={IconSend} loading={sending} onClick={send}>
            Send {ids.length} confirmation{ids.length > 1 ? "s" : ""}
          </Button>
        </>
      }
    >
      <p className="type-body-m text-on-surface-variant">
        Each comic gets their own WhatsApp message, spaced a few seconds apart.
        {show.groupId ? " Then you'll review who to add to and remove from the show's group." : ""}
      </p>
      {settings.reject.enabled && regretsAfter > 0 && (
        <p className="mt-3 flex items-start gap-2 rounded-md bg-surface-container p-3 type-body-m text-on-surface-variant">
          <IconChatCross className="icon mt-0.5 size-4 flex-none text-primary" />
          This is the last show this week, so the {regretsAfter} comic{regretsAfter > 1 ? "s" : ""} still waiting will also get your regret message.
        </p>
      )}
      <ul className="mt-5 flex flex-col gap-5">
        <AnimatePresence initial={false}>
          {ids.map((cid, i) => (
            <motion.li key={cid} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: i * 0.03 } }} className="flex flex-col gap-2">
              <span className="flex items-center gap-2 type-label-l">
                <span className="w-5 text-on-surface-variant tabular">{i + 1}</span>
                {comicsById.get(cid)?.name ?? cid}
              </span>
              <Bubble outgoing>{preview(cid)}</Bubble>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      {!ids.length && <Empty icon={IconMic} title="No one placed yet" />}
    </Sheet>
  );
}

function RegretBanner({ count, openShows }: { count: number; openShows: number }) {
  const { uid, week, settings } = useApp();
  const [busy, setBusy] = useState(false);
  if (!count || !settings.reject.enabled) return null;
  const final = openShows === 0;
  const send = async () => {
    setBusy(true);
    const t = toast.loading(`Sending ${count} regret message${count > 1 ? "s" : ""}…`);
    try {
      const r = await runCommand<{ sent: number }>(uid, "send_rejections", { weekOf: week, onlyIfFinal: true }, 15 * 60_000);
      toast.success(`${r.sent} regret${r.sent === 1 ? "" : "s"} sent`, { id: t });
    } catch (e) {
      toast.error((e as Error).message, { id: t });
    } finally {
      setBusy(false);
    }
  };
  return (
    <motion.div initial={{ opacity: 0, transform: "translateY(-4px)" }} animate={{ opacity: 1, transform: "translateY(0px)" }} className="mx-4 mb-4 flex flex-wrap items-center gap-3 rounded-lg bg-surface-container px-4 py-3 sm:mx-8">
      <IconChatCross className="icon size-5 text-primary" />
      <p className="flex-1 type-body-m text-on-surface-variant">
        {final ? (
          <><span className="text-on-surface">{count} comic{count > 1 ? "s" : ""}</span> asked but didn't make it this week.</>
        ) : (
          <><span className="text-on-surface">{count} still waiting.</span> They'll get your regret message once {openShows === 1 ? "the last show is" : `all ${openShows} open shows are`} confirmed.</>
        )}
      </p>
      {final && (
        <Button size="sm" variant="tonal" icon={IconSend} loading={busy} onClick={send}>
          Send regrets
        </Button>
      )}
    </motion.div>
  );
}

function HostPollButton() {
  const { uid, week, settings } = useApp();
  const poll = useDocument<HostPoll>(["users", uid, "polls", week]);
  const [busy, setBusy] = useState(false);
  if (!settings.hostPoll.groupId) return null;
  const votes = Object.keys(poll.data?.votes ?? {}).length;
  return (
    <Button
      variant="tonal"
      icon={IconGroup}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await runCommand(uid, "send_host_poll", { weekOf: week }, 120_000);
          toast.success("Poll sent to your hosts group");
        } catch (e) {
          toast.error((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {poll.data ? `Hosts poll · ${votes} voted` : "Ask hosts"}
    </Button>
  );
}
