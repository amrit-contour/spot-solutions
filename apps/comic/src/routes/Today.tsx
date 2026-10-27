import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { askDayLabel, closesLabel, isoAddDays, openNow, spotState, suggestRegulars, upcomingGroups, type Ask, type CalendarSpot, type PlannedAsk } from "@spot/shared";
import { Button, Chip, Empty, IconBuilding, IconCalendarMark, IconChat, IconClock, IconRepeat, PageHeader, Spinner, SectionTitle } from "@spot/ui";
import { useAsks, useAskPlan, useNowMs } from "../lib/asks";
import { useRoster } from "../lib/roster";
import { ago, dateTime } from "../lib/time";
import { ConnectionBanner } from "../components/ConnectionCard";
import { CalendarView, readMode, type CalendarMode } from "../components/calendar/CalendarView";
import { DayPanel } from "../components/calendar/DayPanel";
import { addMonths } from "../components/calendar/dates";
import { SpotEditor } from "../components/SpotEditor";
import { blankSpot } from "../lib/newSpot";
import { newRegularId, useAllSpots, useSpotsBetween } from "../lib/regulars";

type MySpotOrCal = CalendarSpot;
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
  const [selected, setSelected] = useState(today);
  const [mode, setMode] = useState<CalendarMode>(readMode);
  const [editing, setEditing] = useState<MySpotOrCal | null>(null);
  // The calendar reads a month either side of the one shown, so swiping is instant.
  const from = isoAddDays(`${addMonths(selected, -1).slice(0, 7)}-01`, -7);
  const to = isoAddDays(`${addMonths(selected, 2).slice(0, 7)}-01`, 7);
  const calSpots = useSpotsBetween(from, to);
  const all = useAllSpots(today);
  const toCheck = all.filter((s) => spotState(s, today) === "to_check").length;
  const suggestions = useMemo(() => suggestRegulars(roster.rooms, store.regulars, today, newRegularId, 0), [roster.rooms, store.regulars, today]);
  const replies = useMemo(
    () => store.asks.filter((a) => a.lastReply && !a.skipped && now - a.lastReply.at < RECENT_MS).sort((a, b) => b.lastReply!.at - a.lastReply!.at).slice(0, 5),
    [store.asks, now],
  );
  const loading = store.loading || roster.loading;
  const nothing = !loading && roster.rooms.length === 0 && store.spots.length === 0 && store.regulars.length === 0;
  return (
    <div className="w-full">
      <PageHeader title="Today" subtitle="Your day at a glance." actions={<Link to="/spots/regulars" aria-label="Regular spots" className="state-layer pressable grid size-11 place-items-center rounded-full text-primary"><IconRepeat className="icon size-5" /></Link>} />
      <div className="flex min-w-0 flex-col gap-7 px-4 pt-3 pb-[calc(var(--nav-h)+2rem)] sm:px-8 sm:pb-12 lg:max-w-3xl">
        {uid && <ConnectionBanner uid={uid} />}
        {loading ? (
          <div className="grid place-items-center py-16 text-primary"><Spinner className="size-8" /></div>
        ) : (
          <>
            {toCheck > 0 && (
              <Link to="/spots" className="state-layer pressable flex min-w-0 items-center gap-3 rounded-lg bg-secondary-container p-3.5 text-on-secondary-container">
                <span className="min-w-0 flex-1 type-title-s">{toCheck === 1 ? "1 spot to check: did it happen?" : `${toCheck} spots to check: did they happen?`}</span>
                <span className="type-label-l">See</span>
              </Link>
            )}
            <CalendarView spots={calSpots} today={today} selected={selected} onSelect={setSelected} mode={mode} onMode={setMode} />
            <DayPanel date={selected} today={today} spots={calSpots} allSpots={all} onAdd={(d) => setEditing(blankSpot(d))} onOpen={setEditing} />
            {suggestions.length > 0 && (
              <Link to="/spots/regulars" className="state-layer pressable flex min-w-0 items-center gap-3 rounded-lg bg-surface-low p-3.5">
                <span className="grid size-10 flex-none place-items-center rounded-md bg-tertiary-container text-on-tertiary-container"><IconRepeat className="icon size-5" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate type-title-s">Add your regulars to the calendar</span>
                  <span className="block truncate type-body-s text-on-surface-variant">You marked {suggestions[0]!.roomName}{suggestions.length > 1 ? ` and ${suggestions.length - 1} more` : ""} as a regular.</span>
                </span>
              </Link>
            )}

            {nothing ? (
              <Empty icon={IconCalendarMark} title="Add your rooms too" action={<Link to="/rooms"><Button>Go to Rooms</Button></Link>}>
                Add the rooms you go to. Then the asks to make and the replies show up here as well.
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
          </>
        )}
      </div>
      <SpotEditor value={editing} onClose={() => setEditing(null)} today={today} />
    </div>
  );
}
