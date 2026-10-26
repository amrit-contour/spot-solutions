// Messages: chat with the comics on your list without leaving the app. Chats are read live from your own WhatsApp
// (through your server) when you open the page, and are never saved: the command results that carry them are deleted as soon
// as they are read (docs/architecture.md "Messages"). Only people in Comics are listed.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  nextShowDate,
  whenLabel,
  hasPin,
  lastSpot,
  localNow,
  pollProblem,
  type GetThreadResult,
  type GroupPost,
  type GroupThreadItem,
  type Lineup,
  type ListThreadsResult,
  type RichMessage,
  type Show,
  type SpotRequest,
  type SummarizeThreadResult,
  type ThreadAction,
  type ThreadItem,
  type ThreadMessage,
} from "@spot/shared";
import { useApp } from "../lib/app";
import { timeAgo, useCollection, useNow, userDoc } from "../lib/data";
import { isDemoUser } from "../lib/demo";
import { demoSource, liveSource, type ChatSource } from "../lib/messages";
import { placeAsTold, placeComic } from "../lib/lineup";
import { PageHeader } from "../components/Shell";
import { Menu, MenuItem } from "../components/Menu";
import { COMIC_MESSAGE_KEYS, SnippetMenu } from "../components/SnippetMenu";
import { GroupPostsEditor } from "../components/GroupPosts";
import { RequestPills, requestPills } from "../components/RequestTags";
import { MessageComposer, messageSummary, withKind } from "../components/rich/MessageComposer";
import { PinCard, PollCard, WaText } from "../components/rich/WaText";
import { Avatar, Button, Chip, Empty, IconButton, Segmented, Select, Sheet, Spinner, Switch, cx } from "../components/ui";
import { IconArrowDown, IconArrowLeft, IconArrowRight, IconChat, IconCheck, IconClock, IconClose, IconGroup, IconMic, IconRefresh, IconSearch, IconSend, IconServer, IconSkip, IconSparkle } from "../components/icons";

const emptyText = (): RichMessage => ({ kind: "text", body: "" });
const OPEN = ["new", "acked"];

/** Data that loads on demand and refreshes while the tab is visible. A result never outlives its key (the open chat). */
function useLive<T>(load: () => Promise<T>, key: string, enabled: boolean, everyMs: number) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: enabled });
  const loadRef = useRef(load);
  loadRef.current = load;
  const keyRef = useRef(key);
  keyRef.current = key;
  const inFlight = useRef<string | null>(null);
  const lastAt = useRef(0);
  const refresh = useCallback(async () => {
    const k = keyRef.current;
    if (inFlight.current === k) return;
    inFlight.current = k;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await loadRef.current();
      if (k === keyRef.current) {
        lastAt.current = Date.now();
        setState({ data, error: null, loading: false });
      }
    } catch (e) {
      if (k === keyRef.current) setState((s) => ({ ...s, error: (e as Error).message, loading: false }));
    } finally {
      if (inFlight.current === k) inFlight.current = null;
    }
  }, []);
  useEffect(() => {
    setState({ data: null, error: null, loading: enabled });
    if (!enabled) return;
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
  const { uid, week, session, workerOnline, comics, comicsById, shows, settings } = useApp();
  const demo = isDemoUser();
  const requests = useCollection<SpotRequest>(uid, "requests", [where("weekOf", "==", week)], week);
  const lineups = useCollection<Lineup>(uid, "lineups", [where("weekOf", "==", week)], week);
  const [params, setParams] = useSearchParams();
  const selected = params.get("c");
  const selectedGroup = params.get("g");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "needs" | "groups">(() => (selectedGroup ? "groups" : "all"));
  const needsReply = filter === "needs";
  const now = useNow(30_000);

  const demoData = useRef({ comics, requests: requests.data, lineups: lineups.data, shows, now });
  demoData.current = { comics, requests: requests.data, lineups: lineups.data, shows, now };
  const source = useMemo<ChatSource>(() => (demo ? demoSource(() => demoData.current) : liveSource(uid)), [demo, uid]);

  const ready = demo || (workerOnline && session?.status === "ready");
  // The demo's conversations come from the sandbox's requests, so they load with the requests.
  const list = useLive<ListThreadsResult>(() => source.list(), `${uid}:${demo}:${demo ? `${requests.data.length}:${comics.length}:${lineups.data.length}` : ""}`, ready && (!demo || !requests.loading), 60_000);
  const threads = useMemo(() => list.data?.threads ?? [], [list.data]);
  const shown = useMemo(() => filterThreads(threads, q).filter((t) => !needsReply || t.awaitingYou), [threads, q, needsReply]);
  const waiting = threads.filter((t) => t.awaitingYou).length;
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

  return (
    <div className="w-full">
      {/* On phones an open chat takes the whole screen, so the page title steps aside. `contents` keeps the header sticky. */}
      <div className={anyOpen ? "hidden lg:contents" : "contents"}>
        <PageHeader
          title="Messages"
          subtitle="Chats with the comics on your list and your show groups. Read live from your WhatsApp, never saved."
          actions={ready && <IconButton icon={IconRefresh} label="Refresh chats" onClick={() => void list.refresh()} disabled={list.loading} className={cx("size-9", list.loading && "[&_svg]:animate-spin")} />}
        />
      </div>

      <div className="px-4 pb-6 sm:px-8 lg:grid lg:h-[calc(100dvh-var(--page-header-h,0px)-1.5rem)] lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)] lg:gap-6">
        <section aria-label="Chats" className={cx("min-h-0 flex-col lg:flex", anyOpen ? "hidden" : "flex")}>
          {!ready ? (
            <Unavailable offline={!workerOnline} />
          ) : (
            <>
              {demo && <p className="mb-3 rounded-lg bg-tertiary-container px-4 py-3 type-body-s text-on-tertiary-container">Sample chats built from the demo's requests. A real account shows your WhatsApp conversations here.</p>}
              <div className="sticky top-[calc(env(safe-area-inset-top)+var(--page-header-h,0px))] z-20 -mx-4 flex flex-col gap-2 bg-surface/95 px-4 pt-2 pb-2 backdrop-blur sm:-mx-8 sm:px-8 lg:static lg:mx-0 lg:px-0">
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
                      <ThreadRow key={t.comicId} t={t} active={t.comicId === selected} now={now} tz={tz} onOpen={() => open(t.comicId)} />
                    ))}
                  </ul>
                )}
                {list.data && !demo && <p className="px-2 pt-3 pb-1 type-body-s text-on-surface-variant">Updated {timeAgo(list.data.at, now)}. Unread counts come from WhatsApp; opening a chat here doesn't mark it read.</p>}
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
    </div>
  );
}

function Unavailable({ offline }: { offline: boolean }) {
  return offline ? (
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
        <span className="grid size-11 flex-none place-items-center rounded-full bg-tertiary-container text-on-tertiary-container">
          <IconGroup className="icon size-5" />
        </span>
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

function ThreadRow({ t, active, now, tz, onOpen }: { t: ThreadItem; active: boolean; now: number; tz: string; onOpen: () => void }) {
  return (
    <li>
      <button
        onClick={onOpen}
        aria-current={active ? "true" : undefined}
        className={cx("state-layer flex min-h-[4.5rem] w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left", active && "bg-secondary-container")}
      >
        <Avatar name={t.name} size={44} tone={t.awaitingYou ? "primary" : "secondary"} />
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
    </li>
  );
}

// ---------- One conversation ----------

interface Pending {
  id: string;
  msg: RichMessage;
  state: "sending" | "failed";
  at: number;
  error?: string;
}

function mergeNewest(prev: ThreadMessage[], page: ThreadMessage[]) {
  if (!page.length) return prev;
  return [...prev.filter((m) => m.at < page[0].at && !page.some((p) => p.id === m.id)), ...page];
}

type ComicOf = NonNullable<ReturnType<typeof useApp>["comicsById"] extends Map<string, infer C> ? C : never>;

function ThreadView({ source, comic, request, lineups, onBack, onChanged }: { source: ChatSource; comic: ComicOf; request?: SpotRequest; lineups: Lineup[]; onBack: () => void; onChanged: () => void }) {
  const { week, shows, venues, settings } = useApp();
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
      send={(msg, opts) => source.send({ id: comic.id, chatId: comic.chatId, name: comic.name }, msg, opts)}
      onBack={onBack}
      onSent={onChanged}
      ariaLabel={`Chat with ${comic.name}`}
      labelFor={() => first}
      defaultVenueId={defaultVenue}
      voiceAllowed
      draft={draft}
      onDraftUsed={() => setDraft(null)}
      header={
        <>
          <Avatar name={comic.name} size={40} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate type-title-m">{comic.name}</h2>
            {comic.phone && <p className="truncate type-body-s text-on-surface-variant tabular">+{comic.phone}</p>}
          </div>
          <AssistButton source={source} comic={comic} />
        </>
      }
      context={<ThreadContext comic={comic} request={request} lineups={lineups} placedShow={placedShow} />}
      aboveComposer={<AssistCard source={source} comic={comic} request={request} lineups={lineups} onUseReply={(t) => setDraft({ kind: "text", body: t })} week={week} />}
      templates={(pick) => <SnippetMenu name={comic.name} vars={vars} builtins={["confirm", "ack", "reject", "cancelSpot"]} messages={COMIC_MESSAGE_KEYS} onPick={pick} />}
    />
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
  const live = posts.filter((p) => p.enabled).length;
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
      send={(msg, opts) => source.send({ id: group.groupId, chatId: group.groupId, name: "everyone", tags: pocTags }, msg, opts)}
      onBack={onBack}
      onSent={onChanged}
      ariaLabel={`${group.name} group`}
      labelFor={(m) => m.author ?? "Someone"}
      defaultVenueId={show?.venueId}
      voiceAllowed
      header={
        <>
          <span className="grid size-10 flex-none place-items-center rounded-full bg-tertiary-container text-on-tertiary-container">
            <IconGroup className="icon size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate type-title-m">{group.name}</h2>
            <p className="truncate type-body-s text-on-surface-variant">
              {groupShows.map((s) => s.name).join(", ") || "Show group"}
              {members !== null && ` · ${members} members`}
              {pocTags.length > 0 && ` · POC ${pocTags.map((t) => t.label.slice(1)).join(", ")}`}
            </p>
          </div>
          <IconButton icon={IconClock} label="Scheduled posts" onClick={openSchedule} disabled={!show} />
        </>
      }
      context={
        show && (
          <section aria-label="Scheduled posts" className="my-3 rounded-lg bg-surface-low px-4 py-3 lg:bg-surface-container">
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-1 type-label-m text-on-surface-variant">Scheduled</span>
              <Chip icon={IconClock}>{live ? `${live} post${live > 1 ? "s" : ""} on` : "Nothing scheduled"}</Chip>
              {groupShows.length > 1 && <Select value={show.id} onChange={setShowId} options={groupShows.map((s) => ({ value: s.id, label: s.name }))} />}
              <Button size="sm" variant="text" className="ml-auto" onClick={openSchedule}>
                {posts.length ? "Edit" : "Schedule"}
              </Button>
            </div>
            {posts.filter((p) => p.enabled).length > 0 && (
              <ul className="mt-2 flex flex-col gap-0.5 type-body-s text-on-surface-variant">
                {[...posts].filter((p) => p.enabled).sort((a, b) => b.daysBefore - a.daysBefore || a.time.localeCompare(b.time)).map((p) => (
                  <li key={p.id} className="truncate">
                    {whenLabel(p.daysBefore)}, {formatTime(p.time)} · {p.template === "custom" ? messageSummary(groupPostMessage(settings, p)) : messageType(p.template).label}
                  </li>
                ))}
              </ul>
            )}
            <Sheet open={scheduleOpen} onClose={closeSchedule} title={`Scheduled posts · ${show.name}`} footer={<Button onClick={closeSchedule}>Done</Button>}>
              <p className="mb-4 type-body-m text-on-surface-variant">Your server posts these in {group.name} at the times you pick.</p>
              <GroupPostsEditor show={show} posts={draftPosts ?? posts} onChange={setDraftPosts} />
            </Sheet>
          </section>
        )
      }
      templates={(pick) => <SnippetMenu vars={vars} messages={[...GROUP_POST_KEYS]} onPick={pick} />}
    />
  );
}

/** One chat, a comic's or a group's: messages read live, older pages on demand, and the composer. */
function Conversation({
  threadKey,
  load,
  send: sendMsg,
  onBack,
  onSent,
  header,
  context,
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
  send: (msg: RichMessage, opts: { voice: boolean; venueId: string | null }) => Promise<unknown>;
  onBack: () => void;
  onSent: () => void;
  header: ReactNode;
  context?: ReactNode;
  aboveComposer?: ReactNode;
  templates: (pick: (m: RichMessage) => void) => ReactNode;
  /** The label over a run of their messages. */
  labelFor: (m: ThreadMessage) => string;
  defaultVenueId?: string;
  voiceAllowed: boolean;
  ariaLabel: string;
  /** A suggested reply to put in the box (from the AI assist). */
  draft?: RichMessage | null;
  onDraftUsed?: () => void;
}) {
  const { venues, settings } = useApp();
  const now = useNow(30_000);
  const tz = settings.timezone;

  // Messages: the newest page, refreshed while visible, with older pages added on demand.
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  const newest = useLive<GetThreadResult>(() => load(), threadKey, true, 30_000);
  const firstLoad = useRef(true);
  useEffect(() => {
    if (!newest.data) return;
    setMessages((prev) => mergeNewest(prev, newest.data!.messages));
    if (firstLoad.current) setHasMore(newest.data.hasMore);
  }, [newest.data]);
  const loadOlder = async () => {
    if (!messages.length) return;
    setOlderBusy(true);
    try {
      const r = await load(messages[0].at);
      firstLoad.current = false;
      setMessages((prev) => [...r.messages.filter((m) => !prev.some((p) => p.id === m.id)), ...prev]);
      setHasMore(r.hasMore);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setOlderBusy(false);
    }
  };

  // Messages you've just sent show at once, then give way to the real ones.
  const [pending, setPending] = useState<Pending[]>([]);
  const [msg, setMsg] = useState<RichMessage>(emptyText);
  useEffect(() => {
    if (!draft) return;
    setMsg(draft);
    onDraftUsed?.();
  }, [draft, onDraftUsed]);
  const [voice, setVoice] = useState(false);
  const pinVenues = venues.filter((v) => hasPin(v));
  const [venueId, setVenueId] = useState<string>(() => (defaultVenueId && hasPin(venues.find((v) => v.id === defaultVenueId)) ? defaultVenueId : (pinVenues[0]?.id ?? "")));
  const venue = venues.find((v) => v.id === venueId);
  const voiceReady = voiceAllowed && Boolean(settings.voice?.enabled && settings.voice.profile?.summary);
  const ready = msg.kind === "poll" ? !pollProblem(msg.poll) : msg.kind === "location" ? hasPin(venue) : Boolean(msg.body.trim());

  const deliver = async (p: Pending) => {
    setPending((x) => x.map((y) => (y.id === p.id ? { ...y, state: "sending", error: undefined } : y)));
    try {
      await sendMsg(p.msg, { voice: voice && p.msg.kind === "text", venueId: p.msg.kind === "location" || p.msg.attachLocation ? venueId : null });
      await newest.refresh();
      setPending((x) => x.filter((y) => y.id !== p.id));
      onSent();
    } catch (e) {
      setPending((x) => x.map((y) => (y.id === p.id ? { ...y, state: "failed", error: (e as Error).message } : y)));
    }
  };
  const send = () => {
    if (!ready) return;
    const p: Pending = { id: `p${Date.now()}`, msg, state: "sending", at: Date.now() };
    setPending((x) => [...x, p]);
    setMsg(emptyText());
    void deliver(p);
  };

  // Scrolling: open at the newest message; stay at the bottom when new ones arrive only if you were already there.
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const bottomGap = () => {
    const el = scroller.current;
    const desktop = window.matchMedia("(min-width: 1024px)").matches;
    return desktop && el ? el.scrollHeight - el.scrollTop - el.clientHeight : document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
  };
  useEffect(() => {
    const onScroll = () => (stick.current = bottomGap() < 160);
    const el = scroller.current;
    el?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el?.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);
  const lastKey = messages[messages.length - 1]?.id ?? "";
  useLayoutEffect(() => {
    if (!stick.current && lastKey) return;
    const el = scroller.current;
    if (window.matchMedia("(min-width: 1024px)").matches && el) el.scrollTop = el.scrollHeight;
    else window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [lastKey, pending.length]);

  const rows = useMemo(() => groupByDay(messages, now, tz), [messages, now, tz]);
  const who = (m: ThreadMessage) => (m.fromMe ? "me" : (m.author ?? "them"));

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:overflow-hidden lg:rounded-lg lg:border lg:border-outline-variant">
      <header className="sticky top-[env(safe-area-inset-top)] z-30 -mx-4 flex flex-none items-center gap-2 border-b border-outline-variant bg-surface/95 px-2 py-2 backdrop-blur sm:-mx-8 sm:px-6 lg:static lg:mx-0 lg:bg-surface-low lg:px-3">
        <IconButton icon={IconArrowLeft} label="Back to chats" onClick={onBack} className="lg:hidden" />
        {header}
        <IconButton icon={IconRefresh} label="Refresh this chat" onClick={() => void newest.refresh()} disabled={newest.loading} className={cx(newest.loading && "[&_svg]:animate-spin")} />
      </header>

      <div ref={scroller} className="min-h-0 flex-1 lg:overflow-y-auto lg:overscroll-contain lg:bg-surface-lowest lg:px-4">
        {context}

        {hasMore && (
          <div className="flex justify-center py-2">
            <Button size="sm" variant="text" loading={olderBusy} icon={IconArrowDown} onClick={() => void loadOlder()}>
              Load earlier
            </Button>
          </div>
        )}
        {newest.loading && !messages.length ? (
          <div className="grid place-items-center py-16 text-primary"><Spinner className="size-7" /></div>
        ) : newest.error && !messages.length ? (
          <ErrorNote message={newest.error} onRetry={() => void newest.refresh()} />
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
                  <Bubble m={r.m} label={firstOfRun ? (r.m.fromMe ? "You" : labelFor(r.m)) : undefined} tz={tz} />
                </li>
              );
            })}
            {pending.map((p) => (
              <li key={p.id}>
                <PendingBubble p={p} onRetry={() => void deliver(p)} onDiscard={() => setPending((x) => x.filter((y) => y.id !== p.id))} />
              </li>
            ))}
          </ol>
        )}
        {newest.error && messages.length > 0 && <p role="status" className="pb-2 text-center type-body-s text-error">Couldn't refresh: {newest.error}</p>}
      </div>

      <div className="sticky bottom-[var(--nav-h)] z-20 -mx-4 flex flex-none flex-col gap-2 border-t border-outline-variant bg-surface px-4 pt-3 pb-3 sm:-mx-8 sm:px-8 lg:static lg:mx-0 lg:bg-surface-low lg:px-4">
        {aboveComposer}
        <div
          className="flex flex-col gap-2"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              size="sm"
              value={msg.kind}
              onChange={(k) => setMsg(withKind(msg, k))}
              options={[
                { value: "text", label: "Text" },
                { value: "poll", label: "Poll" },
                { value: "location", label: "Pin" },
              ]}
            />
            <div className="ml-auto">{templates(setMsg)}</div>
          </div>
          <MessageComposer value={msg} onChange={setMsg} compact preview={false} idPrefix={`chat-${threadKey}`} attachLabel="Also send the venue pin" />
          {(msg.kind === "location" || msg.attachLocation) && (
            <div className="flex flex-col gap-1.5">
              {pinVenues.length ? (
                <Select value={venueId} onChange={setVenueId} label="Venue to pin" options={pinVenues.map((v) => ({ value: v.id, label: v.name }))} />
              ) : (
                <p className="type-body-s text-error">None of your venues has a map pin yet. Add one under Shows → Venues.</p>
              )}
            </div>
          )}
          <div className="flex items-center gap-3">
            {voiceReady && msg.kind === "text" ? (
              <label className="flex min-w-0 flex-1 items-center gap-2.5 type-body-m">
                <Switch checked={voice} onChange={setVoice} label="Write it in my voice" />
                <span className="min-w-0">
                  <span className="block truncate">Write it in my voice</span>
                  {voice && <span className="block type-body-s text-on-surface-variant">Reworded when sent; your own words go if it changes a fact.</span>}
                </span>
              </label>
            ) : (
              <span className="flex-1" />
            )}
            <Button icon={IconSend} onClick={send} disabled={!ready} data-primary>
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Bubble({ m, label, tz }: { m: ThreadMessage; label?: string; tz: string }) {
  const out = m.fromMe;
  const plain = m.kind === "media" || m.kind === "deleted" || m.kind === "other";
  return (
    <div className={cx("flex flex-col", out ? "items-end" : "items-start")}>
      {label && <span className="mt-1.5 mb-0.5 px-1 type-label-s text-on-surface-variant">{label}</span>}
      <div className={cx("max-w-[88%] rounded-lg px-3.5 py-2 type-body-m sm:max-w-[80%]", out ? "rounded-br-xs bg-primary-container text-on-primary-container" : "rounded-bl-xs bg-surface-highest text-on-surface")}>
        {m.kind === "poll" && m.poll ? <PollCard poll={m.poll} /> : m.kind === "location" && m.pin ? <PinCard name={m.pin.name} detail={m.pin.detail ?? "Map pin"} /> : plain ? <span className="italic opacity-80">{m.text}</span> : <WaText text={m.text} />}
        <div className="mt-0.5 text-right type-label-s tabular opacity-60">{clock(m.at, tz)}</div>
      </div>
    </div>
  );
}

function PendingBubble({ p, onRetry, onDiscard }: { p: Pending; onRetry: () => void; onDiscard: () => void }) {
  const m = p.msg;
  return (
    <div className="flex flex-col items-end">
      <div className={cx("max-w-[88%] rounded-lg rounded-br-xs px-3.5 py-2 type-body-m sm:max-w-[80%]", p.state === "failed" ? "bg-error-container text-on-error-container" : "bg-primary-container/70 text-on-primary-container")}>
        {m.kind === "poll" && m.poll ? <PollCard poll={m.poll} /> : m.kind === "location" ? <PinCard name="Venue pin" detail="Map pin" /> : <WaText text={m.body} />}
        <div className="mt-0.5 flex items-center justify-end gap-2 type-label-s opacity-80">
          {p.state === "sending" ? (
            <>
              <Spinner className="size-3" /> Sending…
            </>
          ) : (
            <>Not sent</>
          )}
        </div>
      </div>
      {p.state === "failed" && (
        <div className="mt-1 flex items-center gap-2 px-1">
          <span className="min-w-0 type-body-s text-error">{p.error}</span>
          <Button size="sm" variant="text" onClick={onRetry}>Retry</Button>
          <Button size="sm" variant="text" onClick={onDiscard}>Discard</Button>
        </div>
      )}
    </div>
  );
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

function ThreadContext({ comic, request: r, lineups, placedShow }: { comic: ReturnType<typeof useApp>["comics"][number]; request?: SpotRequest; lineups: Lineup[]; placedShow?: Show }) {
  const { uid, week, currentWeek, shows, venues, settings } = useApp();
  const now = useNow(60_000);
  const [more, setMore] = useState(false);
  const today = localNow(new Date(now), settings.timezone).date;
  const prev = lastSpot(comic.history, today);
  const active = shows.filter((s) => s.active);
  const open = Boolean(r && OPEN.includes(r.status));
  const preferred = new Set(r?.intent.preferredDays ?? []);
  const manyVenues = new Set(active.map((s) => s.venueId)).size > 1;
  const pills = r ? requestPills({ r, comic, shows, today, venueName: manyVenues ? venues.find((v) => v.id === r.intent.venueId)?.name : undefined }) : [];

  const place = async (show: Show) => {
    try {
      await placeComic(uid, week, show, comic.id, lineups, shows);
      toast.success(`${comic.name.split(/\s+/)[0]} → ${show.name}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const closeRequest = async () => {
    if (!r) return;
    await updateDoc(userDoc(uid, "requests", r.id), { status: "dismissed", updatedAt: Date.now() });
    toast.success(`${comic.name.split(/\s+/)[0]}'s request is closed`, { action: { label: "Undo", onClick: () => void updateDoc(userDoc(uid, "requests", r.id), { status: r.status, updatedAt: Date.now() }) } });
  };

  return (
    <section aria-label="This week" className="my-3 rounded-lg bg-surface-low px-4 py-3 lg:bg-surface-container">
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
        <button onClick={() => setMore((v) => !v)} aria-expanded={more} className="state-layer ml-auto inline-flex h-8 items-center gap-1 rounded-full px-2.5 type-label-m text-on-surface-variant">
          Details <IconArrowDown className={cx("icon size-4 transition-transform duration-200", more && "rotate-180")} />
        </button>
      </div>
      {more && (
        <div className="mt-2.5 flex flex-col gap-2">
          {r && (r.intent.note || r.messages.length > 0) && <p className="type-body-m text-on-surface-variant">{r.intent.note || `“${r.messages[r.messages.length - 1].body}”`}</p>}
          <div className="flex flex-wrap gap-1.5">
            <RequestPills pills={pills} />
          </div>
          <p className="type-body-s text-on-surface-variant">{prev ? `Last spot ${daysBetween(prev.date, today)} days ago (${prev.showName}).` : "No spots on record yet."}</p>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!placedShow && (
          <Menu
            trigger={(toggle) => (
              <Button size="sm" variant="tonal" icon={IconMic} onClick={toggle} disabled={!active.length}>
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
    </section>
  );
}

// ---------- AI assist ----------
// The result is kept in a tiny store keyed by chat, so the header button starts it and the card above the composer shows it.

type Assist = { state: "idle" } | { state: "loading" } | { state: "error"; message: string } | { state: "done"; result: SummarizeThreadResult; dismissed: boolean };
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
      setAssist(comic.id, { state: "done", result: await source.summarize(comic.id, week), dismissed: false });
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
        <Spinner className="size-4" /> Reading the chat…
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
        if (act.told) await placeAsTold(uid, week, show, comic.id, lineups, comic.name);
        else await placeComic(uid, week, show, comic.id, lineups, shows);
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
