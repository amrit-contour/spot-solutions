import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DAY_NAMES, SPOT_SOURCE_LABEL, formatTime, materializeRegular, mergeRegulars, regularFromSpot, regularLabel, regularWindow, spotClashes, validateSpot, type MySpot, type RegularSpot, type SpotNotes } from "@spot/shared";
import { Button, ConfirmDialog, Field, IconRepeat, IconStar, IconTrash, Segmented, Select, Sheet, TextArea, TextInput, TimePicker } from "@spot/ui";
import { ToggleRow } from "./ui";
import { useAsks } from "../lib/asks";
import { useRoster } from "../lib/roster";
import { newRegularId, useSpotActions } from "../lib/regulars";
import { RegularEditor } from "./calendar/RegularEditor";

const OTHER = "__other";

/** Add a spot by hand, or open one: when and where, whether it happened, and notes on how it went. */
export function SpotEditor({ value, onClose, today }: { value: MySpot | null; onClose: () => void; today: string }) {
  const store = useAsks();
  const roster = useRoster();
  const [draft, setDraft] = useState<MySpot | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [last, setLast] = useState<MySpot | null>(null);
  const [making, setMaking] = useState<RegularSpot | null>(null);
  const act = useSpotActions();
  if (value !== last) {
    setLast(value);
    if (value) {
      setDraft(structuredClone(value));
      setProblems([]);
    }
  }
  // A regular's occurrence is not "new" even before anything is stored for it: saving materialises it.
  const isNew = value !== null && !value.regularId && !store.spots.some((s) => s.id === value.id);
  const clash = useMemo(() => {
    if (!draft) return [];
    const w = regularWindow(draft.date, 0, 0);
    return spotClashes(mergeRegulars(store.spots, store.regulars, w.from, w.to), draft);
  }, [draft, store.spots, store.regulars]);
  if (!value || !draft) return <Sheet open={false} onClose={onClose} title="" children={null} />;

  const set = (patch: Partial<MySpot>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const notes = draft.notes ?? {};
  const setNotes = (patch: Partial<SpotNotes>) => set({ notes: { ...notes, ...patch } });
  const roomValue = draft.roomId && roster.rooms.some((r) => r.id === draft.roomId) ? draft.roomId : draft.roomName ? OTHER : "";
  const past = draft.date <= today;

  const save = async () => {
    const roomName = draft.roomName?.trim() ?? "";
    const list = validateSpot({ date: draft.date, time: draft.time, roomName });
    setProblems(list);
    if (list.length) return;
    setSaving(true);
    try {
      await store.saveSpot({ ...materializeRegular(draft), roomName });
      toast.success(isNew ? "Spot added." : "Spot saved.");
      onClose();
    } catch {
      toast.error("Couldn't save that. Try again.");
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (draft.regularId) await act.skip(draft);
    else await store.deleteSpot(draft.id);
    toast(draft.regularId ? "Skipped that date." : "Spot removed.");
    setConfirmDelete(false);
    onClose();
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={isNew ? "Add a spot" : draft.roomName || "Spot"}
      footer={
        <>
          {!isNew && (
            <Button variant="text" icon={IconTrash} onClick={() => setConfirmDelete(true)}>
              {draft.regularId ? "Skip this date" : "Remove"}
            </Button>
          )}
          <Button loading={saving} onClick={() => void save()}>
            {isNew ? "Add spot" : "Save"}
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-6">
        {problems.length > 0 && (
          <div role="alert" className="rounded-md bg-error-container p-4 text-on-error-container">
            <p className="type-title-s">Fix this to save</p>
            <ul className="mt-1 list-disc pl-5 type-body-m">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
          <Field label="Date" htmlFor="spot-date">
            <TextInput id="spot-date" type="date" disabled={Boolean(draft.regularId)} value={draft.date} onChange={(e) => set({ date: e.target.value })} />
          </Field>
          <div className="flex min-w-0 flex-col gap-2">
            <ToggleRow label="Start time" checked={Boolean(draft.time)} onChange={(on) => set({ time: on ? "20:00" : undefined })} />
            {draft.time && <TimePicker label="Start time" value={draft.time} onChange={(time) => set({ time })} />}
          </div>
        </div>

        <Field label="Room">
          <Select
            value={roomValue}
            placeholder="Pick a room"
            onChange={(v) => {
              if (v === OTHER) return set({ roomId: undefined, showId: undefined, roomName: roomValue === OTHER ? draft.roomName : "" });
              const r = roster.rooms.find((x) => x.id === v);
              set({ roomId: v, roomName: r?.name ?? "", showId: r?.shows[0]?.id });
            }}
            options={[...roster.rooms.map((r) => ({ value: r.id, label: `${r.name}${r.area ? `, ${r.area}` : ""}` })), { value: OTHER, label: "Somewhere else" }]}
          />
        </Field>
        {roomValue === OTHER && (
          <Field label="Room name">
            <TextInput value={draft.roomName ?? ""} onChange={(e) => set({ roomName: e.target.value })} placeholder="Where is it?" />
          </Field>
        )}

        {clash.length > 0 && (
          <p role="status" className="rounded-md bg-error-container px-4 py-3 type-body-m text-on-error-container">
            This is close to another spot: {clash.map((c) => `${c.roomName || "a spot"}${c.time ? ` at ${formatTime(c.time)}` : ""}`).join(", ")}. You may not make both.
          </p>
        )}

        {!isNew && (
          <p className="type-body-m text-on-surface-variant">
            {draft.regularId && store.regulars.find((r) => r.id === draft.regularId) ? `Regular: ${regularLabel(store.regulars.find((r) => r.id === draft.regularId)!, DAY_NAMES)}` : SPOT_SOURCE_LABEL[draft.source]}
          </p>
        )}
        {!isNew && !draft.regularId && draft.status !== "cancelled" && (
          <Button variant="tonal" icon={IconRepeat} onClick={() => setMaking(regularFromSpot(draft, newRegularId(), Date.now()))}>
            Make this a regular
          </Button>
        )}

        {past && (
          <Field label="Did it happen?">
            <Segmented
              full
              value={draft.happened === true ? "yes" : draft.happened === false ? "no" : "unknown"}
              onChange={(v) => set({ happened: v === "yes" ? true : v === "no" ? false : null })}
              options={[
                { value: "unknown", label: "Not marked" },
                { value: "yes", label: "It happened" },
                { value: "no", label: "It didn't" },
              ]}
            />
          </Field>
        )}

        <div className="flex min-w-0 flex-col gap-4">
          <h3 className="type-title-m">How it went</h3>
          <Field label="Your rating">
            <div className="flex items-center gap-1" role="radiogroup" aria-label="Rating">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} role="radio" aria-checked={notes.rating === n} aria-label={`${n} star${n === 1 ? "" : "s"}`} onClick={() => setNotes({ rating: notes.rating === n ? undefined : n })} className="state-layer pressable grid size-11 place-items-center rounded-full">
                  <IconStar className={`icon size-7 ${notes.rating && n <= notes.rating ? "text-primary" : "text-on-surface-variant opacity-40"}`} />
                </button>
              ))}
              {notes.rating ? <span className="ml-1 type-label-l text-on-surface-variant">{notes.rating} of 5</span> : null}
            </div>
          </Field>
          <Field label="The room">
            <TextInput value={notes.room ?? ""} onChange={(e) => setNotes({ room: e.target.value })} placeholder="Sound, stage, lights, how they treat comics" />
          </Field>
          <Field label="The crowd">
            <TextInput value={notes.crowd ?? ""} onChange={(e) => setNotes({ crowd: e.target.value })} placeholder="Size, mood, who was in" />
          </Field>
          <Field label="What worked">
            <TextArea rows={2} value={notes.whatWorked ?? ""} onChange={(e) => setNotes({ whatWorked: e.target.value })} />
          </Field>
          <Field label="What didn't">
            <TextArea rows={2} value={notes.whatDidnt ?? ""} onChange={(e) => setNotes({ whatDidnt: e.target.value })} />
          </Field>
          <Field label="Set list">
            <TextArea rows={4} value={notes.setList ?? ""} onChange={(e) => setNotes({ setList: e.target.value })} placeholder="The bits you did, in order" />
          </Field>
        </div>
      </div>
      <RegularEditor value={making} onClose={() => setMaking(null)} today={today} />
      <ConfirmDialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={draft.regularId ? "Skip this date?" : "Remove this spot?"} confirmLabel={draft.regularId ? "Skip" : "Remove"} onConfirm={remove}>
        {draft.regularId ? "It comes off your calendar for this date only. The regular carries on." : "It goes from your spots and your stats. This can't be undone."}
      </ConfirmDialog>
    </Sheet>
  );
}
