import { useMemo, useState } from "react";
import { where } from "firebase/firestore";
import { AnimatePresence, motion } from "motion/react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { updateDoc } from "firebase/firestore";
import {
  DAY_SHORT,
  INTENT_THRESHOLD,
  formatTime,
  shiftWeek,
  type Lineup,
  type Show,
  type SpotRequest,
} from "@spot/shared";
import { useApp } from "../lib/app";
import { timeAgo, useCollection, useNow, userDoc } from "../lib/data";
import { placeComic } from "../lib/lineup";
import { PageHeader } from "../components/Shell";
import { WeekSwitcher } from "../components/WeekSwitcher";
import { Menu, MenuItem } from "../components/Menu";
import { Avatar, Bubble, Button, Chip, Empty, IconButton, cx } from "../components/ui";
import { ConnectCard } from "../components/ConnectCard";
import { IconArrowDown, IconChatCheck, IconCheck, IconHistory, IconInbox, IconMic, IconSkip, IconSparkle, IconStar } from "../components/icons";

type Lane = "asked" | "maybe" | "placed" | "closed";
const LANES: { id: Lane; label: string }[] = [
  { id: "asked", label: "Asked" },
  { id: "maybe", label: "Maybe" },
  { id: "placed", label: "Placed" },
  { id: "closed", label: "Closed" },
];

const laneOf = (r: SpotRequest): Lane =>
  r.status === "dismissed" || r.status === "rejected" ? "closed" : r.status === "assigned" || r.status === "confirmed" ? "placed" : r.intent.confidence >= INTENT_THRESHOLD ? "asked" : "maybe";

export function Requests() {
  const { uid, week, session, shows, comicsById } = useApp();
  const requests = useCollection<SpotRequest>(uid, "requests", [where("weekOf", "==", week)], week);
  const lineups = useCollection<Lineup>(uid, "lineups", [where("weekOf", "==", week)], week);
  const [lane, setLane] = useState<Lane>("asked");
  const lastWeek = shiftWeek(week, -1);

  const grouped = useMemo(() => {
    const g: Record<Lane, SpotRequest[]> = { asked: [], maybe: [], placed: [], closed: [] };
    for (const r of requests.data) g[laneOf(r)].push(r);
    // Fairness first: people who didn't perform last week float up, then first-come.
    for (const k of Object.keys(g) as Lane[])
      g[k].sort((a, b) => {
        const pa = comicsById.get(a.comicId)?.lastPerformedWeek === lastWeek ? 1 : 0;
        const pb = comicsById.get(b.comicId)?.lastPerformedWeek === lastWeek ? 1 : 0;
        return pa - pb || a.createdAt - b.createdAt;
      });
    return g;
  }, [requests.data, comicsById, lastWeek]);

  const activeShows = shows.filter((s) => s.active);
  const linked = session?.status === "ready";

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Requests"
        subtitle={requests.data.length ? `${grouped.asked.length} waiting · ${grouped.placed.length} placed` : "Spot requests Gemma found in your DMs"}
        actions={<WeekSwitcher />}
      >
        <div className="-mx-4 mt-5 flex overflow-x-auto border-b border-outline-variant px-4 [scrollbar-width:none] sm:mx-0 sm:mt-6 sm:gap-1 sm:px-0" role="tablist">
          {LANES.map((l) => (
            <button key={l.id} role="tab" aria-selected={lane === l.id} onClick={() => setLane(l.id)} className="state-layer relative flex flex-1 items-center justify-center gap-1.5 rounded-t-sm px-2.5 pt-2 pb-3 type-title-s whitespace-nowrap sm:flex-none sm:gap-2 sm:px-4">
              <span className={lane === l.id ? "text-primary" : "text-on-surface-variant"}>{l.label}</span>
              <span className={cx("rounded-full px-1.5 type-label-s tabular", lane === l.id ? "bg-primary text-on-primary" : "bg-surface-high text-on-surface-variant")}>{grouped[l.id].length}</span>
              {lane === l.id && <motion.span layoutId="lane-ink" className="absolute inset-x-3 bottom-0 h-[3px] rounded-t-full bg-primary" transition={{ type: "spring", duration: 0.4, bounce: 0.15 }} />}
            </button>
          ))}
        </div>
      </PageHeader>

      <div className="px-4 pb-10 sm:px-8">
        {!linked && !requests.data.length ? (
          <ConnectCard compact />
        ) : grouped[lane].length === 0 ? (
          <LaneEmpty lane={lane} />
        ) : (
          <motion.ul className="grid gap-3" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.04 } } }}>
            <AnimatePresence initial={false}>
              {grouped[lane].map((r) => (
                <RequestCard key={r.id} r={r} shows={activeShows} lineups={lineups.data} performedLastWeek={comicsById.get(r.comicId)?.lastPerformedWeek === lastWeek} tier={comicsById.get(r.comicId)?.tier} />
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
    </div>
  );
}

function LaneEmpty({ lane }: { lane: Lane }) {
  const copy: Record<Lane, [string, string]> = {
    asked: ["Inbox zero. Go write.", "New spot requests show up here as they arrive. Gemma reads each burst of messages together, so a hey, a pause and then the ask count as one request."],
    maybe: ["Nothing borderline", "Messages Gemma wasn't sure about land here, so nothing gets missed."],
    placed: ["No one placed yet", "Assign comics to a show from Asked, or drag them on the Lineup board."],
    closed: ["Nothing closed", "Dismissed requests and comics who got a regret message stay here for the week."],
  };
  return (
    <Empty icon={lane === "asked" ? IconInbox : IconSparkle} title={copy[lane][0]}>
      {copy[lane][1]}
    </Empty>
  );
}

function RequestCard({ r, shows, lineups, performedLastWeek, tier }: { r: SpotRequest; shows: Show[]; lineups: Lineup[]; performedLastWeek: boolean; tier?: string }) {
  const { uid, week } = useApp();
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const placedIn = lineups.find((l) => l.slots.some((s) => s.comicId === r.comicId));
  const placedShow = shows.find((s) => s.id === placedIn?.showId);
  const preferred = new Set(r.intent.preferredDays);
  const sortedShows = [...shows].sort((a, b) => Number(preferred.has(b.weekday)) - Number(preferred.has(a.weekday)));
  const last = r.messages[r.messages.length - 1];

  const assign = async (show: Show) => {
    await placeComic(uid, week, show, r.comicId, lineups);
    toast.success(`${r.comicName.split(" ")[0]} → ${show.name}`);
  };
  const setStatus = (status: SpotRequest["status"]) => updateDoc(userDoc(uid, "requests", r.id), { status, updatedAt: Date.now() });

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
          <p className="mt-0.5 type-body-m text-on-surface-variant sm:type-body-l">{r.intent.note || `“${last?.body}”`}</p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {r.intent.preferredDays.length ? (
              r.intent.preferredDays.map((d) => (
                <Chip key={d} tone="primary">
                  {DAY_SHORT[d]}
                </Chip>
              ))
            ) : (
              <Chip>Any day</Chip>
            )}
            {tier && tier !== "open" && (
              <Chip tone="tertiary" icon={IconStar}>
                {tier}
              </Chip>
            )}
            {performedLastWeek && (
              <Chip icon={IconHistory} className="border-dashed">
                Last week
              </Chip>
            )}
            {r.ackedAt && (
              <span className="inline-flex items-center gap-1 px-1 type-label-m text-on-surface-variant">
                <IconChatCheck className="icon size-4" /> Acked
              </span>
            )}
          </div>
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
        {r.status === "rejected" ? (
          <Chip icon={IconChatCheck}>Regret sent</Chip>
        ) : r.status === "dismissed" ? (
          <Button size="sm" variant="text" onClick={() => setStatus(r.ackedAt ? "acked" : "new")}>
            Restore
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
