import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { doc, getDoc, where } from "firebase/firestore";
import { db } from "@spot/ui/firebase";
import { Link } from "react-router-dom";
import { createPortal } from "react-dom";
import { LayoutGroup, motion } from "motion/react";
import { toast } from "sonner";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCorners,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
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
  diffLineup,
  groupModeOf,
  formatDate,
  formatTime,
  localNow,
  pendingRejections,
  planLineupReset,
  planWeekReset,
  sentSnapshot,
  shiftWeek,
  type Comic,
  type GroupTag,
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
import { ConfirmSheet } from "../components/ConfirmSheet";
import { markCanned, markRequest, addDefaults, placeAsTold, withSelf, placeComic, repeatLastWeek, seedDefaults, setLineupStatus, setMinutes, setSlots, unplaceComic } from "../lib/lineup";
import { PageHeader } from "@spot/ui";
import { WeekSwitcher } from "../components/WeekSwitcher";
import { Menu, MenuItem } from "@spot/ui";
import { GroupSyncSheet } from "../components/GroupSyncSheet";
import { GroupPopover, GroupTab, MemberTileBody } from "../components/GroupPanel";
import { Popover, ToolButton } from "@spot/ui";
import { PillRow, Pill, comicPills, type TellState } from "../components/Pills";
import { BackfillSheet, PAST_SHOW_NOTE } from "../components/BackfillSheet";
import { SendUpdatesSheet } from "../components/SendUpdatesSheet";
import { ReconcileButton } from "../components/ReconcileSheet";
import { ResetDialog } from "../components/ResetDialog";
import { Avatar, Button, Chip, Empty, IconButton, Segmented, Stepper, cx } from "@spot/ui";
import { IconAdd, IconCalendarMark, IconCancel, IconChatCross, IconCheck, IconClose, IconClock, IconGroup, IconHistory, IconMenuDots, IconPen, IconRepeat, IconSend, IconSofa, IconStar, IconUserCheck, IconUserPlus } from "@spot/ui";

const BENCH = "bench";
// Droppables that aren't lineup lists: a group member's leave zone (in the Waiting column's Group tab).
const LEAVE = "leave:";
const MEMBER = "gm:";

type Columns = Record<string, string[]>;

export function LineupBoard() {
  const { uid, week, shows, comics, comicsById, settings } = useApp();
  const requests = useCollection<SpotRequest>(uid, "requests", [where("weekOf", "==", week)], week);
  const lineups = useCollection<Lineup>(uid, "lineups", [where("weekOf", "==", week)], week);
  const prevLineups = useCollection<Lineup>(uid, "lineups", [where("weekOf", "==", shiftWeek(week, -1))], `prev:${week}`);
  const offers = useCollection<SpotOffer>(uid, "offers", [where("weekOf", "==", week)], week);
  const poll = useDocument<HostPoll>(["users", uid, "polls", week]);
  const activeShows = useMemo(() => shows.filter((s) => s.active), [shows]);
  const lastWeek = shiftWeek(week, -1);
  const [resetWeekOpen, setResetWeekOpen] = useState(false);
  const weekPlans = useMemo(() => planWeekReset(lineups.data, requests.data, shows, comics), [lineups.data, requests.data, shows, comics]);

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

  // Tiles glide between Waiting and lineups only for changes you make: while a week's data is still
  // arriving (requests first, then lineups) they'd otherwise animate into place on every load.
  const loaded = !lineups.loading && !requests.loading;
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    if (!loaded) return;
    const t = setTimeout(() => setSettled(true), 500);
    return () => clearTimeout(t);
  }, [loaded, week]);
  const [cols, setCols] = useState<Columns>(remote);
  const colsRef = useRef(cols);
  colsRef.current = cols;
  // A member drag lands on a show (its column or any tile in it) or on a leave zone; Waiting is never a target.
  // A comic drag lands on any list and ignores leave zones.
  const collide = useCallback<CollisionDetection>((args) => {
    const leave = (c: { id: string | number }) => String(c.id).startsWith(LEAVE);
    if (String(args.active.id).startsWith(MEMBER)) {
      const onShow = new Set(Object.entries(colsRef.current).filter(([k]) => k !== BENCH).flatMap(([k, v]) => [k, ...v]));
      return pointerWithin({ ...args, droppableContainers: args.droppableContainers.filter((c) => leave(c) || onShow.has(String(c.id))) });
    }
    return closestCorners({ ...args, droppableContainers: args.droppableContainers.filter((c) => !leave(c)) });
  }, []);
  const [tab, setTab] = useState<"waiting" | "group">("waiting");
  const [dragMember, setDragMember] = useState<{ name: string; tags: GroupTag[] } | null>(null);
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
  const addTo = async (cid: string, show: Show, seed?: { name: string }) => {
    await placeComic(uid, week, show, cid, lineups.data, shows, seed);
    toast.success(`${(comicsById.get(cid)?.name ?? requestByComic.get(cid)?.comicName ?? seed?.name ?? "Comic").split(" ")[0]} → ${show.name}`);
  };
  const addTold = (cid: string, show: Show, name: string) =>
    void placeAsTold(uid, week, show, cid, lineups.data, name)
      .then(() => toast.success(`${name.split(" ")[0]} → ${show.name}`, { description: "Marked as already told, so they won't get a confirmation." }))
      .catch((e: Error) => toast.error(e.message));
  /** A group member's name from any show's cached member list. */
  const memberName = (showId: string, id: string) => shows.find((s) => s.id === showId)?.groupMembers?.members.find((m) => m.id === id)?.name ?? `+${id.split("@")[0]}`;
  const removeFrom = (cid: string, show: Show) => unplaceComic(uid, week, show, cid, lineupByShow.get(show.id));
  const containerOf = (id: string) => (id in cols ? id : Object.keys(cols).find((k) => cols[k].includes(id)));
  // Confirmed lineups stay editable (changes are reviewed in Send updates); only called-off ones are closed.
  // A past show that never went out is edited in the backfill sheet, never by dragging.
  const closed = (showId: string) => {
    const l = lineupByShow.get(showId);
    const show = shows.find((s) => s.id === showId);
    const pastRecord = Boolean(show) && dateInWeek(week, show!.weekday) < localNow(new Date(), settings.timezone).date && (!l || l.status === "draft" || l.backfilled);
    return pastRecord || ["cancelled", "canned"].includes(l?.status ?? "draft");
  };
  // A member dropped on the Leaving zone, waiting for its show's group popover to confirm the removal.
  const [leaveReq, setLeaveReq] = useState<{ showId: string; id: string } | null>(null);
  const groupShows = activeShows.filter((s) => s.groupId);
  const showGroup = tab === "group" && groupShows.length > 0;
  const dragKind = activeId ? (activeId.startsWith(MEMBER) ? "member" : "tile") : null;

  const onStart = ({ active }: DragStartEvent) => {
    setActiveId(String(active.id));
    const d = active.data.current as { name?: string; tags?: GroupTag[] } | undefined;
    setDragMember(String(active.id).startsWith(MEMBER) && d?.name ? { name: d.name, tags: d.tags ?? [] } : null);
    dragFrom.current = containerOf(String(active.id)) ?? null;
  };

  const onOver = ({ active, over }: DragOverEvent) => {
    if (!over || String(active.id).startsWith(MEMBER)) return;
    const from = containerOf(String(active.id));
    const to = containerOf(String(over.id));
    if (!from || !to || from === to || (to !== BENCH && closed(to))) return;
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
    if (id.startsWith(MEMBER)) {
      // gm:{showId}:{comicId}. Only the leave zone of the member's own show does anything.
      const [showId, ...rest] = id.slice(MEMBER.length).split(":");
      const memberId = rest.join(":");
      if (over && String(over.id) === `${LEAVE}${showId}`) return setLeaveReq({ showId, id: memberId });
      // Dropped on a show's slots: put them on that lineup.
      const target = over && !String(over.id).startsWith(LEAVE) ? containerOf(String(over.id)) : null;
      const show = target && target !== BENCH ? activeShows.find((s) => s.id === target) : undefined;
      if (show && !closed(show.id) && !(cols[show.id] ?? []).includes(memberId)) {
        if ((cols[show.id] ?? []).length >= show.slotCount) return void toast.error(`${show.name} is full`);
        // From the group: you already gave them this spot, so they count as told (no confirmation goes out).
        addTold(memberId, show, memberName(showId, memberId));
      }
      return;
    }
    if (!over || !origin || String(over.id).startsWith(LEAVE)) return setCols(remote);
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
      const here = lineups.data.find((l) => l.showId === show.id);
      // Ad hoc stays with the slot; someone dropped onto an already-confirmed lineup is a new ad hoc spot.
      const adhocOf = (cid: string) => here?.slots.find((x) => x.comicId === cid)?.adhoc ?? (here?.status === "confirmed" && !here.slots.some((x) => x.comicId === cid));
      return ids.map((cid) => ({ comicId: cid, minutes: prev.get(cid)?.minutes ?? (show.includeSlotTime ? (show.defaultMinutes ?? null) : null), ...(adhocOf(cid) && { adhoc: true }) }));
    };
    try {
      for (const sid of touched) {
        const show = activeShows.find((s) => s.id === sid);
        if (show && !closed(sid)) await setSlots(uid, week, show, keepMinutes(show, next[sid]));
      }
      if (origin !== to) await markRequest(uid, week, id, to !== BENCH);
    } catch (e) {
      toast.error((e as Error).message);
      setCols(remote);
    }
  };

  const activeMember = activeId?.startsWith(MEMBER) ? activeId.slice(MEMBER.length).split(":").slice(1).join(":") : null;
  const activeComic = activeId ? comicsById.get(activeMember ?? activeId) : undefined;
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
            <Menu align="right" trigger={(t) => <IconButton icon={IconMenuDots} label="Week options" onClick={t} className="size-9" />}>
              {(close) => (
                <MenuItem disabled={!weekPlans.length} hint={weekPlans.length ? undefined : "nothing placed"} onClick={() => (close(), setResetWeekOpen(true))}>
                  Reset this week's lineups…
                </MenuItem>
              )}
            </Menu>
          </>
        }
      />
      <ResetDialog open={resetWeekOpen} onClose={() => setResetWeekOpen(false)} plans={weekPlans} shows={shows} scope="week" />
      <RegretBanner count={regrets.length} openShows={openShows.length} />
      <LayoutGroup>
      <DndContext sensors={sensors} collisionDetection={collide} onDragStart={onStart} onDragOver={onOver} onDragEnd={onEnd} onDragCancel={() => (setActiveId(null), setCols(remote))}>
        <div className="flex flex-col gap-4 px-4 pb-10 sm:px-8 lg:flex-row lg:items-start">
          <Column id={BENCH} className="lg:sticky lg:top-4 lg:w-72 lg:flex-none">
            {groupShows.length > 0 && (
              <div className="mb-3">
                <Segmented full size="sm" value={showGroup ? "group" : "waiting"} onChange={setTab} options={[{ value: "waiting", label: "Waiting" }, { value: "group", label: "Group" }]} />
              </div>
            )}
            <div className="mb-3 flex items-center justify-between px-1">
              <div>
                <h2 className="type-title-m">{showGroup ? "Group members" : "Waiting"}</h2>
                <p className="type-body-s text-on-surface-variant">
                  {showGroup ? (
                    <><span className="sm:hidden">Long-press a member to drag</span><span className="hidden sm:inline">Drag onto a show as already told</span></>
                  ) : (
                    <><span className="sm:hidden">Tap + or long-press to drag</span><span className="hidden sm:inline">Drag into a show</span></>
                  )}
                </p>
              </div>
              {!showGroup && <span className="rounded-full bg-surface-high px-2 py-0.5 type-label-m tabular">{cols[BENCH]?.length ?? 0}</span>}
            </div>
            {showGroup ? (
              <GroupTab shows={groupShows} idsOf={(id) => cols[id] ?? []} lineupOf={(id) => lineupByShow.get(id)} dragging={dragKind === "member"} openShows={activeShows.filter((s) => !closed(s.id))} onAddTold={addTold} />
            ) : (
              <>
            <div className="mb-3"><ReconcileButton lineups={lineups.data} /></div>
            <SortableContext items={cols[BENCH] ?? []} strategy={verticalListSortingStrategy}>
              <ul className="flex min-h-24 flex-col gap-2">
                {(cols[BENCH] ?? []).map((cid) => (
                  <ComicTile
                    key={cid}
                    id={cid}
                    comic={comicsById.get(cid)}
                    request={requestByComic.get(cid)}
                    lastWeek={lastWeek}
                    shared={!activeId && settled}
                    action={
                      <Menu align="right" trigger={(t) => <IconButton icon={IconAdd} label="Add to a show" onClick={t} className="size-9" />}>
                        {(close) =>
                          activeShows.map((s) => {
                            const l = lineupByShow.get(s.id);
                            const preferred = requestByComic.get(cid)?.intent.preferredDays.includes(s.weekday);
                            return (
                              <MenuItem key={s.id} highlighted={preferred} hint={`${l?.slots.length ?? 0}/${s.slotCount}`} disabled={closed(s.id)} onClick={() => (close(), void addTo(cid, s))}>
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
              </>
            )}
          </Column>

          <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {activeShows.map((show) => (
              <ShowColumn key={show.id} elsewhere={[...new Set(activeShows.filter((o) => o.id !== show.id).flatMap((o) => cols[o.id] ?? []))].filter((cid) => !(cols[show.id] ?? []).includes(cid))} dragKind={dragKind} shared={!activeId && settled} lineupsLoaded={!lineups.loading} pendingLeave={leaveReq?.showId === show.id ? leaveReq.id : null} onLeaveHandled={() => setLeaveReq(null)} offers={offers.data} poll={poll.data} prev={prevLineups.data.find((l) => l.showId === show.id)} onAdd={(cid, seed) => addTo(cid, show, seed)} onAddTold={(cid, name) => addTold(cid, show, name)} onRemove={(cid) => void removeFrom(cid, show)} regretsAfter={openShows.length === 1 && openShows[0].id === show.id ? regrets.length : 0} show={show} ids={cols[show.id] ?? []} lineup={lineupByShow.get(show.id)} requests={requests.data} comicsById={comicsById} requestByComic={requestByComic} lastWeek={lastWeek} />
            ))}
          </div>
        </div>
        {/* Portalled to <body>: an ancestor with a transform (the page-enter animation, layout motion) would otherwise become the containing block of the overlay's position:fixed and offset it from the cursor. */}
        {createPortal(
        <DragOverlay dropAnimation={{ duration: 220, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }}>
          {activeId ? (
            <motion.div initial={{ transform: "scale(1)" }} animate={{ transform: "scale(1.03)", rotate: -1 }} transition={{ type: "spring", duration: 0.3, bounce: 0.3 }} className="rounded-md shadow-xl">
              {activeMember ? (
                <MemberTileBody name={dragMember?.name ?? activeComic?.name ?? `+${activeMember.split("@")[0]}`} tags={dragMember?.tags ?? []} lifted />
              ) : (
                <TileBody comic={activeComic} id={activeId} request={requestByComic.get(activeId)} lastWeek={lastWeek} lifted />
              )}
            </motion.div>
          ) : null}
        </DragOverlay>,
          document.body,
        )}
      </DndContext>
      </LayoutGroup>
    </div>
  );
}

function Column({ id, children, className }: { id: string; children: React.ReactNode; className?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <section ref={setNodeRef} className={cx("flex flex-col rounded-xl bg-surface-low p-3 transition-[box-shadow] duration-150", isOver && "shadow-[inset_0_0_0_2px_var(--md-sys-color-primary)]", className)}>
      {children}
    </section>
  );
}

function TileBody({ comic, id, request, lastWeek, lifted, index, minutes, action, show, states, onMinutes, adhoc }: { adhoc?: boolean; comic?: Comic; id: string; request?: SpotRequest; lastWeek: string; lifted?: boolean; index?: number; minutes?: number | null; action?: React.ReactNode; show?: Show; states?: TellState[]; onMinutes?: (m: number) => void }) {
  const name = comic?.name ?? request?.comicName ?? `+${id.split("@")[0]}`;
  const performed = comic?.lastPerformedWeek === lastWeek;
  const pills = comicPills({ comic, request, show, lastWeek, states, adhoc }, id);
  return (
    <div className={cx("flex min-h-14 items-center gap-3 rounded-md py-2 pl-3", action ? "pr-1" : "pr-3", lifted ? "bg-surface-highest" : "bg-surface-container")}>
      {index !== undefined ? <span className="w-5 text-center type-label-l text-on-surface-variant tabular">{index + 1}</span> : <Avatar name={name} size={32} tone={performed ? "secondary" : "primary"} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate type-title-s">{name}</span>
          {comic?.tier && comic.tier !== "open" && <IconStar className="icon size-3.5 flex-none text-tertiary" aria-label={comic.tier} />}
        </div>
        <PillRow pills={pills} className="mt-0.5" />
      </div>
      {minutes && onMinutes ? (
        // Tap to change the set length. Stops the drag sensors like the other buttons.
        <span onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <Menu align="right" trigger={(t) => (
            <button onClick={t} aria-label={`Set length ${minutes} minutes. Change`} className="state-layer pressable inline-flex h-8 items-center gap-1 rounded-full px-2 type-label-m text-on-surface-variant tabular">
              <IconClock className="icon size-3.5" />
              {minutes}m
            </button>
          )}>
            {() => (
              <div className="flex items-center gap-3 px-4 py-3">
                <span className="type-label-l">Set length</span>
                <Stepper value={minutes} onChange={onMinutes} min={1} max={30} suffix="min" />
              </div>
            )}
          </Menu>
        </span>
      ) : minutes ? (
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

function ComicTile({ id, comic, request, lastWeek, index, minutes, disabled, action, show, states, onMinutes, shared, adhoc }: { adhoc?: boolean; id: string; comic?: Comic; request?: SpotRequest; lastWeek: string; index?: number; minutes?: number | null; disabled?: boolean; action?: React.ReactNode; show?: Show; states?: TellState[]; onMinutes?: (m: number) => void; shared?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx("select-none [-webkit-touch-callout:none]", !disabled && "cursor-grab active:cursor-grabbing", isDragging && "opacity-30")}
      {...attributes}
      {...listeners}
    >
      {/* Shared layout: the card glides between Waiting and a lineup. Off while dragging, where dnd-kit moves it. */}
      <motion.div layoutId={shared ? `tile-${id}` : undefined} layout={shared ? "position" : false} transition={{ type: "spring", duration: 0.4, bounce: 0.15 }}>
        <TileBody comic={comic} id={id} request={request} lastWeek={lastWeek} index={index} minutes={minutes} action={action} show={show} states={states} onMinutes={onMinutes} adhoc={adhoc} />
      </motion.div>
    </li>
  );
}

function ShowColumn({ elsewhere, dragKind, shared, lineupsLoaded, pendingLeave, onLeaveHandled, offers, poll, prev, onAdd, onAddTold, onRemove, regretsAfter, show, ids, lineup, requests, comicsById, requestByComic, lastWeek }: { /** On another show this week but not this one. */ elsewhere: string[]; dragKind: "member" | "tile" | null; shared: boolean; lineupsLoaded: boolean; pendingLeave: string | null; onLeaveHandled: () => void; offers: SpotOffer[]; poll: HostPoll | null; prev?: Lineup; onAdd: (cid: string, seed?: { name: string }) => Promise<void>; onAddTold: (cid: string, name: string) => void; onRemove: (cid: string) => void; regretsAfter: number; show: Show; ids: string[]; lineup?: Lineup; requests: SpotRequest[]; comicsById: Map<string, Comic>; requestByComic: Map<string, SpotRequest>; lastWeek: string }) {
  const { uid, week, currentWeek, venues, settings, session } = useApp();
  const venue = venues.find((v) => v.id === show.venueId);
  const status = lineup?.status ?? "draft";
  const confirmed = status === "confirmed";
  const canned = status === "canned";
  // Canned and cancelled both mean the mic is off; only the label differs.
  const cancelled = status === "cancelled" || canned;
  const showDate = dateInWeek(week, show.weekday);
  const today = localNow(new Date(), settings.timezone).date;
  const past = today >= showDate;
  // Past and never sent (or already a record): who performed is recorded in the backfill sheet; nothing is sent.
  const record = showDate < today && (Boolean(lineup?.backfilled) || !lineup || lineup.status === "draft");
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [offerOpen, setOfferOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const resetPlan = lineup ? planLineupReset(lineup, requests, [...comicsById.values()]) : null;
  const pendingOffers = offers.filter((o) => o.showId === show.id && o.status === "pending");
  const hostsFree = Object.entries(poll?.votes ?? {}).filter(([, v]) => v.includes(show.id)).map(([k]) => ({ id: k.replace(/_/g, "."), name: poll?.voterNames[k] ?? k }));
  const fill = Math.min(1, ids.length / Math.max(1, show.slotCount));
  const minutesOf = new Map(lineup?.slots.map((s) => [s.comicId, s.minutes]));
  const mode = groupModeOf(show);

  // A week's lineup starts with the show's POCs (you too, if you're one), regulars, co-hosts and group admins. Once; removals stick.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !lineupsLoaded || lineup?.defaultsSeeded || (lineup && lineup.status !== "draft") || past || week < currentWeek) return;
    const members = show.groupId && show.groupMembers?.groupId === show.groupId ? withSelf(show.groupMembers.members, session) : [];
    const nameOf = (id: string) => comicsById.get(id)?.name ?? members.find((m) => m.id === id)?.name ?? `+${id.split("@")[0]}`;
    const ids = [...new Set([...(show.pocs ?? []), ...(show.regulars ?? []), ...(show.protected ?? []), ...members.filter((m) => m.isAdmin).map((m) => m.id)])];
    if (!ids.length) return;
    seeded.current = true;
    void seedDefaults(uid, week, show, ids.map((id) => ({ id, name: nameOf(id) })))
      .then((n) => n && toast(`${show.name}: added ${n} POC${n === 1 ? "" : "s"}, regular${n === 1 ? "" : "s"}, co-host${n === 1 ? "" : "s"} and admins`, { description: "Take anyone off who isn't on tonight. They stay in the group." }))
      .catch((e: Error) => toast.error(e.message));
  }, [lineupsLoaded, lineup, past, week, currentWeek, show, session?.phone, comicsById, uid]);

  // "Add POCs, regulars and co-hosts": read the group again, then add whoever is missing (any week, any time).
  const [syncingRegulars, setSyncingRegulars] = useState(false);
  const addRegulars = async () => {
    setSyncingRegulars(true);
    try {
      let members = show.groupId && show.groupMembers?.groupId === show.groupId ? show.groupMembers.members : [];
      if (show.groupId) {
        await runCommand(uid, "list_group_members", { showId: show.id }, 3 * 60_000).catch(() => undefined);
        const fresh = (await getDoc(doc(db, "users", uid, "shows", show.id))).data() as Show | undefined;
        if (fresh?.groupMembers?.groupId === show.groupId) members = fresh.groupMembers.members;
      }
      members = show.groupId ? withSelf(members, session) : members;
      const nameOf = (id: string) => comicsById.get(id)?.name ?? members.find((m) => m.id === id)?.name ?? `+${id.split("@")[0]}`;
      const people = [...new Set([...(show.pocs ?? []), ...(show.regulars ?? []), ...(show.protected ?? []), ...members.filter((m) => m.isAdmin).map((m) => m.id)])];
      const n = await addDefaults(uid, week, show, people.map((id) => ({ id, name: nameOf(id) })));
      toast.success(n ? `Added ${n} to ${show.name}` : "Everyone's already on, or the lineup is full");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSyncingRegulars(false);
    }
  };

  // What the comics were last told. Lineups confirmed before that was recorded start from how they stand now.
  const baseline = confirmed && lineup ? (lineup.sent ?? sentSnapshot(lineup.slots, show, lineup.sentAt ?? 0)) : null;
  const changes = baseline && lineup ? diffLineup(lineup.slots, baseline, show) : null;
  const statesFor = (cid: string): TellState[] => {
    if (changes?.added.includes(cid)) return [{ kind: "new", text: "Not told yet" }];
    if (changes) {
      const m = changes.moved.find((x) => x.comicId === cid);
      const t = changes.minutes.find((x) => x.comicId === cid);
      const out: TellState[] = [];
      if (m) out.push({ kind: "moved", text: `Moved from ${m.from}` });
      if (t) out.push({ kind: "minutes", text: `Was ${t.from ?? "?"} min` });
      return out.length ? out : [{ kind: "told", text: "Already told" }];
    }
    return lineup?.sent?.[cid] ? [{ kind: "told", text: "Already told" }] : [];
  };
  const nameOf = (cid: string) => comicsById.get(cid)?.name ?? requestByComic.get(cid)?.comicName ?? `+${cid.split("@")[0]}`;

  // Open the group review when a plan becomes pending during this visit, after the curator pressed confirm, send or sync.
  // The ref starts from the first value seen, so a plan left pending from an earlier visit never pops the sheet.
  const syncStatus = lineup?.groupSync?.status;
  const armed = useRef(false);
  const seen = useRef<{ status: string | undefined } | null>(null);
  useEffect(() => {
    if (!lineupsLoaded) return;
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
  }, [syncStatus, lineupsLoaded]);

  // Last week's lineup for this show was called off: offer to bring its comics back (the usual reason to repeat).
  const [hideRepeat, setHideRepeat] = useState(false);
  const repeatable = !cancelled && !confirmed && prev && (prev.status === "cancelled" || prev.status === "canned") ? prev.slots.map((s) => s.comicId).filter((id) => !ids.includes(id)) : [];
  const repeat = async () => {
    const n = await repeatLastWeek(uid, week, show);
    toast(n ? `Brought back last week's ${n} comics` : "Last week's lineup was empty");
  };

  const syncGroup = async () => {
    if (!lineup && !ids.length) return void toast("Put someone on the lineup first.");
    armed.current = true;
    try {
      await runCommand(uid, "plan_group_sync", { lineupId: `${week}_${show.id}` }, 120_000);
      // A plan that finished within one snapshot never shows as a status change, so open it for the curator who asked.
      setSyncOpen(true);
    } catch (e) {
      armed.current = false;
      toast.error((e as Error).message);
    }
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
          {record ? (
            <Chip tone="neutral" icon={IconHistory}>{canned ? "Didn't happen" : "Past show"}</Chip>
          ) : confirmed ? (
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
                {showDate < today && <MenuItem onClick={() => (close(), setBackfillOpen(true))}>Record who performed…</MenuItem>}
                <MenuItem disabled={!resetPlan} onClick={() => (close(), setResetOpen(true))}>
                  Reset lineup…
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
                  <MenuItem disabled={syncingRegulars || ids.length >= show.slotCount} onClick={() => (close(), void addRegulars())}>
                    Add POCs, regulars and co-hosts
                    <span className="block type-body-s text-on-surface-variant">Reads the group again, adds anyone missing</span>
                  </MenuItem>
                  <MenuItem onClick={() => (close(), void repeat())}>Repeat last week's lineup</MenuItem>
                  {elsewhere.length > 0 && ids.length < show.slotCount && (
                    <>
                      <p className="mt-1 border-t border-outline-variant/40 px-4 pt-2 pb-1 type-label-m text-on-surface-variant">Also put on this show</p>
                      {elsewhere.slice(0, 12).map((cid) => (
                        <MenuItem key={cid} onClick={() => (close(), void onAdd(cid))}>
                          {comicsById.get(cid)?.name ?? `+${cid.split("@")[0]}`}
                          <span className="block type-body-s text-on-surface-variant">{settings.rules.onePerWeek && !(show.pocs?.includes(cid) || show.regulars?.includes(cid) || show.protected?.includes(cid)) ? "Moves them off their other show" : "Stays on their other show too"}</span>
                        </MenuItem>
                      ))}
                    </>
                  )}
                  <MenuItem disabled={ids.length >= show.slotCount} onClick={() => (close(), setOfferOpen(true))}>Offer a spot…</MenuItem>
                  <MenuItem disabled={!resetPlan} onClick={() => (close(), setResetOpen(true))}>Reset lineup…</MenuItem>
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

      {record && (
        <div className="mb-3 flex items-center gap-2 rounded-md bg-tertiary-container/60 py-2 pl-3 pr-1 text-on-tertiary-container">
          <IconHistory className="icon size-4 flex-none" />
          <p className="min-w-0 flex-1 type-body-s">{PAST_SHOW_NOTE}</p>
        </div>
      )}
      {repeatable.length > 0 && !hideRepeat && !record && (
        <div className="mb-3 flex h-11 items-center gap-2 rounded-md bg-tertiary-container/60 pl-3 pr-1 text-on-tertiary-container">
          <IconRepeat className="icon size-4 flex-none" />
          <p className="min-w-0 flex-1 truncate type-body-s" title={`Last week's ${show.name} was called off. Bring back ${repeatable.map((id) => nameOf(id)).join(", ")}`}>Last week was called off</p>
          <Button size="sm" variant="text" className="flex-none text-on-tertiary-container" onClick={() => void repeat()}>Bring back {repeatable.length}</Button>
          <IconButton icon={IconClose} label="Not now" onClick={() => setHideRepeat(true)} className="size-9 flex-none" />
        </div>
      )}
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ol className="flex min-h-32 flex-col gap-2">
          {ids.map((cid, i) => (
            <ComicTile
              key={cid}
              id={cid}
              index={i}
              shared={shared}
              comic={comicsById.get(cid)}
              request={requestByComic.get(cid)}
              lastWeek={lastWeek}
              minutes={show.includeSlotTime ? (minutesOf.get(cid) ?? show.defaultMinutes) : null}
              show={show}
              adhoc={Boolean(lineup?.slots.find((x) => x.comicId === cid)?.adhoc)}
              states={statesFor(cid)}
              onMinutes={lineup && !cancelled ? (m) => void setMinutes(uid, week, show, lineup, cid, m).catch((e: Error) => toast.error(e.message)) : undefined}
              disabled={cancelled || record}
              action={cancelled || record ? undefined : <IconButton icon={IconClose} label="Remove from show" onClick={() => onRemove(cid)} className="size-9" />}
            />
          ))}
          {!record && ids.length < show.slotCount && (
            <li className={cx("grid place-items-center rounded-md border border-dashed border-outline-variant px-4 py-2.5 text-center type-body-s text-balance text-on-surface-variant/70 transition-colors", ids.length ? "min-h-11" : "min-h-20", dragKind && "border-primary/60 text-primary")}>
              {!ids.length ? "Drop comics or group members here" : `${show.slotCount - ids.length} open slot${show.slotCount - ids.length === 1 ? "" : "s"}`}
            </li>
          )}
        </ol>
      </SortableContext>

      <div className="flex-1" />

      <footer className="mt-3 flex flex-wrap items-center gap-2">
        {/* Group, offers, hosts and changes: bottom left, next to the main action. On phones each opens as a sheet from the bottom. */}
        <div className="flex flex-none items-center gap-1">
            <div className="flex-none">
              {(changes && changes.total > 0) || lineup?.dropped?.length ? (
                <Popover
                  title="Needs a look"
                  width={360}
                  trigger={(toggle, open) => (
                    <Chip tone={lineup?.dropped?.length ? "error" : "tertiary"} icon={IconPen} selected={open} onClick={toggle} className="max-w-full">
                      <span className="truncate">{(changes?.total ?? 0) === 0 ? `Dropped out · ${lineup?.dropped?.length}` : `Changed · ${(changes?.total ?? 0) + (lineup?.dropped?.length ?? 0)}`}</span>
                    </Chip>
                  )}
                >
                  {(close) => (
                    <div className="flex flex-col gap-3">
                      {changes && changes.total > 0 && (
                        <section>
                          <p className="type-label-l text-on-surface-variant">Since you confirmed</p>
                          <ul className="mt-1 flex flex-col">
                            {changes.added.map((id) => <NoteRow key={`a${id}`} name={nameOf(id)} pill={<Pill tone="warn">Not told yet</Pill>} />)}
                            {changes.moved.map((m) => <NoteRow key={`m${m.comicId}`} name={nameOf(m.comicId)} pill={<Pill tone="warn">Moved from {m.from}</Pill>} />)}
                            {changes.minutes.map((m) => <NoteRow key={`t${m.comicId}`} name={nameOf(m.comicId)} pill={<Pill tone="warn" icon={IconClock}>Was {m.from ?? "?"} min</Pill>} />)}
                            {changes.removed.map((id) => <NoteRow key={`r${id}`} name={nameOf(id)} pill={<Pill tone="plain">Removed, not told</Pill>} />)}
                          </ul>
                          {confirmed && (
                            <Button size="sm" icon={IconSend} className="mt-2" onClick={() => (close(), setUpdatesOpen(true))}>
                              Send updates
                            </Button>
                          )}
                        </section>
                      )}
                      {lineup?.dropped?.length ? (
                        <section>
                          <p className="type-label-l text-on-surface-variant">Dropped out</p>
                          <ul className="mt-1 flex flex-col">
                            {lineup.dropped.map((d) => <NoteRow key={d.comicId} name={nameOf(d.comicId)} pill={<Pill tone="error">Dropped out</Pill>} />)}
                          </ul>
                        </section>
                      ) : null}
                    </div>
                  )}
                </Popover>
              ) : null}
            </div>
            {pendingOffers.length > 0 && (
              <Popover
                title="Offers out"
                trigger={(toggle, open) => <ToolButton icon={IconUserPlus} label="Offers waiting for a reply" count={pendingOffers.length} active={open} onClick={toggle} />}
              >
                {(close) => (
                  <div>
                    <ul className="flex flex-col">
                      {pendingOffers.map((o) => <NoteRow key={o.id} name={o.comicName} pill={<Pill tone="reading">Waiting for a reply</Pill>} />)}
                    </ul>
                    <Button size="sm" variant="tonal" icon={IconUserPlus} className="mt-2" disabled={past || cancelled || ids.length >= show.slotCount} onClick={() => (close(), setOfferOpen(true))}>
                      Offer another spot…
                    </Button>
                  </div>
                )}
              </Popover>
            )}
            {hostsFree.length > 0 && (
              <Popover
                title="Hosts free"
                trigger={(toggle, open) => <ToolButton icon={IconUserCheck} label="Hosts free for this show" count={hostsFree.length} active={open} onClick={toggle} />}
              >
                {(close) => (
                  <div>
                    <p className="type-body-s text-on-surface-variant">Said they're free for {show.name} in the hosts poll.</p>
                    <ul className="mt-1 flex flex-col">
                      {hostsFree.map((h) => {
                        const onLineup = ids.includes(h.id);
                        const known = comicsById.has(h.id);
                        return (
                          <li key={h.id} className="flex min-h-12 items-center gap-2.5 py-1">
                            <Avatar name={h.name} size={28} tone="secondary" />
                            <span className="min-w-0 flex-1 truncate type-label-l">{h.name}</span>
                            {onLineup ? <Pill tone="told" icon={IconCheck}>On lineup</Pill> : (
                              <Button size="sm" variant="tonal" disabled={!known || cancelled || ids.length >= show.slotCount} onClick={() => (close(), void onAdd(h.id))}>
                                Add
                              </Button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </Popover>
            )}
            {!cancelled && !record && (
              <GroupPopover show={show} lineup={lineup} ids={ids} pendingLeave={pendingLeave} onLeaveHandled={onLeaveHandled} onRemoveFromLineup={onRemove} onAddToLineup={ids.length < show.slotCount ? onAddTold : undefined} onSync={syncGroup} onReview={() => setSyncOpen(true)} />
            )}
                </div>
        {record ? (
          <>
            <div className="flex-1" />
            <Button size="sm" variant="tonal" icon={IconHistory} onClick={() => setBackfillOpen(true)}>Record who performed</Button>
          </>
        ) : canned ? null : cancelled ? (
          <Button size="sm" variant="text" onClick={() => setLineupStatus(uid, week, show, "draft")}>Reopen</Button>
        ) : confirmed ? (
          <>
            <span className="inline-flex min-w-0 flex-1 items-center justify-end gap-1.5 type-label-m text-on-surface-variant">
              {changes && changes.total > 0 ? (
                <>Changes aren't sent yet</>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" className="draw-check size-4 text-primary" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                  Everyone's been told
                </>
              )}
            </span>
            <Button size="sm" icon={IconSend} disabled={!changes || changes.total === 0} onClick={() => setUpdatesOpen(true)}>
              Send updates
            </Button>
          </>
        ) : (
          <>
            <div className="flex-1" />
            <Button size="sm" icon={IconSend} disabled={!ids.length} onClick={() => setConfirmOpen(true)}>
              Confirm & send
            </Button>
          </>
        )}
      </footer>

      <BackfillSheet open={backfillOpen} onClose={() => setBackfillOpen(false)} show={show} week={week} />
      <ConfirmSheet open={confirmOpen} onClose={() => setConfirmOpen(false)} onSending={() => (armed.current = mode === "confirm")} show={show} ids={ids} lineup={lineup} regretsAfter={regretsAfter} />
      {lineup && baseline && <SendUpdatesSheet open={updatesOpen} onClose={() => setUpdatesOpen(false)} show={show} lineup={lineup} baseline={baseline} onSent={() => void (armed.current = mode === "confirm")} />}
      <ResetDialog open={resetOpen} onClose={() => setResetOpen(false)} plans={resetPlan ? [resetPlan] : []} shows={[show]} scope="show" />
      <OfferSheet open={offerOpen} onClose={() => setOfferOpen(false)} show={show} exclude={ids} />
      {lineup && <GroupSyncSheet open={syncOpen} onClose={() => setSyncOpen(false)} show={show} lineup={lineup} />}
    </Column>
  );
}

function NoteRow({ name, pill }: { name: string; pill: React.ReactNode }) {
  return (
    <li className="flex min-h-10 items-center gap-2.5 py-1">
      <span className="min-w-0 flex-1 truncate type-label-l">{name}</span>
      {pill}
    </li>
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
