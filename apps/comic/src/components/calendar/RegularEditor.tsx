import { useState } from "react";
import { toast } from "sonner";
import { DAY_NAMES, NTH_LABEL, nthWeekdayOf, regularLabel, spotDateLabel, validateRegular, weekdayOf, type RegularCadence, type RegularSpot, type Weekday } from "@spot/shared";
import { Button, ConfirmDialog, Field, Segmented, Select, Sheet, TextArea, TextInput, TimePicker, IconTrash } from "@spot/ui";
import { Card, Notice, SectionHeader, ToggleRow } from "../ui";
import { useAsks } from "../../lib/asks";
import { useRoster } from "../../lib/roster";

const OTHER = "__other";
const ORDER: Weekday[] = [1, 2, 3, 4, 5, 6, 0];
const NTHS = [1, 2, 3, 4, -1];

function Round({ on, label, onClick, children }: { on: boolean; label: string; onClick: () => void; children: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} aria-label={label} onClick={onClick} className={`pressable grid size-11 flex-none place-items-center rounded-full type-label-l transition-colors duration-150 ${on ? "bg-primary text-on-primary" : "bg-surface-high text-on-surface"}`}>
      {children}
    </button>
  );
}

/** Add or change a regular spot: "every Monday 9 PM at Bloom". `value` is the draft (a new rule, or an existing one to edit). */
export function RegularEditor({ value, onClose, today }: { value: RegularSpot | null; onClose: () => void; today: string }) {
  const store = useAsks();
  const roster = useRoster();
  const [draft, setDraft] = useState<RegularSpot | null>(null);
  const [last, setLast] = useState<RegularSpot | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (value !== last) {
    setLast(value);
    if (value) {
      setDraft(structuredClone(value));
      setProblems([]);
    }
  }
  if (!value || !draft) return <Sheet open={false} onClose={onClose} title="" children={null} />;
  const isNew = !store.regulars.some((r) => r.id === value.id);
  const set = (patch: Partial<RegularSpot>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const room = roster.rooms.find((r) => r.id === draft.roomId);
  const roomValue = room ? room.id : draft.roomName ? OTHER : "";
  const multi = draft.cadence === "custom";
  const days = draft.weekdays.length ? draft.weekdays : [weekdayOf(draft.startDate)];
  const nth = draft.nth?.length ? draft.nth : [nthWeekdayOf(draft.startDate)];

  const setCadence = (cadence: RegularCadence) => set({ cadence, weekdays: cadence === "custom" ? days : days.slice(0, 1) });
  const toggleDay = (d: Weekday) => {
    if (!multi) return set({ weekdays: [d] });
    const has = days.includes(d);
    set({ weekdays: has ? days.filter((x) => x !== d) : [...days, d] });
  };
  const toggleNth = (n: number) => set({ nth: nth.includes(n) ? (nth.length > 1 ? nth.filter((x) => x !== n) : nth) : [...nth, n] });

  const save = async () => {
    const roomName = draft.roomName.trim();
    const rule: RegularSpot = { ...draft, roomName, weekdays: days, ...(draft.cadence === "monthly" ? { nth } : { nth: undefined }) };
    const list = validateRegular(rule);
    setProblems(list);
    if (list.length) return;
    setSaving(true);
    try {
      await store.saveRegular(JSON.parse(JSON.stringify(rule)) as RegularSpot);
      toast.success(isNew ? "Regular added. It's on your calendar." : "Regular saved.");
      onClose();
    } catch {
      toast.error("Couldn't save that. Try again.");
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    await store.deleteRegular(draft.id);
    toast("Regular removed. Spots you already marked stay.");
    setConfirmDelete(false);
    onClose();
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={isNew ? "Add a regular" : draft.roomName || "Regular"}
      footer={
        <>
          {!isNew && <Button variant="text" icon={IconTrash} onClick={() => setConfirmDelete(true)}>Remove</Button>}
          <Button loading={saving} onClick={() => void save()}>{isNew ? "Add regular" : "Save"}</Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-6">
        {problems.length > 0 && (
          <Notice tone="error" title="Fix this to save">
            <ul className="list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </Notice>
        )}
        <Card tone="high" className="type-title-s" >
          <p aria-live="polite">
            {regularLabel({ ...draft, weekdays: days, nth }, DAY_NAMES)}
            {draft.time ? `, ${draft.time}` : ""}
          </p>
        </Card>

        <Field label="Room">
          <Select
            value={roomValue}
            placeholder="Pick a room"
            onChange={(v) => {
              if (v === OTHER) return set({ roomId: undefined, showId: undefined, showName: undefined, roomName: roomValue === OTHER ? draft.roomName : "" });
              const r = roster.rooms.find((x) => x.id === v);
              const sh = r?.shows.length === 1 ? r.shows[0] : undefined;
              set({ roomId: v, roomName: r?.name ?? "", showId: sh?.id, showName: sh?.name });
            }}
            options={[...roster.rooms.map((r) => ({ value: r.id, label: `${r.name}${r.area ? `, ${r.area}` : ""}` })), { value: OTHER, label: "Somewhere else" }]}
          />
        </Field>
        {roomValue === OTHER && (
          <Field label="Room name">
            <TextInput value={draft.roomName} onChange={(e) => set({ roomName: e.target.value })} placeholder="Where is it?" />
          </Field>
        )}
        {room && room.shows.length > 0 ? (
          <Field label="Show">
            <Select
              value={draft.showId ?? ""}
              placeholder="Which show (optional)"
              onChange={(v) => {
                const sh = room.shows.find((x) => x.id === v);
                set({ showId: sh?.id, showName: sh?.name, ...(sh && !draft.time && sh.times[0] ? { time: sh.times[0] } : {}) });
              }}
              options={room.shows.map((s) => ({ value: s.id, label: s.name }))}
            />
          </Field>
        ) : (
          <Field label="Show or mic name" hint="Optional">
            <TextInput value={draft.showName ?? ""} onChange={(e) => set({ showName: e.target.value || undefined })} placeholder="Mic name" />
          </Field>
        )}

        <Field label="How often">
          <Segmented full size="sm" value={draft.cadence} onChange={setCadence} options={[{ value: "weekly", label: "Weekly" }, { value: "biweekly", label: "Biweekly" }, { value: "monthly", label: "Monthly" }, { value: "custom", label: "Custom" }]} />
        </Field>
        <Field label={multi ? "On these days" : "On"}>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Weekday">
            {ORDER.map((d) => (
              <Round key={d} on={days.includes(d)} label={DAY_NAMES[d]} onClick={() => toggleDay(d)}>{DAY_NAMES[d].slice(0, 1)}</Round>
            ))}
          </div>
        </Field>
        {draft.cadence === "monthly" && (
          <Field label="Which one in the month">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Which one">
              {NTHS.map((n) => (
                <button key={n} type="button" role="checkbox" aria-checked={nth.includes(n)} onClick={() => toggleNth(n)} className={`pressable h-11 min-w-14 rounded-full px-4 type-label-l transition-colors duration-150 ${nth.includes(n) ? "bg-primary text-on-primary" : "bg-surface-high text-on-surface"}`}>
                  {n === -1 ? "Last" : NTH_LABEL[n]}
                </button>
              ))}
            </div>
          </Field>
        )}

        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
          <Field label="Starting" htmlFor="reg-start" hint={draft.cadence === "biweekly" ? "Counts the weeks from here" : undefined}>
            <TextInput id="reg-start" type="date" value={draft.startDate} onChange={(e) => set({ startDate: e.target.value })} />
          </Field>
          <div className="flex min-w-0 flex-col gap-2">
            <ToggleRow label="Ends on a date" checked={Boolean(draft.endDate)} onChange={(on) => set({ endDate: on ? (draft.endDate ?? today) : undefined })} />
            {draft.endDate !== undefined && <TextInput aria-label="End date" type="date" value={draft.endDate} onChange={(e) => set({ endDate: e.target.value })} />}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <ToggleRow label="Start time" checked={Boolean(draft.time)} onChange={(on) => set({ time: on ? "21:00" : undefined })} />
          {draft.time && <TimePicker label="Start time" value={draft.time} onChange={(time) => set({ time })} />}
        </div>
        <Field label="Notes" hint="Optional">
          <TextArea rows={2} value={draft.notes ?? ""} onChange={(e) => set({ notes: e.target.value || undefined })} placeholder="Sign up on the day, who runs it, parking" />
        </Field>

        {(draft.skipped?.length ?? 0) > 0 && (
          <div className="flex min-w-0 flex-col gap-2">
            <SectionHeader title="Skipped dates" />
            <ul className="flex flex-wrap gap-2">
              {draft.skipped!.filter((d) => d >= today).concat(draft.skipped!.filter((d) => d < today)).map((d) => (
                <li key={d}>
                  <button type="button" onClick={() => set({ skipped: draft.skipped!.filter((x) => x !== d) })} className="state-layer pressable h-11 rounded-full bg-surface-high px-4 type-label-l" aria-label={`Put ${spotDateLabel(d)} back`}>
                    {spotDateLabel(d)} · put back
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Remove this regular?" confirmLabel="Remove" onConfirm={remove}>
        It goes off your calendar. Dates you already marked as done keep their notes and stay in your stats.
      </ConfirmDialog>
    </Sheet>
  );
}
