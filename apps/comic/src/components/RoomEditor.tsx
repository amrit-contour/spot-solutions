import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { SUGGESTED_TAGS, showSummary, type Room, type RoomShow } from "@spot/shared";
import { Button, Chip, ConfirmDialog, Field, IconAdd, IconPen, IconTrash, Sheet, TextArea, TextInput } from "@spot/ui";
import { useRoster, plain } from "../lib/roster";
import { blankShow, newRoomIdFor, validateRoom, validateShow } from "../lib/rooms";
import { LimitsEditor } from "./LimitsEditor";
import { NotesEditor } from "./NotesEditor";
import { PinPicker } from "./PinPicker";
import { Section, ShowForm } from "./ShowEditor";

const TAG_LABEL = (t: string) => t.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

/** Errors as a list the comic can act on. */
function Problems({ list }: { list: string[] }) {
  if (!list.length) return null;
  return (
    <div role="alert" className="rounded-md bg-error-container p-4 text-on-error-container">
      <p className="type-title-s">Fix this to save</p>
      <ul className="mt-1 list-disc pl-5 type-body-m">
        {list.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </div>
  );
}

/** Add or edit a room. A show opens inside the same panel (a Done button brings you back), so there's only ever one dialog. */
export function RoomEditor({ value, onClose }: { value: Room | null; onClose: () => void }) {
  const store = useRoster();
  const [draft, setDraft] = useState<Room | null>(null);
  const [initial, setInitial] = useState("");
  const [aliasText, setAliasText] = useState("");
  const [tagText, setTagText] = useState("");
  const [editingShow, setEditingShow] = useState<RoomShow | null>(null);
  const [isNewShow, setIsNewShow] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Take a fresh copy each time the editor opens on a room (or a blank one).
  const [last, setLast] = useState<Room | null>(null);
  if (value !== last) {
    setLast(value);
    if (value) {
      const copy = plain(value);
      setDraft(copy);
      setInitial(JSON.stringify(copy));
      setAliasText(copy.aliases.join(", "));
      setTagText("");
      setEditingShow(null);
      setProblems([]);
    }
  }
  const isNew = value !== null && !store.rooms.some((r) => r.id === value.id);

  useEffect(() => {
    // The body scrolls inside the panel: start each view at the top.
    document.querySelector<HTMLElement>("[role=dialog] .overflow-y-auto")?.scrollTo(0, 0);
  }, [editingShow === null]);

  const current = useMemo(() => (draft ? { ...draft, aliases: aliasText.split(",").map((a) => a.trim()).filter(Boolean) } : null), [draft, aliasText]);
  if (!value || !draft || !current) return <Sheet open={false} onClose={onClose} title="" children={null} />;

  const set = (patch: Partial<Room>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const dirty = JSON.stringify({ ...current, aliases: current.aliases }) !== initial && JSON.stringify(current) !== initial;
  const close = () => {
    if (editingShow) return setEditingShow(null);
    if (dirty && !window.confirm("Close without saving your changes?")) return;
    onClose();
  };

  const tags = current.tags;
  const toggleTag = (t: string) => set({ tags: tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t] });
  const addTag = () => {
    const t = tagText.trim().toLowerCase().replace(/\s+/g, "-");
    if (t && !tags.includes(t)) set({ tags: [...tags, t] });
    setTagText("");
  };
  const customTags = tags.filter((t) => !(SUGGESTED_TAGS as readonly string[]).includes(t));

  const save = async () => {
    const id = isNew ? newRoomIdFor(current.name, current.area, store.rooms.map((r) => r.id)) : current.id;
    const room: Room = { ...current, id, name: current.name.trim(), area: current.area.trim(), city: current.city.trim(), brand: current.brand?.trim() || undefined, myNotes: current.myNotes?.trim() || undefined };
    const list = validateRoom(room, store.rooms);
    setProblems(list);
    if (list.length) return toast.error(list[0]);
    setSaving(true);
    try {
      await store.saveRoom(room);
      toast.success(isNew ? `Added ${room.name}` : "Saved");
      onClose();
    } catch {
      toast.error("Couldn't save. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  const doneShow = () => {
    if (!editingShow) return;
    const list = validateShow(editingShow);
    if (list.length) {
      setProblems(list);
      return toast.error(list[0]);
    }
    setProblems([]);
    const exists = draft.shows.some((s) => s.id === editingShow.id);
    set({ shows: exists ? draft.shows.map((s) => (s.id === editingShow.id ? editingShow : s)) : [...draft.shows, editingShow] });
    setEditingShow(null);
  };
  const removeShow = () => {
    if (!editingShow) return;
    set({ shows: draft.shows.filter((s) => s.id !== editingShow.id), limits: draft.limits.filter((l) => l.showId !== editingShow.id) });
    setEditingShow(null);
  };

  const footer = editingShow ? (
    <>
      {!isNewShow && (
        <Button variant="text" icon={IconTrash} onClick={removeShow} className="mr-auto text-error">
          Remove show
        </Button>
      )}
      <Button variant="text" onClick={() => setEditingShow(null)}>Cancel</Button>
      <Button onClick={doneShow}>Done</Button>
    </>
  ) : (
    <>
      {!isNew && (
        <Button variant="text" icon={IconTrash} onClick={() => setConfirmDelete(true)} className="mr-auto text-error">
          Delete
        </Button>
      )}
      <Button variant="text" onClick={close}>Cancel</Button>
      <Button onClick={() => void save()} loading={saving}>Save</Button>
    </>
  );

  return (
    <>
      <Sheet open onClose={close} wide title={editingShow ? (isNewShow ? "New show" : `Edit ${editingShow.name || "show"}`) : isNew ? "Add a room" : current.name || "Edit room"} footer={footer}>
        {editingShow ? (
          <div className="flex min-w-0 flex-col gap-6">
            <ShowForm show={editingShow} onChange={setEditingShow} />
            <Problems list={problems} />
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-10">
            <Section title="The room">
              <Field label="Name">
                <TextInput value={current.name} onChange={(e) => set({ name: e.target.value })} placeholder="Bloom Indiranagar" autoFocus={isNew} />
              </Field>
              <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
                <Field label="Area">
                  <TextInput value={current.area} onChange={(e) => set({ area: e.target.value })} placeholder="Indiranagar" />
                </Field>
                <Field label="City">
                  <TextInput value={current.city} onChange={(e) => set({ city: e.target.value })} placeholder="Bengaluru" />
                </Field>
              </div>
              <Field label="Other names (optional)" hint="Separate with commas. Helps match what people call it in group chats.">
                <TextInput value={aliasText} onChange={(e) => setAliasText(e.target.value)} placeholder="Bloom Brewery, Bloom Indy" />
              </Field>
              <Field label="Chain (optional)" hint="Shared by the locations of one chain, like Comedy Theatre. Each location is its own room.">
                <TextInput value={current.brand ?? ""} onChange={(e) => set({ brand: e.target.value || undefined })} placeholder="Comedy Theatre" />
              </Field>
            </Section>

            <Section title="Shows" hint="A room can run several: a mic, a show, or both, on different days and times.">
              {draft.shows.map((s) => (
                <button key={s.id} onClick={() => { setIsNewShow(false); setEditingShow(plain(s)); }} className="state-layer pressable flex min-w-0 items-center gap-3 rounded-lg bg-surface-low p-4 text-left">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate type-title-s">{showSummary(s)}</span>
                    <span className="mt-0.5 block truncate type-body-s text-on-surface-variant">
                      {s.days.filter((d) => d.curatorIds.length).length} of {s.days.length} days have a curator
                      {s.myRole ? ` · you ${s.myRole === "curator" ? "curate it" : "are a regular"}` : ""}
                    </span>
                  </span>
                  <IconPen className="icon size-5 flex-none text-on-surface-variant" />
                </button>
              ))}
              <div>
                <Button variant="tonal" icon={IconAdd} onClick={() => { setIsNewShow(true); setEditingShow(blankShow(draft.shows)); }}>
                  Add a show
                </Button>
              </div>
            </Section>

            <Section title="Map pin" hint="Optional. Used when a message sends the venue's location.">
              <PinPicker pin={draft.pin} onChange={(pin) => set({ pin })} near={current.area || current.city} />
            </Section>

            <Section title="Tags" hint="Pills on the card. They never block an ask.">
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTED_TAGS.map((t) => (
                  <Chip key={t} selected={tags.includes(t)} onClick={() => toggleTag(t)} className="h-8">
                    {TAG_LABEL(t)}
                  </Chip>
                ))}
                {customTags.map((t) => (
                  <Chip key={t} selected onClick={() => toggleTag(t)} className="h-8" title="Tap to remove">
                    {TAG_LABEL(t)}
                  </Chip>
                ))}
              </div>
              <div className="flex min-w-0 gap-2">
                <TextInput value={tagText} onChange={(e) => setTagText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addTag())} placeholder="Add your own tag" maxLength={30} className="min-w-0 flex-1" />
                <Button variant="tonal" onClick={addTag} disabled={!tagText.trim()} className="h-12">Add</Button>
              </div>
            </Section>

            <Section title="Other ways to ask" hint="Instagram, a website, walk-in, BookMyShow. These are notes, not messages the app sends.">
              <NotesEditor notes={draft.notes} onChange={(notes) => set({ notes })} />
            </Section>

            <Section title="Limits" hint="The only rule the app enforces. Leave empty for no limit.">
              <LimitsEditor limits={draft.limits} shows={draft.shows} onChange={(limits) => set({ limits })} />
            </Section>

            <Section title="Just for you">
              <Field label="Paused until (optional)" hint="A seasonal break for the whole room.">
                <TextInput type="date" value={draft.pausedUntil ?? ""} onChange={(e) => set({ pausedUntil: e.target.value || undefined })} />
              </Field>
              <Field label="Notes (only you see these)">
                <TextArea value={draft.myNotes ?? ""} onChange={(e) => set({ myNotes: e.target.value || undefined })} className="min-h-20" placeholder="Ask nicely, they remember" />
              </Field>
            </Section>

            <Problems list={problems} />
          </div>
        )}
      </Sheet>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${draft.name || "this room"}?`}
        confirmLabel="Delete room"
        onConfirm={async () => {
          await store.deleteRoom(draft.id);
          toast(`Deleted ${draft.name}`);
          setConfirmDelete(false);
          onClose();
        }}
      >
        It leaves your rooms along with its shows. Curators stay in your list.
      </ConfirmDialog>
    </>
  );
}
