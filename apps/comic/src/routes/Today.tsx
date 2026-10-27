import { useMemo } from "react";
import { Link } from "react-router-dom";
import { askDayLabel, closesLabel, openNow, spotClashes, spotState, upcomingGroups, formatTime, type Ask, type PlannedAsk } from "@spot/shared";
import { Button, Chip, Empty, IconBuilding, IconCalendarMark, IconChat, IconClock, IconMic, PageHeader, Spinner, SectionTitle } from "@spot/ui";
import { useAsks, useAskPlan, useNowMs } from "../lib/asks";
import { useRoster } from "../lib/roster";
import { ago, dateTime } from "../lib/time";
import { ConnectionBanner } from "../components/ConnectionCard";

const RECENT_MS = 3 * 86_400_000;

/** Short card for an ask on the Today page; it opens the Asks page rather than repeating its buttons. */
function OpenRow({ a, now }: { a: PlannedAsk; now: number }) {
  return (
    <Link to="/asks" className="state-layer pressable flex min-w-0 items-center gap-3 rounded-lg bg-surface-low p-3.5">
      <span className="grid size-10 flex-none place-items-center rounded-md bg-tertiary-container text-on-tertiary-container">
        <IconBuilding className="icon size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate type-title-s">{a.label}</span>
        <span className="block truncate type-body-s text-on-surface-variant">
          {dateTime(a.showDate, a.time)} · ask {a.curatorName?.split(/\s+/)[0] ?? "no one yet"}
        </span>
      </span>
      <Chip tone={a.closesAt - now < 3 * 3_600_000 ? "error" : "neutral"} className="flex-none">
        {closesLabel(a.closesAt, now)}
      </Chip>
    </Link>
  );
}

const REPLY_LABEL = { got_it: "said yes", declined: "can't fit you in", unclear: "replied" } as const;

function ReplyRow({ ask, now }: { ask: Ask; now: number }) {
  const r = ask.lastReply!;
  const who = ask.curatorName?.split(/\s+/)[0] ?? "The curator";
  return (
    <Link to="/asks" className="state-layer pressable flex min-w-0 flex-col gap-1 rounded-lg bg-surface-low p-3.5">
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate type-title-s">
          {who} {REPLY_LABEL[r.decision]}
        </span>
        <Chip tone={r.decision === "got_it" ? "success" : r.decision === "declined" ? "error" : "primary"} className="flex-none">
          {r.decision === "unclear" ? "Needs you" : r.decision === "got_it" ? "Got it" : "Declined"}
        </Chip>
      </span>
      <span className="truncate type-body-s text-on-surface-variant">
        {ask.roomName} · {ago(r.at, now)}
      </span>
      <span className="line-clamp-2 type-body-m">“{r.text}”</span>
    </Link>
  );
}

/** Today: asks to make now, tonight's spots, and the replies that came in lately. */
export function Today({ uid }: { uid?: string }) {
  const store = useAsks();
  const roster = useRoster();
  const now = useNowMs();
  const { plan, today } = useAskPlan(now);
  const open = useMemo(() => openNow(plan), [plan]);
  const next = useMemo(() => upcomingGroups(plan, today, 7)[0], [plan, today]);
  const tonight = useMemo(() => store.spots.filter((s) => spotState(s, today) === "tonight").sort((a, b) => (a.time ?? "99").localeCompare(b.time ?? "99")), [store.spots, today]);
  const toCheck = store.spots.filter((s) => spotState(s, today) === "to_check").length;
  const replies = useMemo(
    () => store.asks.filter((a) => a.lastReply && !a.skipped && now - a.lastReply.at < RECENT_MS).sort((a, b) => b.lastReply!.at - a.lastReply!.at).slice(0, 5),
    [store.asks, now],
  );
  const loading = store.loading || roster.loading;
  const nothing = !loading && roster.rooms.length === 0 && store.spots.length === 0;
  return (
    <div className="w-full">
      <PageHeader title="Today" subtitle="Your day at a glance." />
      <div className="flex min-w-0 flex-col gap-7 px-4 pt-3 pb-[calc(var(--nav-h)+2rem)] sm:px-8 sm:pb-12 lg:max-w-3xl">
        {uid && <ConnectionBanner uid={uid} />}
        {loading ? (
          <div className="grid place-items-center py-16 text-primary"><Spinner className="size-8" /></div>
        ) : nothing ? (
          <Empty icon={IconCalendarMark} title="Start with your rooms" action={<Link to="/rooms"><Button>Go to Rooms</Button></Link>}>
            Add the rooms you go to. Then the asks to make, your spots and the replies all show up here.
          </Empty>
        ) : (
          <>
            <section aria-label="Asks open now" className="min-w-0">
              <SectionTitle action={open.length > 0 ? <Link to="/asks" className="type-label-l text-primary">Open Asks</Link> : undefined}>Ask now</SectionTitle>
              {open.length > 0 ? (
                <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
                  {open.slice(0, 4).map((a) => (
                    <li key={a.id} className="min-w-0"><OpenRow a={a} now={now} /></li>
                  ))}
                  {open.length > 4 && <li className="type-body-s text-on-surface-variant">+{open.length - 4} more on the Asks page</li>}
                </ul>
              ) : (
                <p className="flex min-w-0 items-start gap-2 type-body-m text-on-surface-variant">
                  <IconClock aria-hidden className="icon mt-0.5 size-4 flex-none" />
                  <span>{next ? `Nothing to ask right now. The next one opens ${askDayLabel(next.date, today).toLowerCase()}: ${next.asks[0]!.label}.` : "Nothing to ask right now."}</span>
                </p>
              )}
            </section>

            <section aria-label="Tonight" className="min-w-0">
              <SectionTitle action={toCheck > 0 ? <Link to="/spots" className="type-label-l text-primary">{toCheck} to check</Link> : undefined}>Tonight</SectionTitle>
              {tonight.length > 0 ? (
                <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
                  {tonight.map((s) => {
                    const clash = spotClashes(store.spots, s);
                    return (
                      <li key={s.id} className="min-w-0">
                        <Link to="/spots" className="state-layer pressable flex min-w-0 items-center gap-3 rounded-lg bg-surface-low p-3.5">
                          <span className="grid size-10 flex-none place-items-center rounded-md bg-primary-container text-on-primary-container">
                            <IconMic className="icon size-5" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate type-title-s">{s.roomName || "A spot"}</span>
                            <span className="block truncate type-body-s text-on-surface-variant">{s.time ? formatTime(s.time) : "No time set"}</span>
                          </span>
                          {clash.length > 0 && <Chip tone="error" className="flex-none">Clash</Chip>}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="type-body-m text-on-surface-variant">No spot tonight.</p>
              )}
            </section>

            <section aria-label="Recent replies" className="min-w-0">
              <SectionTitle action={replies.length > 0 ? <Link to="/asks" className="type-label-l text-primary">All asks</Link> : undefined}>Recent replies</SectionTitle>
              {replies.length > 0 ? (
                <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
                  {replies.map((a) => (
                    <li key={a.id} className="min-w-0"><ReplyRow ask={a} now={now} /></li>
                  ))}
                </ul>
              ) : (
                <p className="flex min-w-0 items-start gap-2 type-body-m text-on-surface-variant">
                  <IconChat aria-hidden className="icon mt-0.5 size-4 flex-none" />
                  <span>No replies in the last three days.</span>
                </p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
