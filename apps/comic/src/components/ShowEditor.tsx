import { useState } from "react";
import { DAY_NAMES, DAY_SHORT, WEEK_ORDER, type DayPlan, type RoomShow, type Weekday } from "@spot/shared";
import { Button, Chip, Field, IconAdd, IconButton, IconClose, Segmented, TextInput, TimePicker } from "@spot/ui";
import { ToggleRow } from "./ui";
import { useRoster } from "../lib/roster";
import { AskRuleEditor } from "./AskRuleEditor";
import { CuratorPicker } from "./CuratorPicker";

const WEEKS = [1, 2, 3, 4, 5, -1];
const WEEK_LABEL: Record<number, string> = { 1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 5: "5th", [-1]: "Last" };

export const Section = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
  <section className="flex min-w-0 flex-col gap-3">
    <div>
      <h3 className="type-title-m">{title}</h3>
      {hint && <p className="mt-0.5 type-body-s text-on-surface-variant">{hint}</p>}
    </div>
    {children}
  </section>
);

function TimesList({ times, onChange, label }: { times: string[]; onChange: (t: string[]) => void; label: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {times.map((t, i) => (
        <div key={i} className="flex min-w-0 items-center gap-2">
          <TimePicker label={`${label} ${i + 1}`} wrapperClassName="min-w-0 flex-1" value={t} onChange={(v) => onChange(times.map((x, j) => (j === i ? v : x)))} />
          <IconButton icon={IconClose} label="Remove this time" onClick={() => onChange(times.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div>
        <Button variant="tonal" size="sm" icon={IconAdd} onClick={() => onChange([...times, times.length ? "22:00" : "21:00"])}>
          Add a time
        </Button>
      </div>
    </div>
  );
}

function DayCard({ day, onChange, onCopy, canCopy, showName }: { day: DayPlan; onChange: (d: DayPlan) => void; onCopy: () => void; canCopy: boolean; showName: string }) {
  const { curators } = useRoster();
  const [picking, setPicking] = useState(false);
  const [more, setMore] = useState(Boolean(day.times?.length || day.askRule || day.note));
  const nameOf = (id: string) => curators.find((c) => c.id === id)?.name ?? "Unknown curator";
  const ids = day.curatorIds;
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-md bg-surface-container p-3">
      <div className="flex min-w-0 items-center gap-2">
        <h4 className="min-w-0 flex-1 truncate type-title-s">{DAY_NAMES[day.weekday]}</h4>
        {canCopy && <Button variant="text" size="sm" onClick={onCopy}>Same for every day</Button>}
      </div>
      <ToggleRow label="They'll reach out (nothing to ask)" checked={Boolean(day.theyReachOut)} onChange={(v) => onChange({ ...day, theyReachOut: v || undefined })} />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="type-label-l text-on-surface-variant">Curators</span>
        {ids.length === 0 && !picking && <p className="type-body-s text-on-surface-variant">No one yet. The first you add is who to ask.</p>}
        {ids.map((id, i) => (
          <div key={id} className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate type-body-l">{nameOf(id)}</span>
            {i === 0 ? (
              <Chip tone="primary">Ask first</Chip>
            ) : (
              <Button variant="text" size="sm" onClick={() => onChange({ ...day, curatorIds: [id, ...ids.filter((x) => x !== id)] })}>
                Ask first
              </Button>
            )}
            <IconButton icon={IconClose} label={`Remove ${nameOf(id)} from ${DAY_NAMES[day.weekday]} at ${showName}`} onClick={() => onChange({ ...day, curatorIds: ids.filter((x) => x !== id) })} />
          </div>
        ))}
      </div>
      {picking ? (
        <CuratorPicker exclude={ids} onPick={(id) => onChange({ ...day, curatorIds: [...ids, id] })} onClose={() => setPicking(false)} />
      ) : (
        <div>
          <Button variant="tonal" size="sm" icon={IconAdd} onClick={() => setPicking(true)}>
            {ids.length ? "Add a co-curator" : "Add a curator"}
          </Button>
        </div>
      )}
      <ToggleRow label="Different times, ask rule or note this day" checked={more} onChange={setMore} />
      {more && (
        <div className="flex min-w-0 flex-col gap-4">
          <Field label="Start times this day">
            <TimesList label={`${DAY_SHORT[day.weekday]} time`} times={day.times ?? []} onChange={(t) => onChange({ ...day, times: t.length ? t : undefined })} />
          </Field>
          <AskRuleEditor emptyLabel="Same as the show" value={day.askRule} onChange={(askRule) => onChange({ ...day, askRule })} />
          <Field label="Note for this day">
            <TextInput value={day.note ?? ""} onChange={(e) => onChange({ ...day, note: e.target.value || undefined })} placeholder="Weekends start at 5:30 PM" />
          </Field>
        </div>
      )}
    </div>
  );
}

/** One show inside a room: type, days, times, ask rule, a curator per day, and my role. Edits a copy; the caller keeps it on Done. */
export function ShowForm({ show, onChange }: { show: RoomShow; onChange: (s: RoomShow) => void }) {
  const set = (patch: Partial<RoomShow>) => onChange({ ...show, ...patch });
  const picked = new Set(show.days.map((d) => d.weekday));
  const toggleDay = (d: Weekday) => {
    if (picked.has(d)) set({ days: show.days.filter((x) => x.weekday !== d) });
    else set({ days: [...show.days, { weekday: d, curatorIds: [] }].sort((a, b) => WEEK_ORDER.indexOf(a.weekday) - WEEK_ORDER.indexOf(b.weekday)) });
  };
  const days = [...show.days].sort((a, b) => WEEK_ORDER.indexOf(a.weekday) - WEEK_ORDER.indexOf(b.weekday));
  const setDay = (d: DayPlan) => set({ days: show.days.map((x) => (x.weekday === d.weekday ? d : x)) });
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <Section title="The show">
        <Field label="Name">
          <TextInput value={show.name} onChange={(e) => set({ name: e.target.value })} placeholder="Mic" />
        </Field>
        <Field label="What is it">
          <Segmented full value={show.type} onChange={(type) => set({ type })} options={[{ value: "mic", label: "Mic" }, { value: "show", label: "Show" }, { value: "both", label: "Both" }]} />
        </Field>
        <Field label="How often">
          <Segmented
            full
            value={show.cadence}
            onChange={(cadence) => set({ cadence, days: cadence === "daily" ? WEEK_ORDER.map((w) => show.days.find((d) => d.weekday === w) ?? { weekday: w, curatorIds: [] }) : show.days, monthlyWeeks: cadence === "monthly" ? (show.monthlyWeeks?.length ? show.monthlyWeeks : [1]) : undefined })}
            options={[{ value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }]}
          />
        </Field>
      </Section>

      <Section title="When it runs">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
          {WEEK_ORDER.map((d) => (
            <Chip key={d} selected={picked.has(d)} onClick={() => toggleDay(d)} className="h-9 min-w-12 justify-center">
              {DAY_SHORT[d]}
            </Chip>
          ))}
        </div>
        {show.cadence === "monthly" && (
          <Field label="Which weeks of the month">
            <div className="flex flex-wrap gap-1.5">
              {WEEKS.map((w) => (
                <Chip key={w} selected={show.monthlyWeeks?.includes(w)} onClick={() => set({ monthlyWeeks: show.monthlyWeeks?.includes(w) ? show.monthlyWeeks.filter((x) => x !== w) : [...(show.monthlyWeeks ?? []), w] })} className="h-9 min-w-12 justify-center">
                  {WEEK_LABEL[w]}
                </Chip>
              ))}
            </div>
          </Field>
        )}
        <Field label="Start times">
          <TimesList label="Start time" times={show.times} onChange={(times) => set({ times })} />
        </Field>
      </Section>

      <Section title="When to ask" hint="For the whole show. A day can have its own below.">
        <AskRuleEditor value={show.askRule} onChange={(askRule) => set({ askRule })} />
      </Section>

      <Section title="Who curates" hint="Per day. The first curator is who to ask; the rest are co-curators.">
        {days.length === 0 && <p className="type-body-m text-on-surface-variant">Pick the days above first.</p>}
        {days.map((d) => (
          <DayCard key={d.weekday} day={d} onChange={setDay} showName={show.name} canCopy={days.length > 1} onCopy={() => set({ days: show.days.map((x) => ({ ...x, curatorIds: [...d.curatorIds], theyReachOut: d.theyReachOut })) })} />
        ))}
      </Section>

      <Section title="You and this show">
        <Segmented
          full
          value={show.myRole ?? "none"}
          onChange={(r) => set({ myRole: r === "none" ? undefined : r })}
          options={[{ value: "none", label: "Not me" }, { value: "regular", label: "I'm a regular" }, { value: "curator", label: "I curate it" }]}
        />
        <Field label="Paused until (optional)" hint="A seasonal break. Nothing is suggested for this show until then.">
          <TextInput type="date" value={show.pausedUntil ?? ""} onChange={(e) => set({ pausedUntil: e.target.value || undefined })} />
        </Field>
        <Field label="Your notes (only you see these)">
          <TextInput value={show.myNotes ?? ""} onChange={(e) => set({ myNotes: e.target.value || undefined })} placeholder="Good crowd, tough sound" />
        </Field>
      </Section>
    </div>
  );
}
