import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { DAY_NAMES, formatTime, isoAddDays, regularDates, regularLabel, spotDateLabel, suggestRegulars, type RegularSpot } from "@spot/shared";
import { Button, CompactButton, Empty, IconAdd, IconArrowLeft, IconRepeat, PageHeader, SectionTitle, Spinner } from "@spot/ui";
import { useAsks, useAskPlan, useNowMs } from "../lib/asks";
import { useRoster } from "../lib/roster";
import { newRegularId } from "../lib/regulars";
import { RegularEditor } from "../components/calendar/RegularEditor";

const blank = (today: string): RegularSpot => ({ id: newRegularId(), roomName: "", cadence: "weekly", weekdays: [1], startDate: today, createdAt: Date.now() });

function RuleRow({ r, today, onOpen }: { r: RegularSpot; today: string; onOpen: () => void }) {
  const next = regularDates(r, today, isoAddDays(today, 400))[0];
  return (
    <button onClick={onOpen} className="state-layer pressable flex w-full min-w-0 items-center gap-3 rounded-lg bg-surface-low p-3.5 text-left">
      <span className="grid size-10 flex-none place-items-center rounded-md bg-tertiary-container text-on-tertiary-container">
        <IconRepeat className="icon size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate type-title-s">{r.roomName}{r.showName ? `, ${r.showName}` : ""}</span>
        <span className="block truncate type-body-s text-on-surface-variant">{regularLabel(r, DAY_NAMES)}{r.time ? `, ${formatTime(r.time)}` : ""}</span>
        <span className="block truncate type-label-m text-on-surface-variant">
          {r.endDate && r.endDate < today ? "Ended" : next ? `Next: ${spotDateLabel(next)}` : "No dates coming up"}
        </span>
      </span>
    </button>
  );
}

/** Regular spots: the weekly mic, the monthly show. Each one fills your calendar by itself. */
export function Regulars() {
  const store = useAsks();
  const roster = useRoster();
  const now = useNowMs(60_000);
  const { today } = useAskPlan(now);
  const [editing, setEditing] = useState<RegularSpot | null>(null);
  const suggestions = useMemo(() => suggestRegulars(roster.rooms, store.regulars, today, newRegularId, Date.now()), [roster.rooms, store.regulars, today]);
  const rules = [...store.regulars].sort((a, b) => a.roomName.localeCompare(b.roomName));
  return (
    <div className="w-full">
      <PageHeader
        title="Regular spots"
        subtitle="The ones you do every week or month."
        actions={<CompactButton icon={IconAdd} label="Add a regular" variant="filled" onClick={() => setEditing(blank(today))} />}
      />
      <div className="flex min-w-0 flex-col gap-6 px-4 pt-3 pb-[calc(var(--nav-h)+2rem)] sm:px-8 sm:pb-12 lg:max-w-3xl">
        <Link to="/spots" className="state-layer pressable inline-flex h-11 w-fit items-center gap-2 rounded-full pr-3 type-label-l text-primary">
          <IconArrowLeft className="icon size-5" /> My spots
        </Link>
        {store.loading ? (
          <div className="grid place-items-center py-16 text-primary"><Spinner className="size-8" /></div>
        ) : (
          <>
            {suggestions.length > 0 && (
              <section aria-label="Suggested regulars" className="min-w-0">
                <SectionTitle>From your rooms</SectionTitle>
                <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
                  {suggestions.map((r) => (
                    <li key={r.id} className="flex min-w-0 items-center gap-3 rounded-lg bg-secondary-container p-3.5 text-on-secondary-container">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate type-title-s">You marked {r.roomName}{r.showName ? `, ${r.showName}` : ""} as a regular</span>
                        <span className="block truncate type-body-s">{regularLabel(r, DAY_NAMES)}. Add it to your calendar?</span>
                      </span>
                      <Button size="sm" variant="tonal" onClick={() => setEditing(r)}>Set up</Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {rules.length === 0 ? (
              <Empty icon={IconRepeat} title="No regular spots yet" action={<CompactButton icon={IconAdd} label="Add a regular" variant="filled" size="md" onClick={() => setEditing(blank(today))} />}>
                Add the mic you do every Monday, or the show on the second Friday. It lands on your calendar by itself, and you only tap when you've done it.
              </Empty>
            ) : (
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
                {rules.map((r) => (
                  <li key={r.id} className="min-w-0"><RuleRow r={r} today={today} onOpen={() => setEditing(r)} /></li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <RegularEditor value={editing} onClose={() => setEditing(null)} today={today} />
    </div>
  );
}
