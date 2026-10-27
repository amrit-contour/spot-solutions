// Messages: chat with the comics on your list without leaving the app. Chats are read live from your own WhatsApp (through your
// server) when you open the page. The command results that carry them are deleted as soon as they are read, and nothing is
// written to Firestore. This device keeps a capped copy (IndexedDB, wiped at sign-out) so the list and each chat open at once
// and then sync (docs/architecture.md "Messages"). Only people in Comics are listed.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import { updateDoc, where } from "firebase/firestore";
import { toast } from "sonner";
import {
  DAY_NAMES,
  DAY_SHORT,
  GROUP_POST_KEYS,
  dateInWeek,
  daysBetween,
  dayLabel,
  filterThreads,
  formatDate,
  formatTime,
  groupByDay,
  groupPostMessage,
  groupPostVars,
  messageType,
  nextRun,
  nextShowDate,
  whenLabel,
  lastSpot,
  localNow,
  chatSyncView,
  effectiveAwaiting,
  toggleMyReaction,
  type ChatMark,
  type GetThreadResult,
  type GroupPost,
  type GroupThreadItem,
  type Lineup,
  type ListThreadsResult,
  type ReactionChip,
  type RichMessage,
  type Show,
  type SpotRequest,
  type SummarizeThreadResult,
  type ThreadAction,
  type ThreadMediaResult,
  type ThreadMember,
  type ThreadItem,
  type ThreadMessage,
} from "@spot/shared";
import { useApp } from "../lib/app";
import { useCollection, useNow, userDoc } from "../lib/data";
import { isDemoUser } from "../lib/demo";
import { demoSource, liveSource, type ChatSource, type MentionTag, type OutPhoto } from "../lib/messages";
import { placeAsTold, placeComic } from "../lib/lineup";
import { PageHeader } from "@spot/ui";
import { Menu, MenuItem } from "@spot/ui";
import { COMIC_MESSAGE_KEYS, SnippetMenu } from "../components/SnippetMenu";
import { useNeverRead } from "../lib/neverRead";
import { listKey, readCached, saveList, saveThread, threadKey as threadCacheKey } from "../lib/chatCache";
import { useChatMarks } from "../lib/chatMarks";
import { useMediaQuery, useVisualViewportFrame } from "../lib/viewport";
import { Bubble, PendingBubble } from "../components/chat/Bubble";
import { PhotoViewer } from "../components/chat/media";
import { PullIndicator, usePullToRefresh } from "../components/chat/PullToRefresh";
import { SwipeRow, type SwipeAction } from "../components/chat/SwipeRow";
import { SyncBanner, useSyncGate } from "../components/chat/SyncGate";
import { GroupPostsEditor } from "../components/GroupPosts";
import { RequestPills, requestPills } from "../components/RequestTags";
import { messageSummary } from "@spot/ui";
import { ChatComposer, type Outgoing } from "../components/ChatComposer";
import { PinCard, PollCard, WaText } from "@spot/ui";
import { Button, Chip, ConfirmDialog, Empty, IconButton, Segmented, Select, Sheet, Spinner, cx } from "@spot/ui";
import { IconArrowDown, IconArrowLeft, IconArrowRight, IconChat, IconCheck, IconClock, IconClose, IconEye, IconGroup, IconMic, IconRefresh, IconMenuDots, IconSearch, IconServer, IconSkip, IconSparkle } from "@spot/ui";
import { ComicAvatar, GroupAvatar } from "../lib/photos";

const OPEN = ["new", "acked"];


interface LiveCache<T> {
  read: () => Promise<{ savedAt: number; data: T } | null>;
  write: (data: T) => Promise<void>;
}

/**
 * Data that loads on demand and refreshes while the tab is visible. A result never outlives its key (the open chat). With a
 * `cache` the saved copy shows at once while the real read runs; `lastOkAt` stays 0 until this visit has read WhatsApp for real.
 */
function useLive<T>(load: () => Promise<T>, key: string, enabled: boolean, everyMs: number, cache?: LiveCache<T>) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean; lastOkAt: number; readStartedAt: number }>({ data: null, error: null, loading: enabled, lastOkAt: 0, readStartedAt: 0 });
  const loadRef = useRef(load);
  loadRef.current = load;
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const keyRef = useRef(key);
  keyRef.current = key;
  const flight = useRef<{ k: string; p: Promise<void> } | null>(null);
  const lastAt = useRef(0);
  /** `fresh`: start a new read even if one is running (it may have begun before what you just did). */
  const refresh = useCallback(async (fresh = false): Promise<void> => {
    const k = keyRef.current;
    if (flight.current?.k === k) {
      if (!fresh) return flight.current.p;
      await flight.current.p.catch(() => undefined);
      if (k !== keyRef.current) return;
    }
    const started = Date.now();
    let p!: Promise<void>;
    p = (async () => {
      setState((s) => ({ ...s, loading: true }));
      try {
        const data = await loadRef.current();
        if (k === keyRef.current) {
          lastAt.current = Date.now();
          setState({ data, error: null, loading: false, lastOkAt: Date.now(), readStartedAt: started });
          void cacheRef.current?.write(data).catch(() => undefined);
        }
      } catch (e) {
        if (k === keyRef.current) setState((s) => ({ ...s, error: (e as Error).message, loading: false }));
      } finally {
        if (flight.current?.p === p) flight.current = null;
      }
    })();
    flight.current = { k, p };
    return p;
  }, []);
  useEffect(() => {
    setState({ data: null, error: null, loading: enabled, lastOkAt: 0, readStartedAt: 0 });
    lastAt.current = 0;
    if (!enabled) return;
    const k = key;
    // The saved copy first (if this visit hasn't read anything yet), then the real read.
    void cacheRef.current
      ?.read()
      .then((c) => c && keyRef.current === k && setState((s) => (s.data ? s : { ...s, data: c.data })))
      .catch(() => undefined);
    void refresh();
    const tick = () => document.visibilityState === "visible" && Date.now() - lastAt.current > everyMs - 1000 && void refresh();
    const t = setInterval(tick, everyMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [key, enabled, everyMs, refresh]);
  return { ...state, refresh };
}

const clock = (at: number, tz: string) => new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(at));
const listTime = (at: number, now: number, tz: string) => {
  const d = dayLabel(at, now, tz);
  return d === "Today" ? clock(at, tz) : d;
};

export function Messages() {
  const { uid, week, session, workerOnline, server, comics, comicsById, shows, settings } = useApp();
  const demo = isDemoUser();
  const requests = useCollection<SpotRequest>(uid, "requests", [where("weekOf", "==", week)], week);
  const lineups = useCollection<Lineup>(uid, "lineups", [where("weekOf", "==", week)], week);
  const [params, setParams] = useSearchParams();
  const selected = params.get("c");
  const selectedGroup = params.get("g");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "needs" | "groups">(() => (selectedGroup ? "groups" : "all"));
  const needsReply = filter === "needs";
  const now = useNow(15_000);

  const demoData = useRef({ comics, requests: requests.data, lineups: lineups.data, shows, now });
  demoData.current = { comics, requests: requests.data, lineups: lineups.data, shows, now };
  const source = useMemo<ChatSource>(() => (demo ? demoSource(() => demoData.current) : liveSource(uid)), [demo, uid]);

  const ready = demo || (workerOnline && session?.status === "ready");
  // The demo's conversations come from the sandbox's requests, so they load with the requests.
  const listCache = useMemo<LiveCache<ListThreadsResult>>(() => ({ read: () => readCached<ListThreadsResult>(listKey(uid)), write: (d) => saveList(uid, d) }), [uid]);
  const list = useLive<ListThreadsResult>(() => source.list(), `${uid}:${demo}:${demo ? `${requests.data.length}:${comics.length}:${lineups.data.length}` : ""}`, ready && (!demo || !requests.loading), 60_000, listCache);
  // "Done" / "Needs reply" flags live on this device only; they bend the list's own needs-reply answer until something new arrives.
  const marks = useChatMarks(uid);
  const threads = useMemo(() => (list.data?.threads ?? []).map((t) => ({ ...t, awaitingYou: effectiveAwaiting(t, marks.marks[t.comicId]) })), [list.data, marks.marks]);
  useEffect(() => {
    if (list.lastOkAt && list.data) marks.prune(list.data.threads.map((t) => ({ id: t.comicId, at: t.at })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data, list.lastOkAt]);
  const shown = useMemo(() => filterThreads(threads, q).filter((t) => !needsReply || t.awaitingYou), [threads, q, needsReply]);
  const waiting = threads.filter((t) => t.awaitingYou).length;
  const sync = chatSyncView({ lastOkAt: list.lastOkAt, loading: list.loading, error: list.error, now }, list.data?.at);
  const gate = useSyncGate(sync.ok, () => void list.refresh(true), list.data?.at ?? null, now, settings.timezone);
  const nr = useNeverRead();
  const [neverFor, setNeverFor] = useState<ThreadItem | null>(null);
  const neverComic = neverFor ? comicsById.get(neverFor.comicId) : undefined;
  const wide = useMediaQuery("(min-width: 1024px)");
  const groups = useMemo(() => list.data?.groups ?? [], [list.data]);
  const shownGroups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? groups.filter((g) => g.name.toLowerCase().includes(needle) || g.snippet.toLowerCase().includes(needle)) : groups;
  }, [groups, q]);
  const linkedGroups = new Set(shows.map((s) => s.groupId).filter(Boolean)).size;
  const tz = settings.timezone;

  const open = (id: string) => setParams({ c: id });
  const openGroup = (id: string) => setParams({ g: id });
  const group = selectedGroup ? (groups.find((g) => g.groupId === selectedGroup) ?? groupStub(selectedGroup, shows)) : undefined;
  const anyOpen = Boolean(selected || selectedGroup);
  const close = () => setParams({}, { replace: true });
  const comic = selected ? comicsById.get(selected) : undefined;
  const pull = usePullToRefresh(ready && !anyOpen && !wide && filter !== "groups", () => list.refresh(true));

  // The row's three actions, each asking first when the list isn't synced. Done and Needs reply can be undone from the toast.
  const rowActions = (t: ThreadItem) => {
    const before: ChatMark | undefined = marks.marks[t.comicId];
    const undo = (what: string) => toast.success(what, { action: { label: "Undo", onClick: () => marks.restore(t.comicId, before) } });
    return {
      done: () => gate.guard(() => (marks.done(t.comicId, t), undo(`${t.name.split(/\s+/)[0]} marked done`)), { verb: "mark it done", anyway: "Mark done anyway" }),
      toggle: () =>
        gate.guard(
          () => {
            marks.toggle(t.comicId, t);
            undo(t.awaitingYou ? `${t.name.split(/\s+/)[0]} cleared` : `${t.name.split(/\s+/)[0]} needs a reply`);
          },
          { verb: t.awaitingYou ? "clear it" : "flag it", anyway: "Continue anyway" },
        ),
      never: () => gate.guard(() => setNeverFor(t), { verb: "add them to Never read", anyway: "Continue anyway" }),
    };
  };

  return (
    <div className="w-full">
      {/* On phones an open chat takes the whole screen, so the page title steps aside. `contents` keeps the header sticky. */}
      <div className={anyOpen ? "hidden lg:contents" : "contents"}>
        <PageHeader
          title="Messages"
          subtitle={ready ? <span aria-live="polite">{sync.label}</span> : "Read live from your WhatsApp."}
          actions={ready && <IconButton icon={IconRefresh} label={list.loading ? "Syncing chats" : "Sync chats"} onClick={() => void list.refresh(true)} disabled={list.loading} className={cx("size-9", list.loading && "[&_svg]:animate-spin")} />}
        />
      </div>

      <div className={cx("px-4 sm:px-8 lg:grid lg:h-[calc(100dvh-var(--page-header-h,0px)-1.5rem)] lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)] lg:gap-6", anyOpen ? "pb-0 lg:pb-6" : "pb-6")}>
        <section aria-label="Chats" className={cx("min-h-0 flex-col lg:flex", anyOpen ? "hidden" : "flex")}>
          {!ready ? (
            <Unavailable offline={!workerOnline} cantTell={server.reach === "unknown"} />
          ) : (
            <>
              {!sync.ok && !sync.syncing && list.data && <div className="-mx-4 sm:-mx-8 lg:mx-0 lg:overflow-hidden lg:rounded-lg"><SyncBanner savedAt={list.data.at} now={now} tz={tz} onRetry={() => void list.refresh(true)} /></div>}
              {demo && <p className="mb-3 rounded-lg bg-tertiary-container px-4 py-3 type-body-s text-on-tertiary-container">Sample chats built from the demo's requests. A real account shows your WhatsApp conversations here.</p>}
              <div className="sticky top-[var(--page-header-h,0px)] z-20 -mx-4 flex flex-col gap-2 bg-surface px-4 pt-2 pb-2 sm:-mx-8 sm:px-8 lg:static lg:mx-0 lg:px-0">
                <label className="relative block">
                  <IconSearch className="icon pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-on-surface-variant" />
                  <input
                    type="search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => e.key === "Escape" && setQ("")}
                    placeholder="Search name or number"
                    aria-label="Search chats"
                    className="h-11 w-full rounded-full border border-outline-variant bg-surface-low pr-3 pl-10 text-base outline-none placeholder:text-on-surface-variant/70 focus:border-primary sm:type-body-m"
                  />
                </label>
                <Segmented
                  full
                  size="sm"
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: "all", label: "All" },
                    { value: "needs", label: `Needs reply${waiting ? ` · ${waiting}` : ""}` },
                    { value: "groups", label: "Groups" },
                  ]}
                />
              </div>
              <div className="min-h-0 flex-1 lg:overflow-y-auto lg:overscroll-contain">
                <PullIndicator pull={pull.pull} busy={pull.busy} />
                {filter === "groups" ? (
                  list.loading && !list.data ? (
                    <ListSkeleton />
                  ) : list.error && !list.data ? (
                    <ErrorNote message={list.error} onRetry={() => void list.refresh()} />
                  ) : !groups.length ? (
                    <Empty icon={IconGroup} title={linkedGroups ? "Your show groups will show up here" : "No show groups linked yet"} action={<Link to="/shows" className="state-layer inline-flex h-10 items-center rounded-full bg-secondary-container px-5 type-label-l text-on-secondary-container">Open Shows</Link>}>
                      {linkedGroups ? "Refresh in a moment. If a group still doesn't show, update your server." : "Link a WhatsApp group to a show under Shows, and you can chat in it and schedule posts from here."}
                    </Empty>
                  ) : !shownGroups.length ? (
                    <p className="px-2 py-8 text-center type-body-m text-on-surface-variant">No groups match “{q.trim()}”.</p>
                  ) : (
                    <ul className="flex flex-col pt-1" aria-live="polite">
                      {shownGroups.map((g) => (
                        <GroupRow key={g.groupId} g={g} active={g.groupId === selectedGroup} now={now} tz={tz} onOpen={() => openGroup(g.groupId)} />
                      ))}
                    </ul>
                  )
                ) : list.loading && !list.data ? (
                  <ListSkeleton />
                ) : list.error && !list.data ? (
                  <ErrorNote message={list.error} onRetry={() => void list.refresh()} />
                ) : !threads.length ? (
                  <Empty icon={IconChat} title="No chats yet">
                    People on your Comics list show up here once you've messaged each other on WhatsApp.
                  </Empty>
                ) : !shown.length ? (
                  <p className="px-2 py-8 text-center type-body-m text-on-surface-variant">{q.trim() ? `No chats match “${q.trim()}”.` : "Nobody is waiting on a reply from you."}</p>
                ) : (
                  <ul className="flex flex-col pt-1" aria-live="polite">
                    {shown.map((t) => (
                      <ThreadRow key={t.comicId} t={t} active={t.comicId === selected} now={now} tz={tz} onOpen={() => open(t.comicId)} actions={rowActions(t)} />
                    ))}
                  </ul>
                )}
                {list.data?.neverRead?.length ? <NeverReadFold items={list.data.neverRead} /> : null}
                {list.data && !demo && <p className="px-2 pt-3 pb-1 type-body-s text-on-surface-variant">Unread counts come from WhatsApp; opening a chat here doesn't mark it read. A copy of your chats is kept on this device only and cleared when you sign out.</p>}
              </div>
            </>
          )}
        </section>

        <section aria-label="Conversation" className={cx("min-h-0 min-w-0 flex-col lg:flex", anyOpen ? "flex" : "hidden")}>
          {group && ready ? (
            <GroupView key={group.groupId} source={source} group={group} lineups={lineups.data} onBack={close} onChanged={() => void list.refresh()} />
          ) : selected && ready ? (
            comic ? (
              <ThreadView
                key={selected}
                source={source}
                comic={comic}
                request={requests.data.find((r) => r.comicId === selected)}
                lineups={lineups.data}
                onBack={close}
                onChanged={() => void list.refresh()}
              />
            ) : (
              <Empty icon={IconChat} title="That person isn't in your Comics list">
                Only people on your list can be opened here.
                <span className="mt-4 block">
                  <Button variant="tonal" onClick={close}>Back to chats</Button>
                </span>
              </Empty>
            )
          ) : (
            <div className="hidden h-full flex-1 place-items-center rounded-lg bg-surface-low lg:grid">
              <p className="px-6 text-center type-body-m text-on-surface-variant">{ready ? "Pick a chat to read and reply." : ""}</p>
            </div>
          )}
        </section>
      </div>
      {gate.dialog}
      <ConfirmDialog
        open={Boolean(neverFor)}
        onClose={() => setNeverFor(null)}
        title={`Never read ${neverFor?.name ?? ""}?`}
        confirmLabel="Never read"
        onConfirm={async () => {
          if (!neverFor || !neverComic) throw new Error("That person isn't in your Comics list.");
          await nr.add([neverComic.id, neverComic.chatId].filter((x): x is string => Boolean(x)).map((id) => ({ id, kind: "person" as const, name: neverComic.name })));
          toast.success(`${neverComic.name} added to Never read`);
          void list.refresh(true);
        }}
      >
        Their messages are skipped: never read, never sent to AI, never stored. They are on your Comics list, so their spot requests will be ignored. This chat disappears from Messages. Undo it any time in Settings → Rules &amp; replies → Never read.
      </ConfirmDialog>
    </div>
  );
}

function Unavailable({ offline, cantTell }: { offline: boolean; cantTell?: boolean }) {
  return cantTell ? (
    <Empty icon={IconServer} title="You're offline, so chats can't be read right now">
      Chats are read from your server when you open this page. They'll appear here once your phone is back online.
    </Empty>
  ) : offline ? (
    <Empty icon={IconServer} title="Your server is offline, so chats can't be read right now" action={<Link to="/server" className="state-layer inline-flex h-10 items-center rounded-full bg-secondary-container px-5 type-label-l text-on-secondary-container">Check the server</Link>}>
      Chats stay on your own computer and are read when you open this page. Start your server and they'll appear here.
    </Empty>
  ) : (
    <Empty icon={IconChat} title="WhatsApp isn't linked" action={<Link to="/settings#whatsapp" className="state-layer inline-flex h-10 items-center rounded-full bg-secondary-container px-5 type-label-l text-on-secondary-container">Link WhatsApp</Link>}>
      Link your WhatsApp and the chats with your comics show up here.
    </Empty>
  );
}

function ListSkeleton() {
  return (
    <ul className="flex flex-col gap-1 pt-2" aria-label="Loading chats" aria-busy>
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className="flex items-center gap-3 px-2 py-3">
          <span className="size-11 flex-none rounded-full bg-surface-high" />
          <span className="flex flex-1 flex-col gap-2">
            <span className="h-3.5 w-1/3 rounded-xs bg-surface-high" />
            <span className="h-3 w-3/4 rounded-xs bg-surface-container" />
          </span>
        </li>
      ))}
    </ul>
  );
}

function ErrorNote({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg bg-error-container px-4 py-3 text-on-error-container">
      <p className="type-body-m">{message}</p>
      <Button size="sm" variant="tonal" onClick={onRetry}>Try again</Button>
    </div>
  );
}

/** A linked group that isn't in the list yet (opened from Shows before the list loads). */
function groupStub(groupId: string, shows: Show[]): GroupThreadItem | undefined {
  const linked = shows.filter((s) => s.groupId === groupId);
  if (!linked.length) return undefined;
  return { groupId, name: `${linked[0].name} group`, showIds: linked.map((s) => s.id), at: 0, snippet: "", fromMe: false, unread: 0 };
}

function GroupRow({ g, active, now, tz, onOpen }: { g: GroupThreadItem; active: boolean; now: number; tz: string; onOpen: () => void }) {
  const { shows } = useApp();
  const scheduled = shows.filter((s) => g.showIds.includes(s.id)).flatMap((s) => s.groupPosts ?? []).filter((p) => p.enabled).length;
  return (
    <li>
      <button onClick={onOpen} aria-current={active ? "true" : undefined} className={cx("state-layer flex min-h-[4.5rem] w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left", active && "bg-secondary-container")}>
        <GroupAvatar groupId={g.groupId} name={g.name} size={44} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate type-title-m font-medium">{g.name}</span>
            {g.at > 0 && <span className={cx("flex-none type-label-m tabular", g.unread ? "text-primary" : "text-on-surface-variant")}>{listTime(g.at, now, tz)}</span>}
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate type-body-m text-on-surface-variant">
              {g.fromMe ? <span>You: </span> : g.author ? <span>{g.author}: </span> : null}
              {g.snippet || "No messages yet"}
            </span>
            {g.unread > 0 && (
              <span className="grid min-w-5 flex-none place-items-center rounded-full bg-primary px-1.5 type-label-s leading-5 text-on-primary tabular">
                {g.unread}
                <span className="sr-only"> unread</span>
              </span>
            )}
          </span>
          {scheduled > 0 && (
            <span className="mt-1 inline-flex items-center gap-1 type-label-s text-on-surface-variant">
              <IconClock className="icon size-3.5" /> {scheduled} scheduled post{scheduled > 1 ? "s" : ""}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

function ThreadRow({ t, active, now, tz, onOpen, actions }: { t: ThreadItem; active: boolean; now: number; tz: string; onOpen: () => void; actions: { done: () => void; toggle: () => void; never: () => void } }) {
  // Phones: swipe right for Needs reply, left for Clear (when they're waiting on you). Everyone: the ⋯ menu, which also has Never read.
  const left: SwipeAction[] = t.awaitingYou ? [] : [{ key: "needs", label: "Needs reply", icon: IconChat, tone: "secondary", run: actions.toggle }];
  const right: SwipeAction[] = t.awaitingYou ? [{ key: "clear", label: "Clear", icon: IconCheck, tone: "primary", run: actions.done }] : [];
  return (
    <li className="group/r relative">
      <SwipeRow left={left} right={right}>
        <button
          onClick={onOpen}
          aria-current={active ? "true" : undefined}
          className={cx("state-layer flex min-h-[4.5rem] w-full items-center gap-3 rounded-lg py-2.5 pr-10 pl-2 text-left", active && "bg-secondary-container")}
        >
          <ComicAvatar id={t.comicId} name={t.name} size={44} tone={t.awaitingYou ? "primary" : "secondary"} />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span className={cx("min-w-0 flex-1 truncate type-title-m", !t.awaitingYou && !t.unread && "font-medium")}>{t.name}</span>
              <span className={cx("flex-none type-label-m tabular", t.unread ? "text-primary" : "text-on-surface-variant")}>{listTime(t.at, now, tz)}</span>
            </span>
            <span className="mt-0.5 flex items-center gap-2">
              <span className={cx("min-w-0 flex-1 truncate type-body-m", t.awaitingYou ? "text-on-surface" : "text-on-surface-variant")}>
                {t.fromMe && <span className="text-on-surface-variant">You: </span>}
                {t.snippet || "No messages yet"}
              </span>
              {t.unread > 0 && (
                <span className="grid min-w-5 flex-none place-items-center rounded-full bg-primary px-1.5 type-label-s leading-5 text-on-primary tabular">
                  {t.unread}
                  <span className="sr-only"> unread</span>
                </span>
              )}
            </span>
            {t.awaitingYou && <span className="mt-1 inline-flex items-center gap-1 type-label-s text-primary">Their message is waiting for your reply</span>}
          </span>
        </button>
        <div className="absolute inset-y-0 right-0.5 flex items-center gap-0.5">
          {t.awaitingYou && (
            <button type="button" onClick={actions.done} aria-label={`Mark ${t.name} done`} title="Done" className="state-layer hidden size-8 place-items-center rounded-full bg-surface-container text-on-surface-variant opacity-0 transition-opacity duration-150 group-hover/r:opacity-100 focus-visible:opacity-100 pointer-fine:grid">
              <IconCheck className="icon size-5" />
            </button>
          )}
          <Menu
            align="right"
            trigger={(toggle) => (
              <button type="button" onClick={toggle} aria-label={`More for ${t.name}`} aria-haspopup="menu" className="state-layer grid size-8 place-items-center rounded-full text-on-surface-variant pointer-fine:opacity-0 pointer-fine:transition-opacity pointer-fine:duration-150 group-focus-within/r:opacity-100 group-hover/r:opacity-100">
                <IconMenuDots className="icon size-5" />
              </button>
            )}
          >
            {(close) => (
              <>
                {t.awaitingYou && <MenuItem onClick={() => (close(), actions.done())}>Done</MenuItem>}
                <MenuItem onClick={() => (close(), actions.toggle())}>{t.awaitingYou ? "Clear needs reply" : "Needs reply"}</MenuItem>
                <MenuItem onClick={() => (close(), actions.never())}>Never read…</MenuItem>
              </>
            )}
          </Menu>
        </div>
      </SwipeRow>
    </li>
  );
}

// ---------- One conversation ----------

interface Pending {
  id: string;
  out: Outgoing;
  state: "sending" | "sent" | "failed";
  at: number;
  /** When it was accepted by WhatsApp: the real message replaces this once a read that started after it has come back. */
  sentAt?: number;
  error?: string;
}

function mergeNewest(prev: ThreadMessage[], page: ThreadMessage[]) {
  if (!page.length) return prev;
  return [...prev.filter((m) => m.at < page[0].at && !page.some((p) => p.id === m.id)), ...page];
}

type ComicOf = NonNullable<ReturnType<typeof useApp>["comicsById"] extends Map<string, infer C> ? C : never>;

function ThreadView({ source, comic, request, lineups, onBack, onChanged }: { source: ChatSource; comic: ComicOf; request?: SpotRequest; lineups: Lineup[]; onBack: () => void; onChanged: () => void }) {
  const { week, shows, venues, settings, comics } = useApp();
  const first = comic.name.split(/\s+/)[0] || comic.name;
  const placed = lineups.find((l) => l.status !== "cancelled" && l.status !== "canned" && l.slots.some((s) => s.comicId === comic.id));
  const placedShow = shows.find((s) => s.id === placed?.showId);
  const placedVenue = venues.find((v) => v.id === placedShow?.venueId);
  const prev = lastSpot(comic.history, localNow(new Date(), settings.timezone).date);
  // What the Templates menu fills in: their show this week (if any) and their last spot.
  const vars = {
    ...(placedShow && { show: placedShow.name, venue: placedVenue?.name, mapsLink: placedVenue?.mapsLink, day: DAY_NAMES[placedShow.weekday], date: formatDate(dateInWeek(week, placedShow.weekday)), time: formatTime(placedShow.startTime) }),
    ...(prev && { lastShow: prev.showName, lastDate: formatDate(prev.date) }),
  };
  const [draft, setDraft] = useState<RichMessage | null>(null);
  const defaultVenue = placedShow?.venueId ?? request?.intent.venueId ?? undefined;
  return (
    <Conversation
      threadKey={comic.id}
      load={(before) => source.thread(comic.id, before)}
      media={(id) => source.media({ comicId: comic.id }, id)}
      send={(msg, opts) => source.send({ id: comic.id, chatId: comic.chatId, comicId: comic.id, name: comic.name, tags: opts.tags }, msg, opts)}
      sendImage={(p) => source.sendImage({ comicId: comic.id }, p)}
      react={(id, emoji) => source.react({ comicId: comic.id }, id, emoji)}
      people={[{ id: comic.id, name: comic.name }, ...comics.filter((c) => c.id !== comic.id && (c.phone || c.chatId)).map((c) => ({ id: c.id, name: c.name }))]}
      onBack={onBack}
      onSent={onChanged}
      ariaLabel={`Chat with ${comic.name}`}
      labelFor={() => first}
      defaultVenueId={defaultVenue}
      voiceAllowed
      draft={draft}
      onDraftUsed={() => setDraft(null)}
      header={(sync) => (
        <>
          <ComicAvatar id={comic.id} name={comic.name} size={40} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate type-title-m">{comic.name}</h2>
            <p className="truncate type-body-s text-on-surface-variant tabular" aria-live="polite">
              {comic.phone && <span className="hidden lg:inline">+{comic.phone} · </span>}
              {sync}
            </p>
          </div>
          <AssistButton source={source} comic={comic} />
          <NeverReadButton comic={comic} onDone={onBack} />
        </>
      )}
      pinned={<ThreadContext comic={comic} request={request} lineups={lineups} placedShow={placedShow} />}
      aboveComposer={<AssistCard source={source} comic={comic} request={request} lineups={lineups} onUseReply={(t) => setDraft({ kind: "text", body: t })} week={week} />}
      templates={(pick, trigger) => <SnippetMenu name={comic.name} vars={vars} builtins={["confirm", "ack", "reject", "cancelSpot"]} messages={COMIC_MESSAGE_KEYS} onPick={pick} trigger={trigger} />}
    />
  );
}

/** Header action: stop reading this person's chat altogether (Settings → Never read lists everyone). */
function NeverReadButton({ comic, onDone }: { comic: ComicOf; onDone: () => void }) {
  const nr = useNeverRead();
  const [open, setOpen] = useState(false);
  const ids = [comic.id, comic.chatId].filter((x): x is string => Boolean(x));
  return (
    <>
      <IconButton icon={IconEye} label={`Never read ${comic.name}`} onClick={() => setOpen(true)} />
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Never read ${comic.name}?`}
        confirmLabel="Never read"
        onConfirm={async () => {
          await nr.add(ids.map((id) => ({ id, kind: "person" as const, name: comic.name })));
          toast.success(`${comic.name} added to Never read`);
          onDone();
        }}
      >
        Their messages are skipped: never read, never sent to AI, never stored. They are on your Comics list, so their spot requests will be ignored. This chat disappears from Messages. Undo it any time in Settings → Rules &amp; replies → Never read.
      </ConfirmDialog>
    </>
  );
}

/** Chats left out of the list on purpose: names only, no previews, collapsed. */
function NeverReadFold({ items }: { items: NonNullable<ListThreadsResult["neverRead"]> }) {
  return (
    <details className="mx-2 mt-3 rounded-lg bg-surface-container px-3 py-2">
      <summary className="cursor-pointer type-label-l text-on-surface-variant">Never read · {items.length}</summary>
      <ul className="mt-2 flex flex-col gap-1">
        {items.map((i) => (
          <li key={i.id} className="truncate type-body-s text-on-surface-variant">{i.name}{i.isGroup ? " (group)" : ""}</li>
        ))}
      </ul>
      <Link to="/settings#rules" className="mt-2 inline-block type-label-m text-primary underline underline-offset-4">Manage in Settings</Link>
    </details>
  );
}

function GroupView({ source, group, lineups, onBack, onChanged }: { source: ChatSource; group: GroupThreadItem; lineups: Lineup[]; onBack: () => void; onChanged: () => void }) {
  const { uid, shows, venues, comicsById, settings } = useApp();
  const groupShows = shows.filter((s) => s.groupId === group.groupId);
  const [showId, setShowId] = useState(groupShows[0]?.id ?? "");
  const show = groupShows.find((s) => s.id === showId) ?? groupShows[0];
  const venue = venues.find((v) => v.id === show?.venueId);
  const lineup = lineups.find((l) => l.showId === show?.id && l.status === "confirmed");
  const names = lineup?.slots.map((s) => comicsById.get(s.comicId)?.name ?? "TBA") ?? null;
  const today = localNow(new Date(), settings.timezone).date;
  const showDate = lineup?.date ?? (show ? nextShowDate(show, today) : today);
  // POCs as "@First" in the box; sending turns them into real tags.
  const pocTags = (show?.pocs ?? []).map((id) => ({ label: `@${comicsById.get(id)?.name.split(/\s+/)[0] ?? "POC"}`, comicId: id }));
  const vars = show ? groupPostVars(show, venue, showDate, names, pocTags.map((t) => t.label).join(", ")) : {};
  const posts = show?.groupPosts ?? [];
  // Edited as a draft while the sheet is open (no write per keystroke), saved when it closes.
  const [draftPosts, setDraftPosts] = useState<GroupPost[] | null>(null);
  const openSchedule = () => setDraftPosts(posts);
  const closeSchedule = () => {
    if (show && draftPosts && JSON.stringify(draftPosts) !== JSON.stringify(posts)) {
      void updateDoc(userDoc(uid, "shows", show.id), { groupPosts: draftPosts })
        .then(() => toast.success("Schedule saved"))
        .catch((e) => toast.error((e as Error).message));
    }
    setDraftPosts(null);
  };
  const scheduleOpen = draftPosts !== null;
  const members = show?.groupMembers?.groupId === group.groupId ? show.groupMembers.members.length : null;
  return (
    <Conversation
      threadKey={group.groupId}
      load={(before) => source.groupThread(group.groupId, before)}
      media={(id) => source.media({ groupId: group.groupId }, id)}
      send={(msg, opts) => source.send({ id: group.groupId, chatId: group.groupId, groupId: group.groupId, name: "everyone", tags: opts.tags }, msg, opts)}
      sendImage={(p) => source.sendImage({ groupId: group.groupId }, p)}
      react={(id, emoji) => source.react({ groupId: group.groupId }, id, emoji)}
      baseTags={pocTags}
      memberHints={show?.groupMembers?.groupId === group.groupId ? show.groupMembers.members.map((m) => ({ id: m.id, name: m.name })) : undefined}
      isGroup
      onBack={onBack}
      onSent={onChanged}
      ariaLabel={`${group.name} group`}
      labelFor={(m) => m.author ?? "Someone"}
      defaultVenueId={show?.venueId}
      voiceAllowed
      header={(sync) => (
        <>
          <GroupAvatar groupId={group.groupId} name={group.name} size={40} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate type-title-m">{group.name}</h2>
            <p className="truncate type-body-s text-on-surface-variant" aria-live="polite">
              <span className="hidden lg:inline">
                {groupShows.map((s) => s.name).join(", ") || "Show group"}
                {members !== null && ` · ${members} members`}
                {pocTags.length > 0 && ` · POC ${pocTags.map((t) => t.label.slice(1)).join(", ")}`}
                {" · "}
              </span>
              {sync}
            </p>
          </div>
          <IconButton icon={IconClock} label="Scheduled posts" onClick={openSchedule} disabled={!show} />
        </>
      )}
      pinned={
        show && (
          <GroupContext
            group={group}
            show={show}
            groupShows={groupShows}
            onShow={setShowId}
            posts={posts}
            draftPosts={draftPosts}
            onDraft={setDraftPosts}
            open={scheduleOpen}
            onEdit={openSchedule}
            onClose={closeSchedule}
          />
        )
      }
      templates={(pick, trigger) => <SnippetMenu vars={vars} messages={[...GROUP_POST_KEYS]} onPick={pick} trigger={trigger} />}
    />
  );
}

const groupCardKey = (id: string) => `spot.groupCard.${id}`;

/** A group's scheduled posts, pinned under the header: one line when folded ("3 scheduled posts · next Mon 5:00 PM"), the list and actions when open. Remembered per chat. */
function GroupContext({ group, show, groupShows, onShow, posts, draftPosts, onDraft, open, onEdit, onClose }: { group: GroupThreadItem; show: Show; groupShows: Show[]; onShow: (id: string) => void; posts: GroupPost[]; draftPosts: GroupPost[] | null; onDraft: (p: GroupPost[]) => void; open: boolean; onEdit: () => void; onClose: () => void }) {
  const { settings } = useApp();
  const now = useNow(60_000);
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(groupCardKey(group.groupId)) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setExpanded((v) => {
      try {
        localStorage.setItem(groupCardKey(group.groupId), v ? "0" : "1");
      } catch {
        /* private mode: it just won't be remembered */
      }
      return !v;
    });
  const on = posts.filter((p) => p.enabled);
  const today = localNow(new Date(now), settings.timezone).date;
  const next = on.map((p) => nextRun(show, p, today)).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0];
  const nextLabel = next ? `${next.date === today ? "today" : DAY_SHORT[new Date(`${next.date}T12:00:00`).getDay()]} ${formatTime(next.time)}` : "";
  const summary = on.length ? `${on.length} scheduled post${on.length > 1 ? "s" : ""}${nextLabel ? ` · next ${nextLabel}` : ""}` : "Nothing scheduled";
  const id = `group-card-${group.groupId}`;
  return (
    <section aria-label="Scheduled posts" className="mx-3 mt-2 mb-1 flex-none rounded-lg bg-surface-low lg:mx-4 lg:bg-surface-container">
      <button type="button" onClick={toggle} aria-expanded={expanded} aria-controls={id} className="state-layer pressable flex min-h-11 w-full items-center gap-2 rounded-lg px-3.5 text-left">
        <IconClock className={cx("icon size-4 flex-none", on.length ? "text-primary" : "text-on-surface-variant/60")} />
        <span className="min-w-0 flex-1 truncate type-label-l">{summary}</span>
        <IconArrowDown className={cx("icon size-5 flex-none text-on-surface-variant transition-transform duration-200 ease-out", expanded && "rotate-180")} />
      </button>
      <div id={id} inert={!expanded} className={cx("grid transition-[grid-template-rows] duration-[260ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none", expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="min-h-0 overflow-hidden">
          <div className="flex max-h-[46dvh] flex-col gap-2 overflow-y-auto overscroll-contain px-4 pt-0.5 pb-3">
            <div className="flex flex-wrap items-center gap-2">
              {groupShows.length > 1 && <Select value={show.id} onChange={onShow} options={groupShows.map((s) => ({ value: s.id, label: s.name }))} />}
              <Button size="sm" variant="tonal" className="ml-auto" onClick={onEdit}>
                {posts.length ? "Edit" : "Schedule"}
              </Button>
            </div>
            {on.length > 0 && (
              <ul className="flex flex-col gap-0.5 type-body-s text-on-surface-variant">
                {[...on].sort((a, b) => b.daysBefore - a.daysBefore || a.time.localeCompare(b.time)).map((p) => (
                  <li key={p.id} className="truncate">
                    {whenLabel(p.daysBefore)}, {formatTime(p.time)} · {p.template === "custom" ? messageSummary(groupPostMessage(settings, p)) : messageType(p.template).label}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
      <Sheet open={open} onClose={onClose} title={`Scheduled posts · ${show.name}`} footer={<Button onClick={onClose}>Done</Button>}>
        <p className="mb-4 type-body-m text-on-surface-variant">Your server posts these in {group.name} at the times you pick.</p>
        <GroupPostsEditor show={show} posts={draftPosts ?? posts} onChange={onDraft} />
      </Sheet>
    </section>
  );
}

/**
 * One chat, a comic's or a group's: messages read live (the saved copy first), older pages on demand, and the composer.
 * Phones: a full-screen layer (portal) sized to the visible viewport, so the message list is the only scroller, the composer
 * sits at the bottom above the home indicator and rides the keyboard. Desktop: a pane in the two-column page.
 */
function Conversation({
  threadKey,
  load,
  media,
  send: sendMsg,
  sendImage,
  react,
  baseTags,
  memberHints,
  people,
  isGroup,
  onBack,
  onSent,
  header,
  context,
  pinned,
  aboveComposer,
  templates,
  labelFor,
  defaultVenueId,
  voiceAllowed,
  ariaLabel,
  draft,
  onDraftUsed,
}: {
  threadKey: string;
  load: (before?: number) => Promise<GetThreadResult>;
  /** A sticker's or photo's image, read on demand. */
  media: (messageId: string) => Promise<ThreadMediaResult>;
  send: (msg: RichMessage, opts: { voice: boolean; venueId: string | null; tags: MentionTag[] }) => Promise<unknown>;
  sendImage: (photo: OutPhoto) => Promise<unknown>;
  /** An empty emoji takes your reaction back. */
  react: (messageId: string, emoji: string) => Promise<unknown>;
  /** Groups: tags the text may already hold (the POCs a template fills in). */
  baseTags?: MentionTag[];
  /** Groups: members known from the show's cache, used when the chat itself didn't list them. */
  memberHints?: ThreadMember[];
  /** One-to-one chats: who the "@" picker offers (the other person first, then known comics). */
  people?: ThreadMember[];
  isGroup?: boolean;
  onBack: () => void;
  onSent: () => void;
  /** The header's content (avatar, name, actions). `sync` is the "Synced 2 min ago" line to show under the name. */
  header: (sync: string) => ReactNode;
  context?: ReactNode;
  /** A card pinned right under the header: it stays put while the messages scroll. */
  pinned?: ReactNode;
  aboveComposer?: ReactNode;
  templates: (pick: (m: RichMessage) => void, trigger: (toggle: () => void, open: boolean) => ReactNode) => ReactNode;
  /** The label over a run of their messages. */
  labelFor: (m: ThreadMessage) => string;
  defaultVenueId?: string;
  voiceAllowed: boolean;
  ariaLabel: string;
  /** A suggested reply to put in the box (from the AI assist). */
  draft?: RichMessage | null;
  onDraftUsed?: () => void;
}) {
  const { uid, settings, comics } = useApp();
  const [, setParams] = useSearchParams();
  const now = useNow(15_000);
  const tz = settings.timezone;
  // Tapping a tag opens that person's chat when they're in Comics.
  const openMention = (m: { id?: string; token: string; name: string }) => {
    const digits = (m.id ?? m.token).split("@")[0].replace(/\D/g, "");
    const c = comics.find((x) => x.id === m.id || x.chatId === m.id || (digits && ((x.phone ?? "").replace(/\D/g, "") === digits || x.id.split("@")[0] === digits)));
    if (c) setParams({ c: c.id });
    else toast(`${m.name} isn't in your Comics`);
  };
  const wide = useMediaQuery("(min-width: 1024px)");
  const frame = useRef<HTMLDivElement>(null);
  const { keyboard } = useVisualViewportFrame(frame, !wide);
  // Phones: drag in from the left edge to go back; the chat follows your finger and slides away (or springs back).
  const edge = useRef<{ id: number; x0: number; y0: number; t0: number; mode: "idle" | "h" } | null>(null);
  const edgeEnd = (el: HTMLElement, go: boolean) => {
    el.style.transition = "transform 240ms cubic-bezier(0.32, 0.72, 0, 1)";
    el.style.transform = go ? "translateX(100%)" : "translateX(0)";
    if (go) setTimeout(onBack, 200);
    else setTimeout(() => (el.style.transition = el.style.transform = ""), 260);
  };

  // Messages: the saved copy at once, then the newest page read live and refreshed while visible; older pages on demand.
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  const cache = useMemo<LiveCache<GetThreadResult>>(() => ({ read: () => readCached<GetThreadResult>(threadCacheKey(uid, threadKey)), write: (d) => saveThread(uid, threadKey, d) }), [uid, threadKey]);
  const newest = useLive<GetThreadResult>(() => load(), threadKey, true, 30_000, cache);
  const sync = chatSyncView({ lastOkAt: newest.lastOkAt, loading: newest.loading, error: newest.error, now }, newest.data?.at);
  const gate = useSyncGate(sync.ok, () => void newest.refresh(true), newest.data?.at ?? null, now, tz);

  // Messages you've just sent show at once (Sending…, Sent, or Not sent with Retry) and give way to the real ones.
  const [pending, setPending] = useState<Pending[]>([]);
  // Your reaction shows at once too, until WhatsApp's own answer agrees (or 30 s pass).
  const [mineNow, setMineNow] = useState<Record<string, { chips: ReactionChip[]; sent: string; at: number }>>({});
  const [photo, setPhoto] = useState<string | null>(null);

  const firstLoad = useRef(true);
  const older = useRef<{ h: number; top: number } | null>(null);
  useEffect(() => {
    if (!newest.data) return;
    const data = newest.data;
    setMessages((prev) => mergeNewest(prev, data.messages));
    if (firstLoad.current) setHasMore(data.hasMore);
    // A message you sent is shown by the real one once a read that began after the send has come back.
    if (newest.lastOkAt) {
      setPending((x) => x.filter((p) => !(p.state === "sent" && p.sentAt !== undefined && newest.readStartedAt >= p.sentAt)));
      setMineNow((m) => {
        const keep = Object.fromEntries(
          Object.entries(m).filter(([id, v]) => {
            const server = data.messages.find((x) => x.id === id)?.reactions?.find((c) => c.byMe)?.emoji ?? "";
            return server !== v.sent && Date.now() - v.at < 30_000;
          }),
        );
        return Object.keys(keep).length === Object.keys(m).length ? m : keep;
      });
    }
  }, [newest.data, newest.lastOkAt, newest.readStartedAt]);

  const loadOlder = async () => {
    if (!messages.length) return;
    setOlderBusy(true);
    try {
      const r = await load(messages[0].at);
      firstLoad.current = false;
      const el = scroller.current;
      if (el) older.current = { h: el.scrollHeight, top: el.scrollTop };
      setMessages((prev) => [...r.messages.filter((m) => !prev.some((p) => p.id === m.id)), ...prev]);
      setHasMore(r.hasMore);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setOlderBusy(false);
    }
  };

  const voiceReady = voiceAllowed && Boolean(settings.voice?.enabled && settings.voice.profile?.summary);
  const deliver = async (p: Pending) => {
    setPending((x) => x.map((y) => (y.id === p.id ? { ...y, state: "sending", error: undefined } : y)));
    try {
      if (p.out.photo) await sendImage({ mime: p.out.photo.mime, data: p.out.photo.data, dataUrl: p.out.photo.dataUrl, filename: p.out.photo.filename, caption: p.out.msg.body });
      else await sendMsg(p.out.msg, { voice: p.out.voice && p.out.msg.kind === "text", venueId: p.out.venueId, tags: p.out.tags });
      const sentAt = Date.now();
      setPending((x) => x.map((y) => (y.id === p.id ? { ...y, state: "sent", sentAt } : y)));
      void newest.refresh(true);
      onSent();
    } catch (e) {
      setPending((x) => x.map((y) => (y.id === p.id ? { ...y, state: "failed", error: (e as Error).message } : y)));
    }
  };
  // Several items (text, then a poll) go out one after the other, in order.
  const sendAll = (items: Outgoing[]) => {
    const queued = items.map((out, i): Pending => ({ id: `p${Date.now()}-${i}`, out, state: "sending", at: Date.now() + i }));
    setPending((x) => [...x, ...queued]);
    void queued.reduce((chain, p) => chain.then(() => deliver(p)), Promise.resolve());
  };

  const reactTo = (m: ThreadMessage, emoji: string) =>
    gate.guard(
      () => {
        const { chips, sent } = toggleMyReaction(mineNow[m.id]?.chips ?? m.reactions, emoji);
        setMineNow((x) => ({ ...x, [m.id]: { chips, sent, at: Date.now() } }));
        react(m.id, sent)
          .then(() => void newest.refresh(true))
          .catch((e: Error) => {
            setMineNow((x) => Object.fromEntries(Object.entries(x).filter(([id]) => id !== m.id)));
            toast.error(`Couldn't react: ${e.message}`);
          });
      },
      { verb: "react", anyway: "React anyway" },
    );

  // Who the "@" picker offers: the chat's own list, else what the show remembers.
  const members = isGroup ? (newest.data?.members?.length ? newest.data.members : memberHints) : people;

  // Scrolling: open at the newest message; stay at the bottom as messages, pictures or the keyboard change the height, but only if you were already there.
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const toBottom = () => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  useEffect(() => {
    const el = scroller.current;
    const onScroll = () => el && (stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160);
    el?.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => stick.current && toBottom());
    if (inner.current) ro?.observe(inner.current);
    if (el) ro?.observe(el);
    return () => {
      el?.removeEventListener("scroll", onScroll);
      ro?.disconnect();
    };
  }, []);
  const lastKey = messages[messages.length - 1]?.id ?? "";
  useLayoutEffect(() => {
    const el = scroller.current;
    if (older.current && el) {
      // Earlier messages were added above: keep what you were reading where it was.
      el.scrollTop = el.scrollHeight - older.current.h + older.current.top;
      older.current = null;
      return;
    }
    if (stick.current || !lastKey) toBottom();
  }, [lastKey, pending.length, messages.length, keyboard]);

  const rows = useMemo(() => groupByDay(messages, now, tz), [messages, now, tz]);
  const who = (m: ThreadMessage) => (m.fromMe ? "me" : (m.author ?? "them"));

  const body = (
    <div
      ref={frame}
      data-keyboard={keyboard || undefined}
      onPointerDown={(e) => {
        if (wide || e.pointerType === "mouse" || e.clientX > 24) return;
        edge.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: e.timeStamp, mode: "idle" };
      }}
      onPointerMove={(e) => {
        const d = edge.current;
        if (!d || e.pointerId !== d.id) return;
        const dx = e.clientX - d.x0;
        if (d.mode === "idle") {
          if (Math.abs(e.clientY - d.y0) > 10 && Math.abs(e.clientY - d.y0) > dx) return void (edge.current = null);
          if (dx < 10) return;
          d.mode = "h";
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }
        const el = e.currentTarget as HTMLElement;
        el.style.transition = "none";
        el.style.transform = `translateX(${Math.max(0, dx - 10)}px)`;
      }}
      onPointerUp={(e) => {
        const d = edge.current;
        edge.current = null;
        if (!d || d.mode !== "h" || e.pointerId !== d.id) return;
        const dx = e.clientX - d.x0;
        edgeEnd(e.currentTarget as HTMLElement, dx > window.innerWidth * 0.33 || dx / Math.max(1, e.timeStamp - d.t0) > 0.6);
      }}
      onPointerCancel={(e) => {
        if (edge.current?.mode === "h") edgeEnd(e.currentTarget as HTMLElement, false);
        edge.current = null;
      }}
      className={cx(
        "flex flex-col bg-surface",
        wide ? "min-h-0 flex-1 overflow-hidden rounded-lg border border-outline-variant" : "fixed inset-x-0 top-0 z-50 h-dvh touch-pan-y pt-[env(safe-area-inset-top)] sm:left-24",
      )}
    >
      {/* The frame ends at the visual viewport, above iOS's translucent accessory bar and keyboard: keep its own surface under them. */}
      {!wide && <div aria-hidden className="pointer-events-none absolute inset-x-0 top-full h-screen bg-surface" />}
      <header className="flex flex-none items-center gap-1 border-b border-outline-variant bg-surface px-1.5 py-1.5 lg:gap-2 lg:bg-surface-low lg:px-3 lg:py-2">
        <button type="button" onClick={onBack} aria-label="Back to chats" className="state-layer pressable inline-flex size-11 flex-none items-center justify-center rounded-full text-primary lg:hidden">
          <IconArrowLeft className="icon size-7" />
        </button>
        {header(sync.label)}
        <IconButton icon={IconRefresh} label={newest.loading ? "Syncing this chat" : "Sync this chat"} onClick={() => void newest.refresh(true)} disabled={newest.loading} className={cx(newest.loading && "[&_svg]:animate-spin")} />
      </header>
      {pinned}
      {!sync.ok && !sync.syncing && newest.data && <SyncBanner savedAt={newest.data.at} now={now} tz={tz} onRetry={() => void newest.refresh(true)} />}

      <div ref={scroller} className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-3 [-webkit-overflow-scrolling:touch] lg:bg-surface-lowest lg:px-4">
        <div ref={inner}>
          {context}

          {hasMore && (
            <div className="flex justify-center py-2">
              <Button size="sm" variant="text" loading={olderBusy} icon={IconArrowDown} onClick={() => void loadOlder()}>
                Load earlier
              </Button>
            </div>
          )}
          {newest.loading && !messages.length ? (
            <div className="h-40" aria-busy="true" />
          ) : newest.error && !messages.length ? (
            <ErrorNote message={newest.error} onRetry={() => void newest.refresh(true)} />
          ) : !messages.length && !pending.length ? (
            <p className="py-12 text-center type-body-m text-on-surface-variant">No messages yet. Say hello below.</p>
          ) : (
            <ol className="flex flex-col gap-1 pt-2 pb-3" aria-label={ariaLabel}>
              {rows.map((r, i) => {
                if (r.row === "day") {
                  return (
                    <li key={r.key} className="my-2 flex justify-center">
                      <span className="rounded-full bg-surface-high px-3 py-1 type-label-s text-on-surface-variant">{r.label}</span>
                    </li>
                  );
                }
                const prev = rows[i - 1];
                const firstOfRun = !prev || prev.row === "day" || who(prev.m) !== who(r.m);
                return (
                  <li key={r.m.id}>
                    <Bubble
                      m={r.m}
                      label={firstOfRun ? (r.m.fromMe ? "You" : labelFor(r.m)) : undefined}
                      tz={tz}
                      media={media}
                      reactions={mineNow[r.m.id]?.chips}
                      onReact={r.m.kind === "deleted" ? undefined : (e) => reactTo(r.m, e)}
                      reactor={isGroup ? undefined : labelFor(r.m)}
                      onOpenPhoto={setPhoto}
                      onOpenMention={openMention}
                    />
                  </li>
                );
              })}
              {pending.map((p) => (
                <li key={p.id}>
                  <PendingBubble
                    p={{ id: p.id, state: p.state, error: p.error, body: <PendingBody out={p.out} /> }}
                    onRetry={() => gate.guard(() => void deliver(p), { verb: "send", anyway: "Send anyway" })}
                    onDiscard={() => setPending((x) => x.filter((y) => y.id !== p.id))}
                  />
                </li>
              ))}
            </ol>
          )}
          {newest.error && messages.length > 0 && <p role="status" className="pb-2 text-center type-body-s text-error">Couldn't sync: {newest.error}</p>}
        </div>
      </div>

      <div
        className="flex flex-none flex-col gap-2 border-t border-outline-variant bg-surface px-3 pt-2 lg:bg-surface-low"
        style={{ paddingBottom: keyboard || wide ? 8 : "calc(0.5rem + env(safe-area-inset-bottom))" }}
      >
        {aboveComposer}
        <ChatComposer
          key={threadKey}
          idPrefix={`chat-${threadKey}`}
          onSend={sendAll}
          guard={(run) => gate.guard(run, { verb: "send", anyway: "Send anyway" })}
          templates={templates}
          voiceReady={voiceReady}
          defaultVenueId={defaultVenueId}
          members={members}
          baseTags={baseTags}
          draft={draft}
          onDraftUsed={onDraftUsed}
        />
      </div>
      {gate.dialog}
      {photo && <PhotoViewer src={photo} onClose={() => setPhoto(null)} />}
    </div>
  );
  return wide ? body : createPortal(body, document.body);
}

function PendingBody({ out }: { out: Outgoing }) {
  const m = out.msg;
  if (out.photo) {
    return (
      <div className="flex flex-col gap-1.5">
        <img src={out.photo.dataUrl} alt="Photo being sent" className="max-h-64 w-full max-w-[16rem] rounded-md object-cover" />
        {m.body && <WaText text={m.body} />}
      </div>
    );
  }
  return m.kind === "poll" && m.poll ? <PollCard poll={m.poll} /> : m.kind === "location" ? <PinCard name="Venue pin" detail="Map pin" /> : <WaText text={m.body} />;
}

// ---------- Linked context ----------

const STATUS_LABEL: Record<SpotRequest["status"], string> = {
  new: "Waiting for your answer",
  acked: "Acknowledged, waiting for your answer",
  assigned: "Placed on a show",
  confirmed: "Confirmed",
  dismissed: "Closed",
  rejected: "Regret sent",
};

const STATUS_SHORT: Record<SpotRequest["status"], string> = { new: "Waiting", acked: "Acknowledged", assigned: "Placed", confirmed: "Confirmed", dismissed: "Closed", rejected: "Regret sent" };
const cardKey = (id: string) => `spot.threadCard.${id}`;

/** The comic's request and the week's actions, pinned under the header: one line when folded, the details and buttons when open. Remembered per chat. */
function ThreadContext({ comic, request: r, lineups, placedShow }: { comic: ReturnType<typeof useApp>["comics"][number]; request?: SpotRequest; lineups: Lineup[]; placedShow?: Show }) {
  const { uid, week, currentWeek, shows, venues, settings } = useApp();
  const now = useNow(60_000);
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(cardKey(comic.id)) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setExpanded((v) => {
      try {
        localStorage.setItem(cardKey(comic.id), v ? "0" : "1");
      } catch {
        /* private mode: it just won't be remembered */
      }
      return !v;
    });
  const today = localNow(new Date(now), settings.timezone).date;
  const prev = lastSpot(comic.history, today);
  const active = shows.filter((s) => s.active);
  const open = Boolean(r && OPEN.includes(r.status));
  const preferred = new Set(r?.intent.preferredDays ?? []);
  const manyVenues = new Set(active.map((s) => s.venueId)).size > 1;
  const pills = r ? requestPills({ r, comic, shows, today, venueName: manyVenues ? venues.find((v) => v.id === r.intent.venueId)?.name : undefined }) : [];
  const days = r?.intent.preferredDays ?? [];
  const asked = !r ? "No request" : days.length === 1 ? `Asked for ${DAY_NAMES[days[0]]}` : days.length ? `Asked for ${days.map((d) => DAY_SHORT[d]).join(", ")}` : "Asked for any day";
  const summary = r ? `${asked} · ${STATUS_SHORT[r.status]}` : asked;

  const place = async (show: Show) => {
    try {
      if (!(await placeComic(uid, week, show, comic.id, lineups, shows))) return;
      toast.success(`${comic.name.split(/\s+/)[0]} → ${show.name}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const closeRequest = async () => {
    if (!r) return;
    await updateDoc(userDoc(uid, "requests", r.id), { status: "dismissed", clearedAt: null, updatedAt: Date.now() });
    toast.success(`${comic.name.split(/\s+/)[0]}'s request is closed`, { action: { label: "Undo", onClick: () => void updateDoc(userDoc(uid, "requests", r.id), { status: r.status, updatedAt: Date.now() }) } });
  };

  return (
    <section aria-label="This week" className="mx-3 mt-2 mb-1 flex-none rounded-lg bg-surface-low lg:mx-4 lg:bg-surface-container">
      <button type="button" onClick={toggle} aria-expanded={expanded} aria-controls={`card-${comic.id}`} className="state-layer pressable flex min-h-11 w-full items-center gap-2 rounded-lg px-3.5 text-left">
        <span className={cx("size-2 flex-none rounded-full", open ? "bg-primary" : "bg-on-surface-variant/50")} aria-hidden />
        <span className="min-w-0 flex-1 truncate type-label-l">
          {summary}
        </span>
        <IconArrowDown className={cx("icon size-5 flex-none text-on-surface-variant transition-transform duration-200 ease-out", expanded && "rotate-180")} />
      </button>
      <div id={`card-${comic.id}`} inert={!expanded} className={cx("grid transition-[grid-template-rows] duration-[260ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none", expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="min-h-0 overflow-hidden">
          <div className="flex max-h-[46dvh] flex-col gap-2.5 overflow-y-auto overscroll-contain px-4 pt-0.5 pb-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 type-label-m text-on-surface-variant">{week === currentWeek ? "This week" : `Week of ${formatDate(week)}`}</span>
              {r ? (
                <>
                  <Chip tone={open ? "primary" : "neutral"}>{STATUS_LABEL[r.status]}</Chip>
                  {r.intent.preferredDays.length ? r.intent.preferredDays.map((d) => <Chip key={d}>{DAY_SHORT[d]}</Chip>) : open ? <Chip>Any day</Chip> : null}
                </>
              ) : (
                <Chip>No request</Chip>
              )}
              {placedShow && (
                <Chip tone="success" icon={IconMic}>
                  {placedShow.name} · {DAY_SHORT[placedShow.weekday]} {formatTime(placedShow.startTime)}
                </Chip>
              )}
            </div>
            {r && (r.intent.note || r.messages.length > 0) && <p className="type-body-m text-on-surface-variant">{r.intent.note || `“${r.messages[r.messages.length - 1].body}”`}</p>}
            {pills.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                <RequestPills pills={pills} />
              </div>
            )}
            <p className="type-body-s text-on-surface-variant">{prev ? `Last spot ${daysBetween(prev.date, today)} days ago (${prev.showName}).` : "No spots on record yet."}</p>
            <div className="flex flex-wrap items-center gap-2">
              {!placedShow && (
                <Menu
                  trigger={(toggleMenu) => (
                    <Button size="sm" variant="tonal" icon={IconMic} onClick={toggleMenu} disabled={!active.length}>
                      Place on a show
                    </Button>
                  )}
                >
                  {(close) =>
                    [...active]
                      .sort((a, b) => Number(preferred.has(b.weekday)) - Number(preferred.has(a.weekday)))
                      .map((s) => {
                        const l = lineups.find((x) => x.showId === s.id);
                        return (
                          <MenuItem key={s.id} highlighted={preferred.has(s.weekday)} hint={`${l?.slots.length ?? 0}/${s.slotCount}`} disabled={l?.status === "confirmed"} onClick={() => (close(), void place(s))}>
                            {s.name}
                            <span className="block type-body-s text-on-surface-variant">
                              {DAY_SHORT[s.weekday]} · {formatTime(s.startTime)}
                            </span>
                          </MenuItem>
                        );
                      })
                  }
                </Menu>
              )}
              {open && (
                <Button size="sm" variant="text" icon={IconSkip} onClick={() => void closeRequest()}>
                  Close request
                </Button>
              )}
              <Link to={`/requests?q=${encodeURIComponent(comic.name)}`} className="state-layer ml-auto inline-flex h-9 items-center gap-1 rounded-full px-3 type-label-l text-primary">
                Open in Requests <IconArrowRight className="icon size-4" />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------- AI assist ----------
// The result is kept in a tiny store keyed by chat, so the header button starts it and the card above the composer shows it.

type Assist = { state: "idle" } | { state: "loading"; stage?: string } | { state: "error"; message: string } | { state: "done"; result: SummarizeThreadResult; dismissed: boolean };
const assistStore = new Map<string, Assist>();
const assistSubs = new Set<() => void>();
const setAssist = (id: string, a: Assist) => {
  assistStore.set(id, a);
  assistSubs.forEach((f) => f());
};
function useAssist(id: string) {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    assistSubs.add(f);
    return () => void assistSubs.delete(f);
  }, []);
  // Leaving the chat (or the page) forgets the result: it is a reading of text that isn't kept anywhere.
  useEffect(() => () => void assistStore.delete(id), [id]);
  return assistStore.get(id) ?? ({ state: "idle" } as Assist);
}

function AssistButton({ source, comic }: { source: ChatSource; comic: { id: string } }) {
  const { week } = useApp();
  const a = useAssist(comic.id);
  const run = async () => {
    setAssist(comic.id, { state: "loading" });
    try {
      setAssist(comic.id, { state: "done", result: await source.summarize(comic.id, week, (stage) => setAssist(comic.id, { state: "loading", stage })), dismissed: false });
    } catch (e) {
      setAssist(comic.id, { state: "error", message: (e as Error).message });
    }
  };
  return <IconButton icon={a.state === "loading" ? IconRefresh : IconSparkle} label={a.state === "loading" ? "Reading the chat…" : "Summarise this chat"} onClick={() => void run()} disabled={a.state === "loading"} className={cx(a.state === "loading" && "[&_svg]:animate-spin")} />;
}

function AssistCard({ source: _source, comic, request, lineups, onUseReply, week }: { source: ChatSource; comic: { id: string; name: string }; request?: SpotRequest; lineups: Lineup[]; onUseReply: (t: string) => void; week: string }) {
  const a = useAssist(comic.id);
  if (a.state === "idle" || a.state === "loading" || (a.state === "done" && a.dismissed)) {
    return a.state === "loading" ? (
      <p role="status" className="flex items-center gap-2 rounded-lg bg-surface-container px-3 py-2.5 type-body-m text-on-surface-variant">
        <Spinner className="size-4" /> {a.state === "loading" && a.stage ? a.stage : "Reading the chat…"}
      </p>
    ) : null;
  }
  const dismiss = () => setAssist(comic.id, a.state === "done" ? { ...a, dismissed: true } : { state: "idle" });
  if (a.state === "error") {
    return (
      <div role="alert" className="flex items-start gap-2 rounded-lg bg-error-container px-3 py-2.5 text-on-error-container">
        <p className="min-w-0 flex-1 type-body-m">{a.message}</p>
        <IconButton icon={IconClose} label="Dismiss" onClick={dismiss} className="-m-1 size-8" />
      </div>
    );
  }
  const r = a.result;
  return (
    <section aria-label="Suggestions" className="flex max-h-[32dvh] flex-col gap-2.5 overflow-y-auto rounded-lg bg-surface-high px-3.5 py-3 text-on-surface">
      <div className="flex items-start gap-2">
        <IconSparkle className="icon mt-0.5 size-5 flex-none text-primary" />
        <div className="min-w-0 flex-1">
          <p className="type-body-m">{r.summary}</p>
          <p className="mt-0.5 type-body-s opacity-75">Suggested by {r.model}. Nothing is sent or changed until you choose.</p>
        </div>
        <IconButton icon={IconClose} label="Dismiss suggestions" onClick={dismiss} className="-m-1 size-8" />
      </div>
      {r.suggestedReply && (
        <div className="rounded-md bg-surface px-3 py-2">
          <p className="type-label-s opacity-75">Suggested reply</p>
          <p className="mt-0.5 type-body-m whitespace-pre-wrap">{r.suggestedReply}</p>
          <Button size="sm" variant="tonal" className="mt-1.5" onClick={() => onUseReply(r.suggestedReply)}>
            Use as my draft
          </Button>
        </div>
      )}
      {r.actions.map((act, i) => (
        <ActionRow key={i} act={act} comic={comic} request={request} lineups={lineups} week={week} />
      ))}
      {!r.actions.length && <p className="type-body-s opacity-75">No change to your lineup looks needed.</p>}
    </section>
  );
}

function ActionRow({ act, comic, request, lineups, week }: { act: ThreadAction; comic: { id: string; name: string }; request?: SpotRequest; lineups: Lineup[]; week: string }) {
  const { uid, shows } = useApp();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const show = shows.find((s) => s.id === act.showId);
  const open = Boolean(request && OPEN.includes(request.status));
  const onShow = Boolean(show && lineups.some((l) => l.showId === show.id && l.slots.some((s) => s.comicId === comic.id)));
  const place = act.kind === "place";
  const blocked = place ? !show || onShow : !open;
  const label = place ? `Place on ${show?.name ?? "a show"}${act.told ? " (already told)" : ""}` : "Close their request";
  const why = place ? (!show ? "That show isn't active this week." : onShow ? "Already on this show." : "") : !open ? "No open request to close." : "";
  const apply = async () => {
    setBusy(true);
    try {
      if (place && show) {
        const placed = act.told ? await placeAsTold(uid, week, show, comic.id, lineups, comic.name) : await placeComic(uid, week, show, comic.id, lineups, shows);
        if (!placed) return;
        toast.success(`${comic.name.split(/\s+/)[0]} → ${show.name}`);
      } else if (request) {
        await updateDoc(userDoc(uid, "requests", request.id), { status: "dismissed", updatedAt: Date.now() });
        toast.success("Request closed");
      }
      setDone(true);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-md bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 type-label-l">{label}</p>
        {done ? (
          <Chip tone="success" icon={IconCheck}>Done</Chip>
        ) : (
          <Button size="sm" variant="tonal" loading={busy} disabled={blocked} onClick={() => void apply()}>
            {place ? "Place" : "Close"}
          </Button>
        )}
      </div>
      <p className="mt-1 type-body-s opacity-80">You can check it: “{act.evidence}”{why && ` · ${why}`}</p>
    </div>
  );
}
