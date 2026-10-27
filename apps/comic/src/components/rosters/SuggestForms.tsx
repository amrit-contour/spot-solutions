// The small forms behind "Suggest a change". Each one holds its own state and reports a draft (or null while it is not ready).
import { useEffect, useMemo, useState } from "react";
import {
  DAY_NAMES, DAY_SHORT, SUGGESTED_TAGS, WEEK_ORDER, currentValue, dayProposalOf, slug, suggestAddRoom, suggestAddShow, suggestCurator, suggestDay, suggestRemoveRoom, suggestRemoveShow,
  suggestRoomField, suggestShowField, type AskRule, type CuratorShared, type DayProposal, type RoomShared, type RoomField, type ShowField, type ShowShared, type SharedRoster,
  type SuggestionDraft, type Weekday,
} from "@spot/shared";
import { Button, Chip, Field, IconPlus, IconButton, IconClose, Segmented, Select, TextInput, TimePicker } from "@spot/ui";
import { Card, ToggleRow } from "../ui";
import { AskRuleEditor } from "../AskRuleEditor";
import { LimitsEditor } from "../LimitsEditor";
import { NotesEditor } from "../NotesEditor";

export type OnDraft = (d: SuggestionDraft | null) => void;
const TAG_LABEL = (t: string) => t.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function Times({ times, onChange, label }: { times: string[]; onChange: (t: string[]) => void; label: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {times.map((t, i) => (
        <div key={i} className="flex min-w-0 items-center gap-2">
          <TimePicker label={`${label} ${i + 1}`} wrapperClassName="min-w-0 flex-1" value={t} onChange={(v) => onChange(times.map((x, j) => (j === i ? v : x)))} />
          <IconButton icon={IconClose} label="Remove this time" onClick={() => onChange(times.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div>
        <Button variant="tonal" size="sm" icon={IconPlus} onClick={() => onChange([...times, times.length ? "22:00" : "21:00"])}>Add a time</Button>
      </div>
    </div>
  );
}

const SwitchRow = ToggleRow;

const showOptions = (room: RoomShared) => room.shows.map((s) => ({ value: s.id, label: s.name || "Show" }));

// ---------------------------------------------------------------------------------------------------------------------------

const ROOM_FIELDS: { value: RoomField; label: string }[] = [
  { value: "name", label: "Name" }, { value: "area", label: "Area" }, { value: "city", label: "City" }, { value: "aliases", label: "Other names" },
  { value: "tags", label: "Tags" }, { value: "notes", label: "Other ways to ask" }, { value: "limits", label: "Limits" },
];

/** A detail of the room itself. */
export function RoomFieldForm({ roster, room, onDraft }: { roster: SharedRoster; room: RoomShared; onDraft: OnDraft }) {
  const [field, setField] = useState<RoomField>("name");
  const initial = (f: RoomField): unknown => (room as unknown as Record<string, unknown>)[f];
  const [value, setValue] = useState<unknown>(initial("name"));
  const [tagText, setTagText] = useState("");
  const pick = (f: RoomField) => {
    setField(f);
    setValue(f === "aliases" ? room.aliases.join(", ") : initial(f));
  };
  useEffect(() => {
    const after = field === "aliases" ? String(value ?? "").split(",").map((a) => a.trim()).filter(Boolean) : typeof value === "string" ? value.trim() : value;
    const ok = !["name", "area", "city"].includes(field) || (typeof after === "string" && after.length > 0);
    onDraft(ok && !sameJson(after, initial(field)) ? suggestRoomField(roster, room.id, field, after) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field, value]);

  const tags = (value as string[]) ?? [];
  const toggle = (t: string) => setValue(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]);
  const custom = tags.filter((t) => !(SUGGESTED_TAGS as readonly string[]).includes(t));
  const addTag = () => {
    const t = tagText.trim().toLowerCase().replace(/\s+/g, "-");
    if (t && !tags.includes(t)) setValue([...tags, t]);
    setTagText("");
  };
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Select label="What to change" value={field} onChange={(f) => pick(f as RoomField)} options={ROOM_FIELDS} />
      {["name", "area", "city"].includes(field) && <Field label={ROOM_FIELDS.find((f) => f.value === field)!.label}><TextInput value={String(value ?? "")} onChange={(e) => setValue(e.target.value)} /></Field>}
      {field === "aliases" && <Field label="Other names" hint="Separate with commas."><TextInput value={String(value ?? "")} onChange={(e) => setValue(e.target.value)} placeholder="Bloom Brewery, Bloom Indy" /></Field>}
      {field === "tags" && (
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTED_TAGS.map((t) => <Chip key={t} selected={tags.includes(t)} onClick={() => toggle(t)} className="h-11">{TAG_LABEL(t)}</Chip>)}
            {custom.map((t) => <Chip key={t} selected onClick={() => toggle(t)} className="h-11" title="Tap to remove">{TAG_LABEL(t)}</Chip>)}
          </div>
          <div className="flex min-w-0 gap-2">
            <TextInput value={tagText} onChange={(e) => setTagText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addTag())} placeholder="Add your own tag" maxLength={30} className="min-w-0 flex-1" />
            <Button variant="tonal" onClick={addTag} disabled={!tagText.trim()} className="h-12">Add</Button>
          </div>
        </div>
      )}
      {field === "notes" && <NotesEditor notes={(value as RoomShared["notes"]) ?? []} onChange={setValue} />}
      {field === "limits" && <LimitsEditor limits={(value as RoomShared["limits"]) ?? []} shows={room.shows} onChange={setValue} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------

const SHOW_FIELDS: { value: ShowField; label: string }[] = [
  { value: "times", label: "Start times" }, { value: "askRule", label: "When to ask" }, { value: "name", label: "Name" },
  { value: "type", label: "What it is" }, { value: "cadence", label: "How often" }, { value: "note", label: "Note" },
];

/** A detail of one show. */
export function ShowFieldForm({ roster, room, onDraft }: { roster: SharedRoster; room: RoomShared; onDraft: OnDraft }) {
  const [showId, setShowId] = useState(room.shows[0]?.id ?? "");
  const show = room.shows.find((s) => s.id === showId);
  const [field, setField] = useState<ShowField>("times");
  const read = (s: ShowShared | undefined, f: ShowField): unknown => (s as unknown as Record<string, unknown> | undefined)?.[f];
  const [value, setValue] = useState<unknown>(read(show, "times"));
  const reset = (s: ShowShared | undefined, f: ShowField) => setValue(read(s, f));
  useEffect(() => {
    const after = typeof value === "string" ? value.trim() : value;
    const ok = show && (field !== "name" || (typeof after === "string" && after.length > 0)) && (field !== "times" || (Array.isArray(after) && after.length > 0));
    onDraft(ok && !sameJson(after, read(show, field)) ? suggestShowField(roster, room.id, showId, field, after) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showId, field, value]);
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {room.shows.length > 1 && <Select label="Which show" value={showId} onChange={(id) => { setShowId(id); reset(room.shows.find((s) => s.id === id), field); }} options={showOptions(room)} />}
      <Select label="What to change" value={field} onChange={(f) => { setField(f as ShowField); reset(show, f as ShowField); }} options={SHOW_FIELDS} />
      {field === "times" && <Times label="Start time" times={(value as string[]) ?? []} onChange={setValue} />}
      {field === "askRule" && <AskRuleEditor value={value as AskRule | undefined} onChange={setValue} />}
      {(field === "name" || field === "note") && <Field label={field === "name" ? "Name" : "Note"}><TextInput value={String(value ?? "")} onChange={(e) => setValue(e.target.value)} /></Field>}
      {field === "type" && <Segmented full value={String(value ?? "mic")} onChange={setValue} options={[{ value: "mic", label: "Mic" }, { value: "show", label: "Show" }, { value: "both", label: "Both" }]} />}
      {field === "cadence" && <Segmented full value={String(value ?? "weekly")} onChange={setValue} options={[{ value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }]} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------

type Person = { name: string; phone: string; instagram?: string };

function People({ people, onChange }: { people: Person[]; onChange: (p: Person[]) => void }) {
  const set = (i: number, patch: Partial<Person>) => onChange(people.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {people.map((p, i) => (
        <Card key={i} tone="high" className="flex min-w-0 items-start gap-2 p-3">
          <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
            <Field label={i === 0 ? "Who to ask" : "Co-curator"}><TextInput value={p.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="Vishal" autoComplete="off" /></Field>
            <Field label="Their number (optional)"><TextInput value={p.phone} onChange={(e) => set(i, { phone: e.target.value })} placeholder="+91 98765 43210" inputMode="tel" autoComplete="off" /></Field>
          </div>
          <IconButton icon={IconClose} label="Remove this curator" onClick={() => onChange(people.filter((_, j) => j !== i))} />
        </Card>
      ))}
      <div>
        <Button variant="tonal" size="sm" icon={IconPlus} onClick={() => onChange([...people, { name: "", phone: "" }])}>{people.length ? "Add a co-curator" : "Add a curator"}</Button>
      </div>
    </div>
  );
}
const toProposalCurators = (people: Person[]) => people.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim(), ...(p.phone.trim() ? { phone: p.phone.trim() } : {}), ...(p.instagram ? { instagram: p.instagram } : {}) }));

/** Who is on one day of a show. */
export function DayForm({ roster, room, onDraft }: { roster: SharedRoster; room: RoomShared; onDraft: OnDraft }) {
  const [showId, setShowId] = useState(room.shows[0]?.id ?? "");
  const show = room.shows.find((s) => s.id === showId);
  const [wd, setWd] = useState<Weekday>(show?.days[0]?.weekday ?? 1);
  const day = show?.days.find((d) => d.weekday === wd);
  const load = (s: ShowShared | undefined, w: Weekday) => {
    const d = s?.days.find((x) => x.weekday === w);
    const p = d ? dayProposalOf(roster, d) : null;
    return {
      people: (p?.curators ?? []).map((c) => ({ name: c.name, phone: c.phone ?? "", instagram: c.instagram })) as Person[],
      reach: Boolean(p?.theyReachOut), times: p?.times ?? [], note: p?.note ?? "", runs: Boolean(d),
    };
  };
  const [st, setSt] = useState(() => load(show, wd));
  const [runs, setRuns] = useState(true);
  useEffect(() => {
    if (!show) return onDraft(null);
    if (!runs) return onDraft(day ? suggestDay(roster, room.id, showId, wd, null) : null);
    const after: DayProposal = {
      curators: toProposalCurators(st.people),
      ...(st.reach ? { theyReachOut: true } : {}),
      ...(st.times.length ? { times: st.times } : {}),
      ...(st.note.trim() ? { note: st.note.trim() } : {}),
      ...(day?.askRule ? { askRule: day.askRule } : {}),
    };
    if (!after.theyReachOut && after.curators.length === 0) return onDraft(null);
    const before = currentValue(roster, { roomId: room.id, showId, field: `days.${wd}` });
    onDraft(sameJson(before, after) ? null : suggestDay(roster, room.id, showId, wd, after));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showId, wd, st, runs]);
  const change = (s: ShowShared | undefined, w: Weekday) => {
    setSt(load(s, w));
    setRuns(true);
  };
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {room.shows.length > 1 && <Select label="Which show" value={showId} onChange={(id) => { setShowId(id); change(room.shows.find((s) => s.id === id), wd); }} options={showOptions(room)} />}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Which day">
        {WEEK_ORDER.map((d) => (
          <Chip key={d} selected={wd === d} onClick={() => { setWd(d); change(show, d); }} className="h-11 min-w-12 justify-center" title={DAY_NAMES[d]}>
            {DAY_SHORT[d]}
          </Chip>
        ))}
      </div>
      <p className="type-body-s text-on-surface-variant">
        {day ? `${DAY_NAMES[wd]} is listed now. Change who is on it below.` : `${show?.name ?? "This show"} doesn't list ${DAY_NAMES[wd]}. Fill this in to suggest adding it.`}
      </p>
      {day && <SwitchRow label={`The show doesn't run on ${DAY_NAMES[wd]} any more`} checked={!runs} onChange={(v) => setRuns(!v)} />}
      {runs && (
        <>
          <SwitchRow label="They'll reach out (nothing to ask)" checked={st.reach} onChange={(reach) => setSt({ ...st, reach })} />
          <People people={st.people} onChange={(people) => setSt({ ...st, people })} />
          <Field label="Different start times this day (optional)"><Times label="Start time" times={st.times} onChange={(times) => setSt({ ...st, times })} /></Field>
          <Field label="Note for this day (optional)"><TextInput value={st.note} onChange={(e) => setSt({ ...st, note: e.target.value })} placeholder="Weekends start at 5:30 PM" /></Field>
        </>
      )}
    </div>
  );
}

/** A curator's number or Instagram, for any curator on this room. */
export function CuratorFieldForm({ roster, room, onDraft }: { roster: SharedRoster; room: RoomShared; onDraft: OnDraft }) {
  const used = useMemo(() => {
    const ids = new Set(room.shows.flatMap((s) => s.days.flatMap((d) => d.curatorIds)));
    return roster.curators.filter((c) => ids.has(c.id));
  }, [roster.curators, room.shows]);
  const [cid, setCid] = useState(used[0]?.id ?? "");
  const [field, setField] = useState<"phone" | "instagram">("phone");
  const cur = used.find((c) => c.id === cid);
  const [value, setValue] = useState(cur?.phone ?? "");
  useEffect(() => {
    const v = value.trim();
    onDraft(cur && v && v !== (cur[field] ?? "") ? suggestCurator(roster, room.id, cid, field, v) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, field, value]);
  if (used.length === 0) return <p className="type-body-m text-on-surface-variant">No curators are listed for this room yet. Suggest who is on a day instead.</p>;
  const read = (c: CuratorShared | undefined, f: "phone" | "instagram") => c?.[f] ?? "";
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Select label="Which curator" value={cid} onChange={(id) => { setCid(id); setValue(read(used.find((c) => c.id === id), field)); }} options={used.map((c) => ({ value: c.id, label: c.name }))} />
      <Segmented full value={field} onChange={(f) => { setField(f); setValue(read(cur, f)); }} options={[{ value: "phone", label: "Number" }, { value: "instagram", label: "Instagram" }]} />
      <Field label={field === "phone" ? "New number" : "New handle"} hint={field === "instagram" ? "Without the @." : undefined}>
        <TextInput value={value} onChange={(e) => setValue(field === "instagram" ? e.target.value.replace(/^@/, "") : e.target.value)} inputMode={field === "phone" ? "tel" : "text"} autoCapitalize="none" autoComplete="off" />
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------

export interface NewShow {
  show: ShowShared;
  curators: CuratorShared[];
}

/** A whole new show: name, kind, days, times, when to ask and one curator for every day. Reports null until it has what it needs. */
export function NewShowFields({ taken, onChange }: { taken: string[]; onChange: (s: NewShow | null) => void }) {
  const [name, setName] = useState("Mic");
  const [type, setType] = useState<ShowShared["type"]>("mic");
  const [cadence, setCadence] = useState<ShowShared["cadence"]>("weekly");
  const [days, setDays] = useState<Weekday[]>([]);
  const [times, setTimes] = useState<string[]>(["21:00"]);
  const [rule, setRule] = useState<AskRule | undefined>();
  const [who, setWho] = useState<Person[]>([{ name: "", phone: "" }]);
  useEffect(() => {
    if (!name.trim() || days.length === 0) return onChange(null);
    let id = slug(name) || "show";
    for (let n = 2; taken.includes(id); n++) id = `${slug(name) || "show"}-${n}`;
    const people = toProposalCurators(who);
    const curators: CuratorShared[] = people.map((p) => ({ id: slug(p.name) || "curator", ...p }));
    const show: ShowShared = {
      id, name: name.trim(), type, cadence, times,
      days: WEEK_ORDER.filter((d) => days.includes(d)).map((weekday) => ({ weekday, curatorIds: curators.map((c) => c.id) })),
      ...(rule ? { askRule: rule } : {}),
      ...(cadence === "monthly" ? { monthlyWeeks: [1] } : {}),
    };
    onChange({ show, curators });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, type, cadence, days, times, rule, who]);
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Field label="Show name"><TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Mic" /></Field>
      <Segmented full value={type} onChange={setType} options={[{ value: "mic", label: "Mic" }, { value: "show", label: "Show" }, { value: "both", label: "Both" }]} />
      <Segmented full value={cadence} onChange={setCadence} options={[{ value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }]} />
      <Field label="Days it runs">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
          {WEEK_ORDER.map((d) => (
            <Chip key={d} selected={days.includes(d)} onClick={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d])} className="h-11 min-w-12 justify-center" title={DAY_NAMES[d]}>{DAY_SHORT[d]}</Chip>
          ))}
        </div>
      </Field>
      <Field label="Start times"><Times label="Start time" times={times} onChange={setTimes} /></Field>
      <AskRuleEditor value={rule} onChange={setRule} />
      <Field label="Who to ask (every day)" hint="Different people on different days? Suggest the first, and add the rest as day changes after."><People people={who} onChange={setWho} /></Field>
    </div>
  );
}

export function AddShowForm({ room, onDraft }: { room: RoomShared; onDraft: OnDraft }) {
  return <NewShowFields taken={room.shows.map((s) => s.id)} onChange={(s) => onDraft(s ? suggestAddShow(room.id, s) : null)} />;
}

export function RemoveShowForm({ roster, room, onDraft }: { roster: SharedRoster; room: RoomShared; onDraft: OnDraft }) {
  const [showId, setShowId] = useState(room.shows[0]?.id ?? "");
  useEffect(() => onDraft(showId ? suggestRemoveShow(roster, room.id, showId) : null), [showId]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Select label="Which show is gone" value={showId} onChange={setShowId} options={showOptions(room)} />;
}

export function RemoveRoomForm({ roster, room, onDraft }: { roster: SharedRoster; room: RoomShared; onDraft: OnDraft }) {
  useEffect(() => onDraft(suggestRemoveRoom(roster, room.id)), []); // eslint-disable-line react-hooks/exhaustive-deps
  return <p className="type-body-l text-on-surface-variant">The maintainers will be asked to take {room.name} out of the roster. Say why below, for example that it has closed.</p>;
}

/** A room that isn't in the roster yet. */
export function AddRoomForm({ defaultCity, onDraft }: { defaultCity: string; onDraft: OnDraft }) {
  const [name, setName] = useState("");
  const [area, setArea] = useState("");
  const [city, setCity] = useState(defaultCity);
  const [show, setShow] = useState<NewShow | null>(null);
  useEffect(() => {
    if (!name.trim() || !city.trim() || !show) return onDraft(null);
    const id = slug(`${name} ${area}`) || "room";
    onDraft(suggestAddRoom({ room: { id, name: name.trim(), area: area.trim(), city: city.trim(), aliases: [], tags: [], notes: [], limits: [], shows: [show.show] }, curators: show.curators }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, area, city, show]);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Field label="Room name"><TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Bloom Indiranagar" /></Field>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
        <Field label="Area"><TextInput value={area} onChange={(e) => setArea(e.target.value)} placeholder="Indiranagar" /></Field>
        <Field label="City"><TextInput value={city} onChange={(e) => setCity(e.target.value)} /></Field>
      </div>
      <h3 className="type-title-m">Its mic or show</h3>
      <NewShowFields taken={[]} onChange={setShow} />
    </div>
  );
}
