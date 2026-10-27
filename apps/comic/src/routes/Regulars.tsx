import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { DAY_NAMES, formatTime, isoAddDays, regularDates, regularLabel, spotDateLabel, suggestRegulars, type RegularSpot } from "@spot/shared";
import { Button, CompactButton, IconPlus, IconArrowLeft, IconRepeat, PageHeader, Spinner } from "@spot/ui";
import { Card, CardButton, EmptyState, IconTile, Page, Section } from "../components/ui";
import { useAsks, useAskPlan, useNowMs } from "../lib/asks";
import { useRoster } from "../lib/roster";
import { newRegularId } from "../lib/regulars";
import { RegularEditor } from "../components/calendar/RegularEditor";

const blank = (today: string): RegularSpot => ({ id: newRegularId(), roomName: "", cadence: "weekly", weekdays: [1], startDate: today, createdAt: Date.now() });

function RuleRow({ r, today, onOpen }: { r: RegularSpot; today: string; onOpen: () => void }) {
  const next = regularDates(r, today, isoAddDays(today, 400))[0];
  return (
    <CardButton onClick={onOpen} className="flex items-center gap-3">
      <IconTile icon={IconRepeat} />
      <span className="min-w-0 flex-1">
        <span className="block truncate type-title-s">{r.roomName}{r.showName ? `, ${r.showName}` : ""}</span>
        <span className="block truncate type-body-s text-on-surface-variant">{regularLabel(r, DAY_NAMES)}{r.time ? `, ${formatTime(r.time)}` : ""}</span>
        <span className="block truncate type-label-m text-on-surface-variant">
          {r.endDate && r.endDate < today ? "Ended" : next ? `Next: ${spotDateLabel(next)}` : "No dates coming up"}
        </span>
      </span>
    </CardButton>
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
        width="narrow"
        title="Regular spots"
        subtitle="The ones you do every week or month."
        actions={<CompactButton icon={IconPlus} label="Add a regular" variant="filled" onClick={() => setEditing(blank(today))} />}
      />
      <Page>
        <Link to="/spots" className="state-layer pressable -mt-2 -mb-2 -ml-2 inline-flex h-11 w-fit items-center gap-2 rounded-full pr-3 pl-2 type-label-l text-primary">
          <IconArrowLeft className="icon size-5" /> My spots
        </Link>
        {store.loading ? (
          <div className="grid place-items-center py-16 text-primary"><Spinner className="size-8" /></div>
        ) : (
          <>
            {suggestions.length > 0 && (
              <Section title="From your rooms">
                <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
                  {suggestions.map((r) => (
                    <li key={r.id} className="min-w-0">
                      <Card tone="secondary" className="flex items-center gap-3">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate type-title-s">You marked {r.roomName}{r.showName ? `, ${r.showName}` : ""} as a regular</span>
                          <span className="block truncate type-body-s">{regularLabel(r, DAY_NAMES)}. Add it to your calendar?</span>
                        </span>
                        <Button size="sm" variant="filled" onClick={() => setEditing(r)}>Set up</Button>
                      </Card>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {rules.length === 0 ? (
              <EmptyState icon={IconRepeat} title="No regular spots yet" action={<CompactButton icon={IconPlus} label="Add a regular" variant="filled" size="md" onClick={() => setEditing(blank(today))} />}>
                Add the mic you do every Monday, or the show on the second Friday. It lands on your calendar by itself, and you only tap when you've done it.
              </EmptyState>
            ) : (
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
                {rules.map((r) => (
                  <li key={r.id} className="min-w-0"><RuleRow r={r} today={today} onOpen={() => setEditing(r)} /></li>
                ))}
              </ul>
            )}
          </>
        )}
      </Page>
      <RegularEditor value={editing} onClose={() => setEditing(null)} today={today} />
    </div>
  );
}
