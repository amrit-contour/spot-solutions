import { useMemo, useState } from "react";
import { ComicAvatar } from "../lib/photos";
import { where } from "firebase/firestore";
import { AnimatePresence, motion } from "motion/react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { deleteDoc, updateDoc } from "firebase/firestore";
import {
  DAY_SHORT,
  HOLD_LABEL,
  INTENT_THRESHOLD,
  cancellations,
  daysBetween,
  isClearedRequest,
  requestsToClear,
  formatTime,
  lastSpot,
  localNow,
  shiftWeek,
  type Lineup,
  type Show,
  type SpotRequest,
  toPlain,
} from "@spot/shared";
import { useApp } from "../lib/app";
import { runCommand, timeAgo, useCollection, useNow, userDoc } from "../lib/data";
import { placeComic } from "../lib/lineup";
import { setRequestsCleared } from "../lib/cleanup";
import { useNeverRead } from "../lib/neverRead";
import { PageHeader } from "@spot/ui";
import { WaText } from "@spot/ui";
import { WeekSwitcher } from "../components/WeekSwitcher";
import { Menu, MenuItem } from "@spot/ui";
import { Bubble, Button, Chip, Empty, IconButton, Segmented, cx } from "@spot/ui";
import { ConnectCard } from "../components/ConnectCard";
import { ConfirmDialog } from "@spot/ui";
import { ClearOldRequests } from "../components/ClearOldRequests";
import { ScanHistorySheet } from "../components/ScanHistorySheet";
import { isDemoUser } from "../lib/demo";
import { UpdatesPanel } from "../components/UpdatesPanel";
import { Count } from "../components/updates/shared";
import { useUpdates } from "../lib/updates";
import { RequestPills, requestPills } from "../components/RequestTags";
import { IconArrowDown, IconSort, IconChat, IconSearch, IconChatCheck, IconCheck, IconInbox, IconMenuDots, IconMic, IconShield, IconSkip, IconSparkle, IconStar } from "@spot/ui";

export type Lane = "asked" | "maybe" | "held" | "placed" | "closed";
const LANES: { id: Lane; label: string }[] = [
  { id: "asked", label: "Asked" },
  { id: "maybe", label: "Maybe" },
  { id: "held", label: "Held" },
  { id: "placed", label: "Placed" },
  { id: "closed", label: "Closed" },
];

type SortKey = "fair" | "newest" | "oldest" | "confidence" | "name";
const SORT_KEY = "spot.requests.sort";
const SORTS: { id: SortKey; label: string; help: string }[] = [
  { id: "fair", label: "Fair order", help: "Didn't perform last week first, then first come" },
  { id: "newest", label: "Newest", help: "Latest message first" },
  { id: "oldest", label: "Oldest", help: "First asked first" },
  { id: "confidence", label: "Most likely", help: "Clearest asks first" },
  { id: "name", label: "Name", help: "A to Z" },
];

export const laneOf = (r: SpotRequest): Lane =>
  r.status === "dismissed" || r.status === "rejected"
    ? "closed"
    : r.status === "assigned" || r.status === "confirmed"
      ? "placed"
      : r.hold && !r.holdOverridden
        ? "held"
        : r.intent.confidence >= INTENT_THRESHOLD
          ? "asked"
          : "maybe";

export function Requests() {
  const { uid, week, session, shows, comicsById } = useApp();
  const requests = useCollection<SpotRequest>(uid, "requests", [where("weekOf", "==", week)], week);
  const lineups = useCollection<Lineup>(uid, "lineups", [where("weekOf", "==", week)], week);
  const [lane, setLane] = useState<Lane>("asked");
  // Messages links here with ?q=name to land on that person's card.
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(() => params.get("q") ?? "");
  const [sort, setSortState] = useState<SortKey>(() => {
    try {
      const v = localStorage.getItem(SORT_KEY) as SortKey | null;
      return v && SORTS.some((x) => x.id === v) ? v : "fair";
    } catch {
      return "fair";
    }
  });
  const setSort = (v: SortKey) => {
    setSortState(v);
    try {
      localStorage.setItem(SORT_KEY, v);
    } catch {
      /* not remembered */
    }
  };
  const [clearOpen, setClearOpen] = useState(false);
  const [clearClosedOpen, setClearClosedOpen] = useState(false);
  const [showCleared, setShowCleared] = useState(false);
  const [rereading, setRereading] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const lastWeek = shiftWeek(week, -1);
  // Phones and tablets show one view at a time; the URL keeps it linkable (/requests?view=updates). Desktop shows both.
  const view: "requests" | "updates" = params.get("view") === "updates" ? "updates" : "requests";
  const setView = (v: "requests" | "updates") => setParams(v === "updates" ? { view: "updates" } : {}, { replace: true });
  const updates = useUpdates();

  const grouped = useMemo(() => {
    const g: Record<Lane, SpotRequest[]> = { asked: [], maybe: [], held: [], placed: [], closed: [] };
    const needle = q.trim().toLowerCase();
    // Search name, number, what they wrote and the note, across every lane (the counts follow).
    const hit = (r: SpotRequest) =>
      !needle ||
      [r.comicName, comicsById.get(r.comicId)?.name ?? "", r.comicId.split("@")[0], r.intent.note ?? "", ...r.messages.map((m) => m.body)].some((t) => t.toLowerCase().includes(needle));
    for (const r of requests.data) if (hit(r) && (showCleared || !isClearedRequest(r))) g[laneOf(r)].push(r);
    // Fairness first: people who didn't perform last week float up, then first-come.
    for (const k of Object.keys(g) as Lane[])
      g[k].sort((a, b) => {
        const latest = (r: SpotRequest) => r.messages[r.messages.length - 1]?.at ?? r.updatedAt ?? r.createdAt;
        if (sort === "newest") return latest(b) - latest(a);
        if (sort === "oldest") return a.createdAt - b.createdAt;
        if (sort === "confidence") return b.intent.confidence - a.intent.confidence || a.createdAt - b.createdAt;
        if (sort === "name") return (comicsById.get(a.comicId)?.name ?? a.comicName).localeCompare(comicsById.get(b.comicId)?.name ?? b.comicName);
        // Fair order: people who didn't perform last week float up, then first-come.
        const pa = comicsById.get(a.comicId)?.lastPerformedWeek === lastWeek ? 1 : 0;
        const pb = comicsById.get(b.comicId)?.lastPerformedWeek === lastWeek ? 1 : 0;
        return pa - pb || a.createdAt - b.createdAt;
      });
    return g;
  }, [requests.data, comicsById, lastWeek, q, sort, showCleared]);

  const toClear = useMemo(() => requestsToClear(requests.data), [requests.data]);
  const clearedCount = useMemo(() => requests.data.filter(isClearedRequest).length, [requests.data]);

  const activeShows = shows.filter((s) => s.active);
  const linked = session?.status === "ready";
  // With one venue it's implied, so the card hides the venue pill.
  const manyVenues = new Set(activeShows.map((s) => s.venueId)).size > 1;

  const clearClosed = async () => {
    const ids = toClear.map((r) => r.id);
    await setRequestsCleared(uid, ids, Date.now());
    toast.success(`Cleared ${ids.length} closed request${ids.length === 1 ? "" : "s"}`, {
      action: { label: "Undo", onClick: () => void setRequestsCleared(uid, ids, null).catch((e) => toast.error((e as Error).message)) },
    });
  };

  const reread = async () => {
    setRereading(true);
    try {
      const res = await runCommand<{ updated: number; skipped: number; failed: number }>(uid, "reclassify_requests", { weekOf: week });
      toast.success(res.updated ? `Re-read ${res.updated} request${res.updated > 1 ? "s" : ""}` : "Nothing to update");
      if (res.failed) toast.error(`${res.failed} could not be read`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRereading(false);
    }
  };

  return (
    <div className="w-full">
      <PageHeader
        title="Requests"
        subtitle={requests.data.length ? `${grouped.asked.length} waiting · ${grouped.placed.length} placed` : "Spot requests Gemma found in your DMs"}
        actions={
          <>
            <WeekSwitcher />
            <Menu align="right" trigger={(t) => <IconButton icon={IconMenuDots} label="More" onClick={t} className="size-9" />}>
              {(close) => (
                <>
                  <MenuItem disabled={rereading || !requests.data.length} onClick={() => (close(), void reread())}>
                    Re-read this week's requests
                    <span className="block type-body-s text-on-surface-variant">Updates tags and notes only</span>
                  </MenuItem>
                  <MenuItem disabled={isDemoUser() || !linked} onClick={() => (close(), setScanOpen(true))}>
                    Scan past messages…
                    <span className="block type-body-s text-on-surface-variant">{isDemoUser() ? "Needs a linked WhatsApp, so it's off in the demo" : linked ? "Find spot requests in your recent DMs" : "Link WhatsApp first"}</span>
                  </MenuItem>
                  <MenuItem disabled={!toClear.length} onClick={() => (close(), setClearClosedOpen(true))}>
                    Clear closed ({toClear.length})
                    <span className="block type-body-s text-on-surface-variant">Hides dismissed and regretted requests; you can show them again</span>
                  </MenuItem>
                  <MenuItem onClick={() => (close(), setClearOpen(true))}>Clear requests…</MenuItem>
                </>
              )}
            </Menu>
          </>
        }
      >
        <div className="mt-5 lg:hidden" aria-label="Requests or updates">
          <Segmented
            full
            value={view}
            onChange={setView}
            options={[
              { value: "requests", label: "Requests" },
              {
                value: "updates",
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    Updates
                    <Count value={updates.total} className={cx("rounded-full px-1.5 type-label-s", updates.total ? "bg-primary text-on-primary" : "bg-surface-high text-on-surface-variant")} />
                  </span>
                ),
              },
            ]}
          />
        </div>
      </PageHeader>

      <ConfirmDialog
        open={clearClosedOpen}
        onClose={() => setClearClosedOpen(false)}
        tone="primary"
        title="Clear closed requests?"
        confirmLabel={`Clear ${toClear.length}`}
        disabled={!toClear.length}
        onConfirm={clearClosed}
      >
        Clear {toClear.length} closed request{toClear.length === 1 ? "" : "s"}? They stay in each comic's history.
      </ConfirmDialog>
      <ClearOldRequests open={clearOpen} onClose={() => setClearOpen(false)} />
      <ScanHistorySheet open={scanOpen} onClose={() => setScanOpen(false)} />
      <div className="px-4 pb-10 sm:px-8 lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:gap-8 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className={cx("min-w-0", view === "updates" && "hidden lg:block")}>
          <div className="sticky top-[var(--page-header-h,0px)] z-20 -mx-4 mb-4 border-b border-outline-variant bg-surface px-4 pt-2 sm:mx-0 sm:px-0">
            <div className="flex flex-col gap-2 2xl:flex-row-reverse 2xl:items-center">
              <div className="flex items-center gap-2 2xl:flex-none">
              <label className="relative block min-w-0 flex-1 2xl:w-64 2xl:flex-none">
                <IconSearch className="icon pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-on-surface-variant" />
                <input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setQ("")}
                  placeholder="Search name, number or message"
                  aria-label="Search requests"
                  className="h-10 w-full rounded-full border border-outline-variant bg-surface-low pr-3 pl-9 type-body-m outline-none placeholder:text-on-surface-variant/70 focus:border-primary"
                />
              </label>
              <Menu
                align="right"
                trigger={(t, isOpen) => (
                  <button onClick={t} aria-expanded={isOpen} aria-label={`Sort: ${SORTS.find((x) => x.id === sort)?.label}`} title="Sort" className="state-layer pressable inline-flex h-10 flex-none items-center gap-1.5 rounded-full border border-outline-variant px-3 type-label-l text-on-surface-variant">
                    <IconSort className="icon size-4" />
                    <span className="max-sm:hidden">{SORTS.find((x) => x.id === sort)?.label}</span>
                  </button>
                )}
              >
                {(close) =>
                  SORTS.map((x) => (
                    <MenuItem key={x.id} highlighted={x.id === sort} hint={x.id === sort ? "✓" : undefined} onClick={() => (close(), setSort(x.id))}>
                      {x.label}
                      <span className="block type-body-s text-on-surface-variant">{x.help}</span>
                    </MenuItem>
                  ))
                }
              </Menu>
              {toClear.length > 0 && (
                <Button size="sm" variant="text" onClick={() => setClearClosedOpen(true)} className="flex-none whitespace-nowrap max-sm:hidden">
                  Clear closed ({toClear.length})
                </Button>
              )}
              </div>
              <div className="min-w-0 flex-1">
            <div className="flex overflow-x-auto [scrollbar-width:none] sm:gap-1" role="tablist">
                  {LANES.map((l) => (
                    <button key={l.id} role="tab" aria-selected={lane === l.id} onClick={() => setLane(l.id)} className="state-layer relative flex flex-1 items-center justify-center gap-1.5 rounded-t-sm px-2.5 pt-2 pb-3 type-title-s whitespace-nowrap sm:flex-none sm:gap-2 sm:px-4">
                      <span className={lane === l.id ? "text-primary" : "text-on-surface-variant"}>{l.label}</span>
                      <span className={cx("rounded-full px-1.5 type-label-s tabular", lane === l.id ? "bg-primary text-on-primary" : "bg-surface-high text-on-surface-variant")}>{grouped[l.id].length}</span>
                      {lane === l.id && <motion.span layoutId="lane-ink" className="absolute inset-x-3 bottom-0 h-[3px] rounded-t-full bg-primary" transition={{ type: "spring", duration: 0.4, bounce: 0.15 }} />}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
          {lane === "closed" && (clearedCount > 0 || showCleared) && (
            <div className="mb-3 flex items-center justify-between gap-3 px-1 type-body-s text-on-surface-variant">
              <span>{clearedCount} cleared request{clearedCount === 1 ? "" : "s"} hidden</span>
              <Button size="sm" variant="text" onClick={() => setShowCleared((v) => !v)} aria-pressed={showCleared}>
                {showCleared ? "Hide cleared" : "Show cleared"}
              </Button>
            </div>
          )}
          {!linked && !requests.data.length ? (
            <ConnectCard compact />
          ) : grouped[lane].length === 0 ? (
            q.trim() ? <p className="rounded-lg bg-surface-low px-5 py-8 text-center type-body-m text-on-surface-variant">No {LANES.find((l) => l.id === lane)?.label} requests match “{q.trim()}”. Other tabs show their matches in the counts.</p> : <LaneEmpty lane={lane} />
          ) : (
            <motion.ul className="grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-1" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.04 } } }}>
              <AnimatePresence initial={false}>
                {grouped[lane].map((r) => (
                  <RequestCard key={r.id} r={r} shows={activeShows} lineups={lineups.data} performedLastWeek={comicsById.get(r.comicId)?.lastPerformedWeek === lastWeek} tier={comicsById.get(r.comicId)?.tier} showVenue={manyVenues} />
                ))}
              </AnimatePresence>
            </motion.ul>
          )}
          {!activeShows.length && requests.data.length > 0 && (
            <p className="mt-6 type-body-m text-on-surface-variant">
              Add your shows in <Link className="text-primary underline-offset-4 hover:underline" to="/shows">Shows</Link> to start placing comics.
            </p>
          )}
        </div>
        <aside aria-label="Updates" className={cx("min-w-0 lg:sticky lg:top-[calc(1rem+var(--page-header-h,0px))] lg:max-h-[calc(100dvh-2rem-var(--page-header-h,0px))] lg:overflow-y-auto lg:overflow-x-hidden lg:overscroll-contain", view === "requests" && "hidden lg:block")}>
          <UpdatesPanel lineups={lineups.data} />
        </aside>
      </div>
    </div>
  );
}

function LaneEmpty({ lane }: { lane: Lane }) {
  const copy: Record<Lane, [string, string]> = {
    asked: ["Inbox zero. Go write.", "New spot requests show up here as they arrive. Gemma reads each burst of messages together, so a hey, a pause and then the ask count as one request."],
    maybe: ["Nothing borderline", "Messages Gemma wasn't sure about land here, so nothing gets missed."],
    placed: ["No one placed yet", "Assign comics to a show from Asked, or drag them on the Lineup board."],
    held: ["Nothing held back", "Requests that break your rules land here: outside the request window, performed last week, or from someone on your banned, ignored or host list. You can still let them through."],
    closed: ["Nothing closed", "Dismissed requests and comics who got a regret message stay here for the week."],
  };
  return (
    <Empty icon={lane === "asked" ? IconInbox : IconSparkle} title={copy[lane][0]}>
      {copy[lane][1]}
    </Empty>
  );
}

function RequestCard({ r, shows, lineups, performedLastWeek, tier, showVenue }: { r: SpotRequest; shows: Show[]; lineups: Lineup[]; performedLastWeek: boolean; tier?: string; showVenue: boolean }) {
  const { uid, week, comicsById, settings, shows: allShows, venues } = useApp();
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const comic = comicsById.get(r.comicId);
  const today = localNow(new Date(now), settings.timezone).date;
  const prev = lastSpot(comic?.history, today);
  const cancels = cancellations(comic?.history);
  const held = r.hold && !r.holdOverridden;
  const placedIn = lineups.find((l) => l.slots.some((s) => s.comicId === r.comicId));
  const placedShow = shows.find((s) => s.id === placedIn?.showId);
  const preferred = new Set(r.intent.preferredDays);
  const sortedShows = [...shows].sort((a, b) => Number(preferred.has(b.weekday)) - Number(preferred.has(a.weekday)));
  const last = r.messages[r.messages.length - 1];
  const venueName = showVenue ? venues.find((v) => v.id === r.intent.venueId)?.name : undefined;
  const pills = requestPills({ r, comic, shows: allShows, today, venueName });

  const assign = async (show: Show) => {
    if (!(await placeComic(uid, week, show, r.comicId, lineups))) return;
    toast.success(`${r.comicName.split(" ")[0]} → ${show.name}`);
  };
  const nr = useNeverRead();
  /** A dismissed request from someone who isn't a comic: put them on Never read and delete what we kept of them. */
  const neverReadAgain = async () => {
    const ids = [r.comicId, r.contact?.chatId].filter((x): x is string => Boolean(x));
    await nr.add(ids.map((id) => ({ id, kind: "person" as const, name: r.comicName })));
    await deleteDoc(userDoc(uid, "requests", r.id)).catch(() => undefined);
    toast.success(`${r.comicName} won't be read again`);
  };
  const setStatus = (status: SpotRequest["status"]) => updateDoc(userDoc(uid, "requests", r.id), { status, clearedAt: null, updatedAt: Date.now() });
  /** Closed by mistake: back to waiting (Held if a rule still holds it). A regret that went out isn't unsent. */
  const reopen = async () => {
    const before = r.status;
    await updateDoc(userDoc(uid, "requests", r.id), { status: r.ackedAt ? "acked" : "new", rejectedAt: null, clearedAt: null, updatedAt: Date.now() });
    toast.success(`${r.comicName.split(" ")[0]} is back in ${r.hold && !r.holdOverridden ? "Held" : r.intent.confidence >= INTENT_THRESHOLD ? "Asked" : "Maybe"}`, {
      description: before === "rejected" ? "They already got your regret message, so tell them if things changed." : undefined,
      action: { label: "Undo", onClick: () => void setStatus(before) },
    });
  };

  return (
    <motion.li
      layout
      variants={{ hidden: { opacity: 0, transform: "translateY(8px)" }, show: { opacity: 1, transform: "translateY(0px)" } }}
      exit={{ opacity: 0, transform: "scale(0.98)", transition: { duration: 0.15 } }}
      transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1] }}
      className="overflow-hidden rounded-lg bg-surface-low"
    >
      <div className="flex gap-3 px-4 pt-4 sm:gap-4 sm:px-5 sm:pt-5">
        <ComicAvatar id={r.comicId} name={r.comicName} size={44} tone={performedLastWeek ? "secondary" : "primary"} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="min-w-0 flex-1 truncate type-title-m">{r.comicName}</h3>
            <span className="flex-none type-label-m text-on-surface-variant tabular">{timeAgo(r.updatedAt, now)}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {r.hold && (
              <Chip tone={held ? "error" : "neutral"} icon={IconShield} className={cx(!held && "line-through")}>
                {HOLD_LABEL[r.hold]}
              </Chip>
            )}
            {r.intent.preferredDays.length ? (
              r.intent.preferredDays.map((d) => (
                <Chip key={d} tone="primary">
                  {DAY_SHORT[d]}
                </Chip>
              ))
            ) : (
              <Chip>Any day</Chip>
            )}
            {tier === "featured" && (
              <Chip tone="tertiary" icon={IconStar}>
                {tier}
              </Chip>
            )}
            {isClearedRequest(r) && <Chip>Cleared</Chip>}
            <RequestPills pills={pills} />
            {r.ackedAt && (
              <span className="inline-flex items-center gap-1 px-1 type-label-m text-on-surface-variant">
                <IconChatCheck className="icon size-4" /> Acked
              </span>
            )}
          </div>
          <p className="mt-2 truncate type-body-m text-on-surface-variant" title={toPlain(r.intent.note || last?.body || "")}>
            {r.intent.note ? toPlain(r.intent.note) : `“${toPlain(last?.body ?? "")}”`}
          </p>
          {(prev || cancels > 0) && (
            <p className="mt-0.5 type-body-s text-on-surface-variant">
              {prev && `Last spot ${daysBetween(prev.date, today)} days ago (${prev.showName})`}
              {cancels > 0 && <span className="text-error">{prev && " · "}{cancels} cancellation{cancels > 1 ? "s" : ""}</span>}
            </p>
          )}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }}>
            <div className="mt-4 max-h-80 overflow-y-auto overscroll-contain border-t border-outline-variant/40 bg-surface-lowest">
              {/* Pinned inside the box, so it can be folded from anywhere while scrolling through long chats. */}
              <div className="sticky top-0 z-10 flex items-center justify-between gap-2 bg-surface-lowest/95 px-4 py-2 backdrop-blur sm:px-5">
                <span className="type-label-m text-on-surface-variant">{r.messages.length} message{r.messages.length > 1 ? "s" : ""}</span>
                <IconButton icon={IconArrowDown} label="Hide messages" onClick={() => setOpen(false)} className="size-8 rotate-180" />
              </div>
              <div className="flex flex-col gap-2 px-4 pb-4 sm:px-5">
              {r.messages.map((m) => (
                <Bubble key={m.id} meta={new Date(m.at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}>
                  <WaText text={m.body} />
                </Bubble>
              ))}
              <span className="mt-1 type-label-s text-on-surface-variant">
                Read by {r.intent.model ?? "Gemma"} · {Math.round(r.intent.confidence * 100)}% sure
              </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mt-3 flex min-w-0 items-center gap-1 border-t sm:gap-2 border-outline-variant/40 py-2 pr-3 pl-2 sm:pr-4 sm:pl-3">
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="state-layer inline-flex h-10 flex-none whitespace-nowrap items-center gap-1.5 rounded-full px-3 type-label-l text-on-surface-variant">
          {r.messages.length} message{r.messages.length > 1 ? "s" : ""}
          <IconArrowDown className={cx("icon size-4 transition-transform duration-200", open && "rotate-180")} />
        </button>
        <Confidence value={r.intent.confidence} />
        <div className="min-w-0 flex-1" />
        <Link to={`/messages?c=${encodeURIComponent(r.comicId)}`} className="state-layer pressable inline-flex h-10 flex-none items-center gap-1.5 rounded-full px-3 type-label-l whitespace-nowrap text-on-surface-variant" title={`Open the chat with ${r.comicName}`}>
          <IconChat className="icon size-4" />
          <span className="max-xl:sr-only">Open chat</span>
        </Link>
        {held ? (
          <>
            <IconButton icon={IconSkip} label="Dismiss" onClick={() => setStatus("dismissed")} />
            <Button variant="tonal" onClick={() => void updateDoc(userDoc(uid, "requests", r.id), { holdOverridden: true, updatedAt: Date.now() })}>
              Allow anyway
            </Button>
          </>
        ) : r.status === "rejected" ? (
          <>
            <Chip icon={IconChatCheck}>Regret sent</Chip>
            <Button size="sm" variant="tonal" onClick={() => void reopen()}>
              Reopen
            </Button>
          </>
        ) : r.status === "dismissed" ? (
          <>
            {!comic && (
              <Button size="sm" variant="text" onClick={() => void neverReadAgain()}>
                Not a comic: never read again
              </Button>
            )}
            <Button size="sm" variant="tonal" onClick={() => void reopen()}>
              Reopen
            </Button>
          </>
        ) : (
          <>
            {!placedIn && <IconButton icon={IconSkip} label="Dismiss" onClick={() => setStatus("dismissed")} />}
            {placedShow ? (
              <Chip tone="success" icon={r.status === "confirmed" ? IconCheck : IconMic} className="min-w-0" title={`${r.status === "confirmed" ? "Confirmed" : "In"} · ${placedShow.name}`}>
                {/* Phones: the icon says confirmed or pencilled in, the day says which show. */}
                <span className="sm:hidden">{DAY_SHORT[placedShow.weekday]}</span>
                <span className="sr-only sm:hidden">{r.status === "confirmed" ? "Confirmed" : "In"} · {placedShow.name}</span>
                <span className="hidden truncate sm:inline">
                  {r.status === "confirmed" ? "Confirmed" : "In"} · {placedShow.name}
                </span>
              </Chip>
            ) : (
              <Menu
                align="right"
                trigger={(toggle) => (
                  <Button icon={IconMic} onClick={toggle} disabled={!shows.length}>
                    Assign
                  </Button>
                )}
              >
                {(close) =>
                  sortedShows.map((s) => {
                    const l = lineups.find((x) => x.showId === s.id);
                    const full = (l?.slots.length ?? 0) >= s.slotCount;
                    return (
                      <MenuItem
                        key={s.id}
                        highlighted={preferred.has(s.weekday)}
                        hint={`${l?.slots.length ?? 0}/${s.slotCount}`}
                        disabled={l?.status === "confirmed"}
                        onClick={() => {
                          close();
                          void assign(s);
                        }}
                      >
                        {s.name}
                        <span className="block type-body-s text-on-surface-variant">
                          {DAY_SHORT[s.weekday]} · {formatTime(s.startTime)}
                          {full && " · full"}
                        </span>
                      </MenuItem>
                    );
                  })
                }
              </Menu>
            )}
          </>
        )}
      </div>
    </motion.li>
  );
}

function Confidence({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const title = `Gemma is ${pct}% sure this is a spot request`;
  // Phones: a small ring with the number inside. Wider: the bar.
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <>
      <span className="relative grid size-9 flex-none place-items-center sm:hidden" title={title} role="img" aria-label={title}>
        <svg viewBox="0 0 36 36" className="absolute inset-0 size-9 -rotate-90" aria-hidden>
          <circle cx="18" cy="18" r={r} fill="none" strokeWidth="3" className="stroke-surface-highest" />
          <motion.circle cx="18" cy="18" r={r} fill="none" strokeWidth="3" strokeLinecap="round" className="stroke-primary" strokeDasharray={c} initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - value) }} transition={{ duration: 0.6, ease: [0.23, 1, 0.32, 1] }} />
        </svg>
        <span className="relative text-[0.625rem] leading-none font-medium text-on-surface-variant tabular">{pct}</span>
      </span>
      <span className="hidden items-center gap-2 type-label-s text-on-surface-variant sm:inline-flex" title={title}>
        <span className="relative h-1 w-12 overflow-hidden rounded-full bg-surface-highest">
          <motion.span className="absolute inset-y-0 left-0 rounded-full bg-primary" initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.6, ease: [0.23, 1, 0.32, 1] }} />
        </span>
        <span className="tabular">{pct}%</span>
      </span>
    </>
  );
}
