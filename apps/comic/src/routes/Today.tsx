import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { askDayLabel, closesLabel, isoAddDays, openNow, spotState, suggestRegulars, upcomingGroups, type Ask, type CalendarSpot, type PlannedAsk } from "@spot/shared";
import { Button, Chip, IconRoom, IconCalendarMark, IconChat, IconClock, IconRepeat, PageHeader, Spinner } from "@spot/ui";
import { CardButton, EmptyState, IconTile, Page, Section } from "../components/ui";
import { useAsks, useAskPlan, useNowMs } from "../lib/asks";
import { useRoster } from "../lib/roster";
import { ago, dateTime } from "../lib/time";
import { ConnectionBanner } from "../components/ConnectionCard";
import { CalendarView, readMode, type CalendarMode } from "../components/calendar/CalendarView";
import { DayPanel } from "../components/calendar/DayPanel";
import { WeekAgenda } from "../components/calendar/WeekAgenda";
import { addMonths } from "../components/calendar/dates";
import { SpotEditor } from "../components/SpotEditor";
import { blankSpot } from "../lib/newSpot";
import { newRegularId, useAllSpots, useSpotsBetween } from "../lib/regulars";

type MySpotOrCal = CalendarSpot;
const RECENT_MS = 3 * 86_400_000;

/** Short card for an ask on the Today page; it opens the Asks page rather than repeating its buttons. */
function OpenRow({ a, now }: { a: PlannedAsk; now: number }) {
  return (
    <CardButton to="/asks" className="flex items-center gap-3">
      <IconTile icon={IconRoom} />
      <span className="min-w-0 flex-1">
        <span className="block truncate type-title-s">{a.label}</span>
        <span className="block truncate type-body-s text-on-surface-variant">
          {dateTime(a.showDate, a.time)} · ask {a.curatorName?.split(/\s+/)[0] ?? "no one yet"}
        </span>
      </span>
      <Chip tone={a.closesAt - now < 3 * 3_600_000 ? "error" : "neutral"} className="flex-none">
        {closesLabel(a.closesAt, now)}
      </Chip>
    </CardButton>
  );
}

const REPLY_LABEL = { got_it: "said yes", declined: "can't fit you in", unclear: "replied" } as const;

function ReplyRow({ ask, now }: { ask: Ask; now: number }) {
  const r = ask.lastReply!;
  const who = ask.curatorName?.split(/\s+/)[0] ?? "The curator";
  return (
    <CardButton to="/asks" className="flex flex-col gap-1">
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
    </CardButton>
  );
}

/** A text link in a section's heading row, 44px tall. */
const SectionLink = ({ to, children }: { to: string; children: string }) => (
  <Link to={to} className="state-layer pressable -mr-2 inline-flex min-h-11 items-center rounded-full px-3 type-label-l text-primary">{children}</Link>
);

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
      <PageHeader title="Today" subtitle="Your day at a glance." />
      <Page wide>
        {uid && <ConnectionBanner uid={uid} />}
        {loading ? (
          <div className="grid place-items-center py-16 text-primary"><Spinner className="size-8" /></div>
        ) : (
          <>
            {toCheck > 0 && (
              <CardButton to="/spots" tone="secondary" className="flex min-h-14 items-center gap-3">
                <span className="min-w-0 flex-1 type-title-s">{toCheck === 1 ? "1 spot to check: did it happen?" : `${toCheck} spots to check: did they happen?`}</span>
                <span className="type-label-l">See</span>
              </CardButton>
            )}
            <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:items-start">
              <div className="min-w-0 lg:sticky lg:top-24"><CalendarView spots={calSpots} today={today} selected={selected} onSelect={setSelected} mode={mode} onMode={setMode} /></div>
              {mode === "week" ? (
                <WeekAgenda date={selected} today={today} spots={calSpots} asks={plan} onOpenDay={(d) => { setSelected(d); setMode("day"); }} onAdd={(d) => setEditing(blankSpot(d))} onOpen={setEditing} />
              ) : (
              <DayPanel date={selected} today={today} spots={calSpots} allSpots={all} asks={plan} agenda={mode === "day"} onAdd={(d) => setEditing(blankSpot(d))} onOpen={setEditing} />
              )}
            </div>
            {suggestions.length > 0 && (
              <CardButton to="/spots/regulars" className="flex items-center gap-3">
                <IconTile icon={IconRepeat} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate type-title-s">Add your regulars to the calendar</span>
                  <span className="block truncate type-body-s text-on-surface-variant">You marked {suggestions[0]!.roomName}{suggestions.length > 1 ? ` and ${suggestions.length - 1} more` : ""} as a regular.</span>
                </span>
              </CardButton>
            )}

            {nothing ? (
              <EmptyState icon={IconCalendarMark} title="Add your rooms too" action={<Link to="/rooms"><Button>Go to Rooms</Button></Link>}>
                Add the rooms you go to. Then the asks to make and the replies show up here as well.
              </EmptyState>
            ) : (
              <div className="grid min-w-0 gap-6 lg:grid-cols-2 lg:items-start">
            <Section title="Ask now" label="Asks open now" action={open.length > 0 ? <SectionLink to="/asks">Open Asks</SectionLink> : undefined}>
              {open.length > 0 ? (
                <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
                  {open.slice(0, 4).map((a) => (
                    <li key={a.id} className="min-w-0"><OpenRow a={a} now={now} /></li>
                  ))}
                  {open.length > 4 && <li className="type-body-s text-on-surface-variant">+{open.length - 4} more on the Asks page</li>}
                </ul>
              ) : (
                <p className="flex min-w-0 items-start gap-2 px-1 type-body-m text-on-surface-variant">
                  <IconClock aria-hidden className="icon mt-0.5 size-4 flex-none" />
                  <span>{next ? `Nothing to ask right now. The next one opens ${askDayLabel(next.date, today).toLowerCase()}: ${next.asks[0]!.label}.` : "Nothing to ask right now."}</span>
                </p>
              )}
            </Section>

            <Section title="Recent replies" action={replies.length > 0 ? <SectionLink to="/asks">All asks</SectionLink> : undefined}>
              {replies.length > 0 ? (
                <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
                  {replies.map((a) => (
                    <li key={a.id} className="min-w-0"><ReplyRow ask={a} now={now} /></li>
                  ))}
                </ul>
              ) : (
                <p className="flex min-w-0 items-start gap-2 px-1 type-body-m text-on-surface-variant">
                  <IconChat aria-hidden className="icon mt-0.5 size-4 flex-none" />
                  <span>No replies in the last three days.</span>
                </p>
              )}
            </Section>
              </div>
            )}
          </>
        )}
      </Page>
      <SpotEditor value={editing} onClose={() => setEditing(null)} today={today} />
    </div>
  );
}
