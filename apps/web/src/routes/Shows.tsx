import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { addDoc, deleteDoc, deleteField, setDoc } from "firebase/firestore";
import { motion } from "motion/react";
import { toast } from "sonner";
import { DAY_SHORT, formatTime, groupModeOf, type GroupInfo, type GroupMembersResult, type GroupMode, type Show, type Venue, type Weekday } from "@spot/shared";
import { useApp } from "../lib/app";
import { isDemoUser } from "../lib/demo";
import { runCommand, useCollection, userCol, userDoc } from "../lib/data";
import { PageHeader } from "../components/Shell";
import { Button, Chip, Empty, Field, IconButton, Segmented, Select, Sheet, Stepper, Switch, TextInput, cx } from "../components/ui";
import { IconAdd, IconBuilding, IconClock, IconGroup, IconMap, IconUserPlus, IconPen, IconRefresh, IconStar, IconTrash, IconWarn } from "../components/icons";

const WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 0];

const newShow = (venueId: string): Omit<Show, "id"> => ({
  name: "",
  venueId,
  weekday: 1,
  startTime: "20:00",
  slotCount: 8,
  includeSlotTime: false,
  defaultMinutes: 5,
  active: true,
  groupId: null,
  regulars: [],
  protected: [],
  groupMode: "manual",
});

const GROUP_MODE_LABEL: Record<GroupMode, string> = { manual: "Sync: when I sync", confirm: "Sync: on confirm", show_day: "Sync: show day" };

export function Shows() {
  const { shows, venues } = useApp();
  const [editingShow, setEditingShow] = useState<Partial<Show> | null>(null);
  const [editingVenue, setEditingVenue] = useState<Partial<Venue> | null>(null);
  // The lineup page links here (?edit=showId) to link a group.
  const [params, setParams] = useSearchParams();
  const editId = params.get("edit");
  useEffect(() => {
    const s = editId ? shows.find((x) => x.id === editId) : null;
    if (!s) return;
    setEditingShow(s);
    setParams({}, { replace: true });
  }, [editId, shows, setParams]);

  return (
    <div className="w-full">
      <PageHeader
        title="Shows"
        subtitle="The mics you curate, and where they happen"
        actions={
          <>
            <Button variant="tonal" icon={IconBuilding} onClick={() => setEditingVenue({})}>
              Venue
            </Button>
            <Button icon={IconAdd} onClick={() => (venues.length ? setEditingShow(newShow(venues[0].id)) : setEditingVenue({}))}>
              Show
            </Button>
          </>
        }
      />
      <div className="grid gap-8 px-4 pb-12 sm:px-8">
        {!venues.length ? (
          <Empty icon={IconBuilding} title="Start with a venue" action={<Button icon={IconAdd} onClick={() => setEditingVenue({})}>Add venue</Button>}>
            Where do your mics happen? Add the club first, then its weekly shows.
          </Empty>
        ) : (
          venues.map((v) => {
            const vs = shows.filter((s) => s.venueId === v.id);
            return (
              <section key={v.id}>
                <div className="mb-3 flex items-center gap-3">
                  <span className="grid size-10 place-items-center rounded-md bg-tertiary-container text-on-tertiary-container">
                    <IconBuilding className="icon size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="type-title-l">{v.name}</h2>
                    {v.area && <p className="type-body-s text-on-surface-variant">{v.area}</p>}
                  </div>
                  <IconButton icon={IconPen} label={`Edit ${v.name}`} onClick={() => setEditingVenue(v)} />
                </div>
                <motion.ul className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.04 } } }}>
                  {vs.map((s) => (
                    <motion.li key={s.id} variants={{ hidden: { opacity: 0, transform: "translateY(6px)" }, show: { opacity: 1, transform: "translateY(0px)" } }}>
                      <button onClick={() => setEditingShow(s)} className={cx("state-layer pressable flex w-full items-start gap-4 rounded-lg bg-surface-low p-4 text-left", !s.active && "opacity-60")}>
                        <span className="grid size-14 flex-none place-items-center rounded-md bg-primary-container text-on-primary-container">
                          <span className="type-title-m">{DAY_SHORT[s.weekday]}</span>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate type-title-m">{s.name}</span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 type-body-m text-on-surface-variant">
                            <span className="inline-flex items-center gap-1"><IconClock className="icon size-4" />{formatTime(s.startTime)}</span>
                            <span className="tabular">{s.slotCount} slots{s.includeSlotTime && s.defaultMinutes ? ` · ${s.defaultMinutes} min` : ""}</span>
                          </span>
                          <span className="mt-2 flex flex-wrap gap-1.5">
                            {s.groupId ? <Chip icon={IconGroup}>Group linked</Chip> : <Chip className="border-dashed">No group</Chip>}
                            {s.groupId && <Chip icon={IconClock}>{GROUP_MODE_LABEL[groupModeOf(s)]}</Chip>}
                            {s.regulars?.length ? <Chip tone="tertiary" icon={IconStar}>{s.regulars.length} regular{s.regulars.length > 1 ? "s" : ""}</Chip> : null}
                            {!s.active && <Chip>Paused</Chip>}
                          </span>
                        </span>
                      </button>
                    </motion.li>
                  ))}
                  <li>
                    <button onClick={() => setEditingShow(newShow(v.id))} className="state-layer flex h-full min-h-24 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-outline-variant type-label-l text-on-surface-variant">
                      <IconAdd className="icon size-5" /> Add a show at {v.name}
                    </button>
                  </li>
                </motion.ul>
              </section>
            );
          })
        )}
      </div>
      <ShowEditor value={editingShow} onClose={() => setEditingShow(null)} />
      <VenueEditor value={editingVenue} onClose={() => setEditingVenue(null)} />
    </div>
  );
}

function ShowEditor({ value, onClose }: { value: Partial<Show> | null; onClose: () => void }) {
  const { uid, venues, comics, session } = useApp();
  const groups = useCollection<GroupInfo>(uid, "groups");
  const [draft, setDraft] = useState<Partial<Show>>({});
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [memberIds, setMemberIds] = useState<string[] | null>(null);
  const [lastValue, setLastValue] = useState<Partial<Show> | null>(null);
  if (value !== lastValue) {
    setLastValue(value);
    if (value) setDraft(value);
    setMemberIds(null);
  }
  const set = <K extends keyof Show>(k: K, v: Show[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const group = groups.data.find((g) => g.id === draft.groupId);
  // Shows saved before the choice existed keep updating on confirm; saving writes the choice down.
  const mode = draft.groupMode ?? groupModeOf({ groupId: value?.groupId });

  const refreshGroups = async () => {
    setLoadingGroups(true);
    try {
      const r = await runCommand<{ count: number }>(uid, "list_groups", {}, 120_000);
      toast(`Found ${r.count} groups`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoadingGroups(false);
    }
  };

  const pullMembers = async () => {
    if (!draft.groupId) return;
    setPulling(true);
    try {
      const r = await runCommand<GroupMembersResult>(uid, "pull_group_members", { groupId: draft.groupId }, 10 * 60_000);
      setMemberIds(r.memberIds);
      // Group admins are co-hosts by default. Applied to the draft; Save keeps it.
      if (r.adminIds.length) setDraft((d) => ({ ...d, protected: [...new Set([...(d.protected ?? []), ...r.adminIds])] }));
      toast.success(`${r.total} members, ${r.added} new comic${r.added === 1 ? "" : "s"} added${r.adminIds.length ? `, ${r.adminIds.length} admin${r.adminIds.length === 1 ? "" : "s"} marked protected` : ""}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPulling(false);
    }
  };

  const save = async () => {
    if (!draft.name?.trim()) return toast.error("Give the show a name");
    // groupMembers is the worker's cache of the group: never written back from a possibly stale draft.
    const { id, groupMembers: _cache, ...rest } = draft as Show;
    const data = { ...rest, groupMode: mode };
    // Merge, so a member refresh that landed while this was open isn't wiped. A different group means a different list.
    if (id) await setDoc(userDoc(uid, "shows", id), { ...data, ...(data.groupId !== value?.groupId ? { groupMembers: deleteField() } : {}) }, { merge: true });
    else await addDoc(userCol(uid, "shows"), data);
    onClose();
  };
  const remove = async () => {
    if (draft.id && confirm(`Delete ${draft.name}? Past lineups stay.`)) {
      await deleteDoc(userDoc(uid, "shows", draft.id));
      onClose();
    }
  };
  const toggleIn = (k: "regulars" | "protected", id: string) => {
    const cur = new Set(draft[k] ?? []);
    if (cur.has(id)) cur.delete(id);
    else cur.add(id);
    set(k, [...cur]);
  };

  return (
    <Sheet
      open={Boolean(value)}
      onClose={onClose}
      title={draft.id ? "Edit show" : "New show"}
      wide
      footer={
        <>
          {draft.id && <Button variant="text" icon={IconTrash} onClick={remove} className="mr-auto text-error">Delete</Button>}
          <Button variant="text" onClick={onClose}>Cancel</Button>
          <Button onClick={save}>Save</Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <Field label="Show name">
          <TextInput value={draft.name ?? ""} onChange={(e) => set("name", e.target.value)} placeholder="Monday Mic" autoFocus />
        </Field>
        <Field label="Venue">
          <Select value={draft.venueId ?? ""} onChange={(v) => set("venueId", v)} options={venues.map((v) => ({ value: v.id, label: v.name }))} />
        </Field>
        <Field label="Day">
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((d) => (
              <Chip key={d} selected={draft.weekday === d} onClick={() => set("weekday", d)}>
                {DAY_SHORT[d]}
              </Chip>
            ))}
          </div>
        </Field>
        <div className="grid gap-6 sm:grid-cols-2">
          <Field label="Starts at">
            <TextInput type="time" value={draft.startTime ?? "20:00"} onChange={(e) => set("startTime", e.target.value)} />
          </Field>
          <Field label="Slots">
            <Stepper value={draft.slotCount ?? 8} onChange={(v) => set("slotCount", v)} min={1} max={40} />
          </Field>
        </div>

        <div className="rounded-lg bg-surface-container p-4">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <div className="type-title-s">Mention set length</div>
              <div className="type-body-s text-on-surface-variant">Adds "⏱ 5 min set" to confirmations. Leave off for shows without a fixed limit.</div>
            </div>
            <Switch checked={Boolean(draft.includeSlotTime)} onChange={(v) => set("includeSlotTime", v)} label="Mention set length" />
          </div>
          {draft.includeSlotTime && (
            <div className="mt-4 flex items-center gap-3">
              <span className="type-body-m text-on-surface-variant">Default</span>
              <Stepper value={draft.defaultMinutes ?? 5} onChange={(v) => set("defaultMinutes", v)} min={1} max={30} suffix="min" />
            </div>
          )}
        </div>

        <div className="flex items-center gap-4">
          <div className="flex-1">
            <div className="type-title-s">Active</div>
            <div className="type-body-s text-on-surface-variant">Paused shows are hidden from the lineup board.</div>
          </div>
          <Switch checked={draft.active ?? true} onChange={(v) => set("active", v)} label="Active" />
        </div>

        <section className="border-t border-outline-variant pt-6">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 type-title-m"><IconGroup className="icon size-5 text-primary" /> WhatsApp group</h3>
            <Button size="sm" variant="text" icon={IconRefresh} onClick={refreshGroups} loading={loadingGroups} disabled={session?.status !== "ready"}>
              Refresh
            </Button>
          </div>
          <Select value={draft.groupId ?? ""} onChange={(v) => set("groupId", v || null)} placeholder="No group" options={groups.data.map((g) => ({ value: g.id, label: `${g.name} · ${g.participants}` }))} />
          {group && !group.isAdmin && (
            <p className="mt-2 flex items-center gap-1.5 type-body-s text-error"><IconWarn className="icon size-4" /> You're not an admin of this group, so comics can't be added or removed.</p>
          )}
          {!groups.data.length && <p className="mt-2 type-body-s text-on-surface-variant">Tap Refresh to load your groups from WhatsApp.</p>}
          {draft.groupId && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button size="sm" variant="tonal" icon={IconUserPlus} onClick={pullMembers} loading={pulling} disabled={isDemoUser() || session?.status !== "ready"}>
                Get members from group
              </Button>
              <span className="type-body-s text-on-surface-variant">
                {isDemoUser() ? "Needs a linked WhatsApp, so it's off in the demo." : memberIds ? `${memberIds.length} members loaded. Pick regulars and protected below.` : "Adds everyone in the group to your comics. Admins become protected."}
              </span>
            </div>
          )}

          {draft.groupId && (
            <div className="mt-5 grid gap-5">
              <Field
                label="Update the group"
                hint={
                  mode === "manual"
                    ? "Nothing changes in the group until you tap Sync group on the lineup page and approve it."
                    : mode === "confirm"
                      ? "Right after you confirm or send updates, you review who gets added and removed."
                      : "On the show's day, last week's comics are removed and this lineup is added automatically. Admins, regulars and co-hosts always stay."
                }
              >
                <Segmented
                  value={mode}
                  onChange={(v) => set("groupMode", v)}
                  options={[
                    { value: "manual", label: "When I sync" },
                    { value: "confirm", label: "On confirm" },
                    { value: "show_day", label: "On show day" },
                  ]}
                />
              </Field>
              {mode === "show_day" && (
                <div className="grid gap-5 rounded-lg bg-surface-container p-4 sm:grid-cols-2">
                  <Field label="Run at">
                    <TextInput type="time" value={draft.showDaySyncTime ?? "12:00"} onChange={(e) => set("showDaySyncTime", e.target.value)} />
                  </Field>
                  <div className="flex items-center gap-3 sm:pt-6">
                    <div className="flex-1">
                      <div className="type-title-s">Post the lineup</div>
                      <div className="type-body-s text-on-surface-variant">Sends tonight's running order to the group</div>
                    </div>
                    <Switch checked={Boolean(draft.postLineupToGroup)} onChange={(v) => set("postLineupToGroup", v)} label="Post the lineup to the group" />
                  </div>
                </div>
              )}
              <PeoplePicker label="Regulars (always stay in the group)" icon={IconStar} selected={draft.regulars ?? []} onToggle={(id) => toggleIn("regulars", id)} people={comics} members={memberIds} />
              <PeoplePicker label="Protected (co-hosts, staff)" icon={IconMap} selected={draft.protected ?? []} onToggle={(id) => toggleIn("protected", id)} people={comics} members={memberIds} />
            </div>
          )}
        </section>
      </div>
    </Sheet>
  );
}

function PeoplePicker({ label, people, selected, onToggle, icon, members }: { label: string; people: { id: string; name: string }[]; selected: string[]; onToggle: (id: string) => void; icon: typeof IconStar; members: string[] | null }) {
  const [q, setQ] = useState("");
  const [groupOnly, setGroupOnly] = useState(false);
  const sel = new Set(selected);
  const inGroup = new Set(members ?? []);
  const needle = q.toLowerCase();
  const rank = (id: string) => Number(sel.has(id)) * 2 + Number(inGroup.has(id));
  const list = people
    .filter((p) => (!groupOnly || inGroup.has(p.id) || sel.has(p.id)) && p.name.toLowerCase().includes(needle))
    .sort((a, b) => rank(b.id) - rank(a.id) || a.name.localeCompare(b.name));
  const cap = needle ? 80 : 40;
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 type-label-l text-on-surface-variant">
        <span className="flex-1">{label}</span>
        {members && <Chip selected={groupOnly} onClick={() => setGroupOnly(!groupOnly)}>In this group</Chip>}
      </div>
      <TextInput placeholder="Search comics" value={q} onChange={(e) => setQ(e.target.value)} className="h-10" />
      <div className="mt-2 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
        {list.slice(0, cap).map((p) => (
          <Chip key={p.id} selected={sel.has(p.id)} onClick={() => onToggle(p.id)} icon={sel.has(p.id) ? icon : undefined}>
            {p.name}
          </Chip>
        ))}
        {list.length > cap && <span className="self-center type-body-s text-on-surface-variant">+{list.length - cap} more. Search to find them.</span>}
        {!people.length && <span className="type-body-s text-on-surface-variant">Comics appear here once they message you, or when you add or import them in Comics.</span>}
      </div>
    </div>
  );
}

function VenueEditor({ value, onClose }: { value: Partial<Venue> | null; onClose: () => void }) {
  const { uid } = useApp();
  const [draft, setDraft] = useState<Partial<Venue>>({});
  const [last, setLast] = useState<Partial<Venue> | null>(null);
  if (value !== last) {
    setLast(value);
    if (value) setDraft(value);
  }
  const aliasText = (draft.aliases ?? []).join(",");
  const save = async () => {
    if (!draft.name?.trim()) return toast.error("Venue needs a name");
    const { id, ...rest } = draft as Venue;
    const aliases = (rest.aliases ?? []).map((a) => a.trim()).filter(Boolean);
    const data = { ...rest, aliases };
    if (id) await setDoc(userDoc(uid, "venues", id), data);
    else await addDoc(userCol(uid, "venues"), data);
    onClose();
  };
  return (
    <Sheet open={Boolean(value)} onClose={onClose} title={draft.id ? "Edit venue" : "New venue"} footer={<><Button variant="text" onClick={onClose}>Cancel</Button><Button onClick={save}>Save</Button></>}>
      <div className="flex flex-col gap-6">
        <Field label="Name"><TextInput value={draft.name ?? ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="The Comedy Club" autoFocus /></Field>
        <Field label="Area"><TextInput value={draft.area ?? ""} onChange={(e) => setDraft({ ...draft, area: e.target.value })} placeholder="Indiranagar" /></Field>
        <Field label="Other names" hint="What comics call this place, separated by commas. Gemma uses them to match messages to the venue.">
          <TextInput
            value={aliasText}
            onChange={(e) => setDraft({ ...draft, aliases: e.target.value.split(",") })}
            placeholder="bloom, indira nagar"
          />
        </Field>
        <Field label="Google Maps link" hint="Shared in confirmations through {{mapsLink}}"><TextInput value={draft.mapsLink ?? ""} onChange={(e) => setDraft({ ...draft, mapsLink: e.target.value })} placeholder="https://maps.app.goo.gl/…" /></Field>
      </div>
    </Sheet>
  );
}

