import { useMemo, useState } from "react";
import { where } from "firebase/firestore";
import { AnimatePresence, motion } from "motion/react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { updateDoc } from "firebase/firestore";
import {
  DAY_SHORT,
  HOLD_LABEL,
  INTENT_THRESHOLD,
  cancellations,
  daysBetween,
  formatTime,
  lastSpot,
  localNow,
  shiftWeek,
  type Lineup,
  type Show,
  type SpotRequest,
} from "@spot/shared";
import { useApp } from "../lib/app";
import { runCommand, timeAgo, useCollection, useNow, userDoc } from "../lib/data";
import { placeComic } from "../lib/lineup";
import { PageHeader } from "../components/Shell";
import { WeekSwitcher } from "../components/WeekSwitcher";
import { Menu, MenuItem } from "../components/Menu";
import { Avatar, Bubble, Button, Chip, Empty, IconButton, Segmented, cx } from "../components/ui";
import { ConnectCard } from "../components/ConnectCard";
import { ClearOldRequests } from "../components/ClearOldRequests";
import { ScanHistorySheet } from "../components/ScanHistorySheet";
import { isDemoUser } from "../lib/demo";
import { UpdatesPanel } from "../components/UpdatesPanel";
import { Count } from "../components/updates/shared";
import { useUpdates } from "../lib/updates";
import { RequestPills, requestPills } from "../components/RequestTags";
import { IconArrowDown, IconChat, IconSearch, IconChatCheck, IconCheck, IconInbox, IconMenuDots, IconMic, IconShield, IconSkip, IconSparkle, IconStar } from "../components/icons";

export type Lane = "asked" | "maybe" | "held" | "placed" | "closed";
const LANES: { id: Lane; label: string }[] = [
  { id: "asked", label: "Asked" },
  { id: "maybe", label: "Maybe" },
  { id: "held", label: "Held" },
  { id: "placed", label: "Placed" },
  { id: "closed", label: "Closed" },
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
  const [clearOpen, setClearOpen] = useState(false);
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
    for (const r of requests.data) if (hit(r)) g[laneOf(r)].push(r);
    // Fairness first: people who didn't perform last week float up, then first-come.
    for (const k of Object.keys(g) as Lane[])
      g[k].sort((a, b) => {
        const pa = comicsById.get(a.comicId)?.lastPerformedWeek === lastWeek ? 1 : 0;
        const pb = comicsById.get(b.comicId)?.lastPerformedWeek === lastWeek ? 1 : 0;
        return pa - pb || a.createdAt - b.createdAt;
      });
    return g;
  }, [requests.data, comicsById, lastWeek, q]);

  const activeShows = shows.filter((s) => s.active);
  const linked = session?.status === "ready";
  // With one venue it's implied, so the card hides the venue pill.
  const manyVenues = new Set(activeShows.map((s) => s.venueId)).size > 1;

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

      <ClearOldRequests open={clearOpen} onClose={() => setClearOpen(false)} />
      <ScanHistorySheet open={scanOpen} onClose={() => setScanOpen(false)} />
      <div className="px-4 pb-10 sm:px-8 lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:gap-8 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className={cx("min-w-0", view === "updates" && "hidden lg:block")}>
          <div className="sticky top-[calc(env(safe-area-inset-top)+var(--page-header-h,0px))] z-20 -mx-4 mb-4 border-b border-outline-variant bg-surface/95 px-4 pt-2 backdrop-blur sm:mx-0 sm:px-0">
            <div className="flex flex-col gap-2 2xl:flex-row-reverse 2xl:items-center">
              <label className="relative block 2xl:w-64 2xl:flex-none">
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
        <aside aria-label="Updates" className={cx("min-w-0 lg:sticky lg:top-[calc(1rem+var(--page-header-h,0px))] lg:max-h-[calc(100dvh-2rem-var(--page-header-h,0px))] lg:overflow-y-auto lg:overscroll-contain", view === "requests" && "hidden lg:block")}>
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
    await placeComic(uid, week, show, r.comicId, lineups);
    toast.success(`${r.comicName.split(" ")[0]} → ${show.name}`);
  };
  const setStatus = (status: SpotRequest["status"]) => updateDoc(userDoc(uid, "requests", r.id), { status, updatedAt: Date.now() });
  /** Closed by mistake: back to waiting (Held if a rule still holds it). A regret that went out isn't unsent. */
  const reopen = async () => {
    const before = r.status;
    await updateDoc(userDoc(uid, "requests", r.id), { status: r.ackedAt ? "acked" : "new", rejectedAt: null, updatedAt: Date.now() });
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
        <Avatar name={r.comicName} size={44} tone={performedLastWeek ? "secondary" : "primary"} />
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
            <RequestPills pills={pills} />
            {r.ackedAt && (
              <span className="inline-flex items-center gap-1 px-1 type-label-m text-on-surface-variant">
                <IconChatCheck className="icon size-4" /> Acked
              </span>
            )}
          </div>
          <p className="mt-2 truncate type-body-m text-on-surface-variant" title={r.intent.note || last?.body}>
            {r.intent.note || `“${last?.body}”`}
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
            <div className="mt-4 flex flex-col gap-2 border-t border-outline-variant/40 bg-surface-lowest px-4 py-4 sm:px-5">
              {r.messages.map((m) => (
                <Bubble key={m.id} meta={new Date(m.at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}>
                  {m.body}
                </Bubble>
              ))}
              <span className="mt-1 type-label-s text-on-surface-variant">
                Read by {r.intent.model ?? "Gemma"} · {Math.round(r.intent.confidence * 100)}% sure
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mt-3 flex items-center gap-2 border-t border-outline-variant/40 py-2 pr-3 pl-2 sm:pr-4 sm:pl-3">
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="state-layer inline-flex h-10 items-center gap-1.5 rounded-full px-3 type-label-l text-on-surface-variant">
          {r.messages.length} message{r.messages.length > 1 ? "s" : ""}
          <IconArrowDown className={cx("icon size-4 transition-transform duration-200", open && "rotate-180")} />
        </button>
        <Confidence value={r.intent.confidence} />
        <div className="flex-1" />
        <Link to={`/messages?c=${encodeURIComponent(r.comicId)}`} className="state-layer pressable inline-flex h-10 items-center gap-1.5 rounded-full px-3 type-label-l text-on-surface-variant" title={`Open the chat with ${r.comicName}`}>
          <IconChat className="icon size-4" />
          <span className="max-[400px]:sr-only">Open chat</span>
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
          <Button size="sm" variant="tonal" onClick={() => void reopen()}>
            Reopen
          </Button>
        ) : (
          <>
            {!placedIn && <IconButton icon={IconSkip} label="Dismiss" onClick={() => setStatus("dismissed")} />}
            {placedShow ? (
              <Chip tone="success" icon={r.status === "confirmed" ? IconCheck : IconMic}>
                {r.status === "confirmed" ? "Confirmed" : "In"} · {placedShow.name}
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
  return (
    <span className="hidden items-center gap-2 type-label-s text-on-surface-variant min-[420px]:inline-flex" title={`Gemma is ${pct}% sure this is a spot request`}>
      <span className="relative h-1 w-12 overflow-hidden rounded-full bg-surface-highest">
        <motion.span className="absolute inset-y-0 left-0 rounded-full bg-primary" initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.6, ease: [0.23, 1, 0.32, 1] }} />
      </span>
      <span className="tabular">{pct}%</span>
    </span>
  );
}
