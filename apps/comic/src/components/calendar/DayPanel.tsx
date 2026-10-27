import { useState } from "react";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import { SPOT_SOURCE_LABEL, SPOT_STATE_LABEL, bySpotTime, formatTime, regularFromSpot, spotClashes, spotDateLabel, spotState, type CalendarSpot, type PlannedAsk, type RegularSpot } from "@spot/shared";
import { Button, Chip, IconPlus, IconCheck, IconRepeat, IconSend, IconSkip } from "@spot/ui";
import { Card, Notice, Section } from "../ui";
import { useRoster } from "../../lib/roster";
import { newRegularId, useSpotActions } from "../../lib/regulars";
import { Stars } from "../SpotCards";
import { SOURCE_DOT } from "./dates";
import { RegularEditor } from "./RegularEditor";

const TONE = { upcoming: "neutral", tonight: "primary", to_check: "error", happened: "success", didnt: "neutral", cancelled: "neutral" } as const;

/** One day of the calendar: its spots (time, room, show, where it stands, did it happen?) and what to do with them. */
export function DayPanel({ date, today, spots, allSpots, asks = [], agenda, onAdd, onOpen }: { date: string; today: string; spots: CalendarSpot[]; allSpots: CalendarSpot[]; /** Asks for shows on this day. */ asks?: PlannedAsk[]; /** The Day view: asks sit in the timeline at their show's time. */ agenda?: boolean; onAdd: (date: string) => void; onOpen: (s: CalendarSpot) => void }) {
  const roster = useRoster();
  const act = useSpotActions();
  const [making, setMaking] = useState<RegularSpot | null>(null);
  const list = [...spots].filter((s) => s.date === date).sort((a, b) => bySpotTime(a, b));
  const showName = (s: CalendarSpot) => {
    const room = roster.rooms.find((r) => r.id === s.roomId);
    const show = room?.shows.find((x) => x.id === s.showId);
    return show?.name ?? act.rule(s.regularId)?.showName;
  };
  const run = (p: Promise<unknown>, ok: string) => p.then(() => toast.success(ok), () => toast.error("Couldn't save that. Try again."));
  const dayAsks = asks.filter((a) => a.showDate === date).sort((a, b) => (a.time ?? "99:99").localeCompare(b.time ?? "99:99"));
  const askRow = (a: PlannedAsk) => (
    <Link to="/asks" className="state-layer pressable flex min-h-14 min-w-0 items-center gap-3 rounded-lg border border-dashed border-outline-variant px-3 py-2">
      <span className="w-14 flex-none type-title-s tabular">{a.time ? formatTime(a.time) : <span className="type-label-m text-on-surface-variant">No time</span>}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate type-title-s">{a.label}</span>
        <span className="block truncate type-body-s text-on-surface-variant">Ask {a.curatorName?.split(/\s+/)[0] ?? "no one yet"}</span>
      </span>
      <IconSend aria-hidden className="icon size-4 flex-none text-on-surface-variant" />
    </Link>
  );
  // Day view: spots and asks in one timeline, earliest first. Elsewhere the asks follow the spots.
  type Item = { at: string; spot?: CalendarSpot; ask?: PlannedAsk };
  const items: Item[] = agenda ? [...list.map((s): Item => ({ at: s.time ?? "99:99", spot: s })), ...dayAsks.map((a): Item => ({ at: a.time ?? "99:99", ask: a }))].sort((a, b) => a.at.localeCompare(b.at) || Number(Boolean(a.ask)) - Number(Boolean(b.ask))) : list.map((s): Item => ({ at: s.time ?? "", spot: s }));
  const title = date === today ? "Today" : spotDateLabel(date);
  return (
    <Section
      title={title}
      label={`Spots on ${spotDateLabel(date)}`}
      action={
        <Button size="sm" variant="tonal" icon={IconPlus} onClick={() => onAdd(date)}>
          Add a spot
        </Button>
      }
    >
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-outline-variant px-4 py-6 text-center type-body-m text-on-surface-variant">{date < today ? "Nothing on this day." : "Nothing booked this day yet."}</p>
      ) : (
        <ul className={`grid grid-cols-[minmax(0,1fr)] gap-2 ${agenda ? "border-l-2 border-outline-variant pl-3" : ""}`}>
          {items.map((it) => {
            if (!it.spot) return <li key={`ask-${it.ask!.id}`} className="min-w-0">{askRow(it.ask!)}</li>;
            const s = it.spot;
            const state = spotState(s, today);
            const clash = s.status === "cancelled" ? [] : spotClashes(allSpots, s);
            const regular = s.source === "regular";
            const canMark = !s.skippedRegular && s.date <= today && s.happened == null && s.status !== "cancelled";
            const sn = showName(s);
            return (
              <li key={s.id} className="min-w-0">
               <Card dim={state === "didnt" || s.skippedRegular} className="flex flex-col gap-3">
                <button onClick={() => !s.skippedRegular && onOpen(s)} className="state-layer pressable -m-1 flex min-h-11 min-w-0 items-start gap-3 rounded-md p-1 text-left" aria-label={`Open ${s.roomName ?? "spot"}`} disabled={s.skippedRegular}>
                  <span className="w-14 flex-none pt-0.5 type-title-s tabular">{s.time ? formatTime(s.time) : <span className="type-label-m text-on-surface-variant">No time</span>}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate type-title-s">{s.roomName || "Somewhere"}</span>
                    <span className="flex min-w-0 items-center gap-1.5 type-body-s text-on-surface-variant">
                      <span className={`size-2 flex-none rounded-full ${SOURCE_DOT[s.source]}`} aria-hidden />
                      <span className="truncate">{[sn, SPOT_SOURCE_LABEL[s.source]].filter(Boolean).join(" · ")}</span>
                    </span>
                  </span>
                  <Chip tone={s.skippedRegular ? "neutral" : TONE[state]} className="flex-none">
                    {s.skippedRegular ? "Skipped" : SPOT_STATE_LABEL[state]}
                  </Chip>
                </button>
                {s.notes?.rating ? <Stars value={s.notes.rating} /> : null}
                {clash.length > 0 && (
                  <Notice tone="warn" className="p-3 type-body-s">Close to {clash[0]!.roomName || "another spot"}{clash[0]!.time ? ` at ${formatTime(clash[0]!.time)}` : ""}.</Notice>
                )}
                {s.skippedRegular ? (
                  <div className="flex justify-end"><Button size="sm" variant="text" onClick={() => void run(act.unskip(s), "Back on.")}>Undo skip</Button></div>
                ) : (
                  <>
                    {canMark && (
                      <div className="grid grid-cols-2 gap-2">
                        <Button size="sm" variant="text" onClick={() => void run(act.mark(s, false), "Marked as didn't happen.")}>Didn't happen</Button>
                        <Button size="sm" variant="tonal" icon={IconCheck} onClick={() => void run(act.mark(s, true), "Marked as done. Add notes while it's fresh.")}>It happened</Button>
                      </div>
                    )}
                    {((regular && s.date >= today && s.happened == null) || (!regular && s.status !== "cancelled")) && (
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        {regular ? (
                          <Button size="sm" variant="text" icon={IconSkip} onClick={() => void run(act.skip(s), "Skipped that date.")}>Not this time</Button>
                        ) : (
                          <Button size="sm" variant="text" icon={IconRepeat} onClick={() => setMaking(regularFromSpot(s, newRegularId(), Date.now()))}>Make this a regular</Button>
                        )}
                      </div>
                    )}
                  </>
                )}
               </Card>
              </li>
            );
          })}
        </ul>
      )}
      {!agenda && dayAsks.length > 0 && (
        <div className="mt-2 flex min-w-0 flex-col gap-2">
          <p className="px-1 type-label-l text-on-surface-variant">To ask for this day</p>
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">{dayAsks.map((a) => <li key={a.id} className="min-w-0">{askRow(a)}</li>)}</ul>
        </div>
      )}
      <RegularEditor value={making} onClose={() => setMaking(null)} today={today} />
    </Section>
  );
}
