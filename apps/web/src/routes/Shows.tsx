import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { GroupPostsEditor } from "../components/GroupPosts";
import { addDoc, deleteDoc, deleteField, setDoc } from "firebase/firestore";
import { motion } from "motion/react";
import { toast } from "sonner";
import { PlacePicker } from "@spot/ui";
import { DAY_SHORT, DEFAULT_CLEANUP, formatTime, groupModeOf, type GroupInfo, type GroupMember, type GroupMembersResult, type GroupMode, type Show, type Venue, type Weekday } from "@spot/shared";
import { useApp } from "../lib/app";
import { isDemoUser } from "../lib/demo";
import { runCommand, useCollection, userCol, userDoc } from "../lib/data";
import { GroupAvatar } from "../lib/photos";
import { PageHeader } from "@spot/ui";
import { ShowPeoplePicker } from "../components/ShowPeoplePicker";
import { Button, Chip, Empty, Field, IconButton, Segmented, Select, Sheet, Stepper, Switch, TextInput, TimePicker, cx } from "@spot/ui";
import { IconAdd, IconRoom, IconChat, IconClock, IconGroup, IconMap, IconUserPlus, IconPen, IconRefresh, IconStar, IconTrash, IconUserCheck, IconWarn } from "@spot/ui";

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
            <Button variant="tonal" icon={IconRoom} onClick={() => setEditingVenue({})}>
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
          <Empty icon={IconRoom} title="Start with a venue" action={<Button icon={IconAdd} onClick={() => setEditingVenue({})}>Add venue</Button>}>
            Where do your mics happen? Add the club first, then its weekly shows.
          </Empty>
        ) : (
          venues.map((v) => {
            const vs = shows.filter((s) => s.venueId === v.id);
            return (
              <section key={v.id}>
                <div className="mb-3 flex items-center gap-3">
                  <span className="grid size-10 place-items-center rounded-md bg-tertiary-container text-on-tertiary-container">
                    <IconRoom className="icon size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="type-title-l">{v.name}</h2>
                    {v.area && <p className="type-body-s text-on-surface-variant">{v.area}</p>}
                  </div>
                  <IconButton icon={IconPen} label={`Edit ${v.name}`} onClick={() => setEditingVenue(v)} />
                </div>
                <motion.ul className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 2xl:grid-cols-3" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.04 } } }}>
                  {vs.map((s) => (
                    <motion.li key={s.id} className="relative" variants={{ hidden: { opacity: 0, transform: "translateY(6px)" }, show: { opacity: 1, transform: "translateY(0px)" } }}>
                      <button onClick={() => setEditingShow(s)} className={cx("state-layer pressable flex w-full items-start gap-4 rounded-lg bg-surface-low p-4 text-left", !s.active && "opacity-60")}>
                        <span className="grid size-14 flex-none place-items-center rounded-md bg-primary-container text-on-primary-container">
                          <span className="type-title-m">{DAY_SHORT[s.weekday]}</span>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={cx("block truncate type-title-m", s.groupId && "pr-10")}>{s.name}</span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 type-body-m text-on-surface-variant">
                            <span className="inline-flex items-center gap-1"><IconClock className="icon size-4" />{formatTime(s.startTime)}</span>
                            <span className="tabular">{s.slotCount} slots{s.includeSlotTime && s.defaultMinutes ? ` · ${s.defaultMinutes} min` : ""}</span>
                          </span>
                          <span className="mt-2 flex flex-wrap gap-1.5">
                            {s.groupId ? <Chip icon={IconGroup}>Group linked</Chip> : <Chip className="border-dashed">No group</Chip>}
                            {s.groupId && <Chip icon={IconClock}>{GROUP_MODE_LABEL[groupModeOf(s)]}</Chip>}
                            {s.groupPosts?.some((p) => p.enabled) && <Chip icon={IconClock}>{s.groupPosts.filter((p) => p.enabled).length} scheduled</Chip>}
                            {s.regulars?.length ? <Chip tone="tertiary" icon={IconStar}>{s.regulars.length} regular{s.regulars.length > 1 ? "s" : ""}</Chip> : null}
                            {!s.active && <Chip>Paused</Chip>}
                          </span>
                        </span>
                      </button>
                      {s.groupId && (
                        <Link to={`/messages?g=${encodeURIComponent(s.groupId)}`} aria-label={`Open the ${s.name} group chat`} title="Group chat" className="state-layer absolute top-3 right-3 grid size-10 place-items-center rounded-full text-primary">
                          <IconChat className="icon size-5" />
                        </Link>
                      )}
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
  // Only while the sheet is open: the groups list is large and nothing else on this page uses it.
  const groups = useCollection<GroupInfo>(value ? uid : undefined, "groups");
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
    const { id, groupMembers: _cache, groupPostsSent: _sent, ...rest } = draft as Show;
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
  const cleanup = draft.cleanup ?? DEFAULT_CLEANUP;
  // One person can be two comic docs (phone id and @lid): a tap adds the one WhatsApp reaches, and removes every doc of them.
  const toggleIn = (k: "regulars" | "protected" | "pocs", ids: string[], rep: string) => {
    const cur = new Set(draft[k] ?? []);
    if (ids.some((i) => cur.has(i))) ids.forEach((i) => cur.delete(i));
    else cur.add(rep);
    set(k, [...cur]);
  };

  // Who is in the show's WhatsApp group: the cached members read from the group, plus anyone just pulled with "Get members from group".
  const groupMembers = useMemo<GroupMember[] | null>(() => {
    const cache = draft.groupId && value?.groupMembers?.groupId === draft.groupId ? value.groupMembers.members : [];
    if (!cache.length && !memberIds) return null;
    const have = new Set(cache.map((m) => m.id));
    return [...cache, ...(memberIds ?? []).filter((id) => !have.has(id)).map((id) => ({ id, name: "", isAdmin: false }))];
  }, [draft.groupId, value?.groupMembers, memberIds]);
  const roles = useMemo(() => ({ pocs: draft.pocs, regulars: draft.regulars, cohosts: draft.protected }), [draft.pocs, draft.regulars, draft.protected]);
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
        <div className="flex items-center gap-3" role="group" aria-label="Day">
          <span className="flex-none type-label-l text-on-surface-variant">Day</span>
          <div className="grid min-w-0 flex-1 grid-cols-7 gap-1">
            {WEEKDAYS.map((d) => (
              <Chip key={d} selected={draft.weekday === d} onClick={() => set("weekday", d)} className="h-9 justify-center rounded-full px-0">
                {DAY_SHORT[d]}
              </Chip>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts at">
            <TimePicker value={draft.startTime ?? "20:00"} onChange={(v) => set("startTime", v)} label="Start time" />
          </Field>
          <Field label="Slots">
            <Stepper full value={draft.slotCount ?? 8} onChange={(v) => set("slotCount", v)} min={1} max={40} />
          </Field>
        </div>

        <div className="rounded-lg bg-surface-container p-4">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <div className="type-title-s">Mention set length</div>
              <div className="type-body-s text-on-surface-variant">Adds the set length (e.g. 5 min) to confirmations. Leave off for shows without a fixed limit.</div>
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
          <div className="flex items-center gap-3">
            {draft.groupId && <GroupAvatar groupId={draft.groupId} name={group?.name ?? "Group"} size={40} />}
            <div className="min-w-0 flex-1">
              <Select value={draft.groupId ?? ""} onChange={(v) => set("groupId", v || null)} placeholder="No group" options={groups.data.map((g) => ({ value: g.id, label: `${g.name} · ${g.participants}` }))} />
            </div>
          </div>
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
            <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-5">
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
                  full
                  compact
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
                    <TimePicker value={draft.showDaySyncTime ?? "12:00"} onChange={(v) => set("showDaySyncTime", v)} label="Sync time" />
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
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <span className="flex-1 type-title-s">Scheduled posts</span>
                  {draft.id && value?.groupId === draft.groupId && (
                    <Link to={`/messages?g=${encodeURIComponent(draft.groupId)}`} className="state-layer inline-flex h-9 items-center gap-1 rounded-full px-3 type-label-l text-primary">
                      <IconChat className="icon size-4" /> Open group chat
                    </Link>
                  )}
                </div>
                <GroupPostsEditor show={{ name: draft.name ?? "", weekday: draft.weekday ?? 1, startTime: draft.startTime ?? "20:00", venueId: draft.venueId ?? "", groupPostsSent: value?.groupPostsSent, pocs: draft.pocs }} posts={draft.groupPosts ?? []} onChange={(v) => set("groupPosts", v)} />
              </div>
              <ShowPeoplePicker label="POCs (run the mic; always stay; tagged with {{pocs}})" icon={IconUserCheck} selected={draft.pocs ?? []} onToggle={(ids, id) => toggleIn("pocs", ids, id)} comics={comics} members={groupMembers} roles={roles} />
              <div className="flex flex-col gap-3 rounded-lg bg-surface-container p-4">
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="type-title-s">Clear the group after the show</div>
                    <div className="type-body-s text-on-surface-variant">The day after, your after-show message goes out and everyone leaves except POCs, regulars, co-hosts, admins and anyone already on next week's lineup.</div>
                  </div>
                  <Switch checked={Boolean(cleanup.enabled)} onChange={(v) => set("cleanup", { ...cleanup, enabled: v })} label="Clear the group after the show" />
                </div>
                {cleanup.enabled && (
                  <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
                    <Field label="When">
                      <TimePicker value={cleanup.time} onChange={(v) => set("cleanup", { ...cleanup, time: v })} label="Cleanup time" />
                    </Field>
                    <Field label="If the mic happened" hint={cleanup.mode === "auto" ? "Clears it on its own. If the mic didn't happen, you're asked first." : "You're asked every time, in Updates and on your agent number."}>
                      <Segmented
                        size="sm"
                        value={cleanup.mode}
                        onChange={(v) => set("cleanup", { ...cleanup, mode: v })}
                        options={[
                          { value: "auto", label: "Clear it" },
                          { value: "ask", label: "Ask me" },
                        ]}
                      />
                    </Field>
                  </div>
                )}
              </div>
              <ShowPeoplePicker label="Regulars (always stay in the group)" icon={IconStar} selected={draft.regulars ?? []} onToggle={(ids, id) => toggleIn("regulars", ids, id)} comics={comics} members={groupMembers} roles={roles} />
              <ShowPeoplePicker label="Protected (co-hosts, staff)" icon={IconMap} selected={draft.protected ?? []} onToggle={(ids, id) => toggleIn("protected", ids, id)} comics={comics} members={groupMembers} roles={roles} />
            </div>
          )}
        </section>
      </div>
    </Sheet>
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
    const { lat, lng, ...base } = rest;
    // Firestore refuses undefined, so a venue with no pin simply has no lat/lng (or link, place id, address).
    const data = Object.fromEntries(Object.entries({ ...base, aliases, ...(typeof lat === "number" && typeof lng === "number" && { lat, lng }) }).filter(([, v]) => v !== undefined));
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
        <div className="flex flex-col gap-1.5">
          <span className="type-label-l text-on-surface-variant">Location</span>
          <PlacePicker
            allowLinkOnly
            near={draft.area}
            value={draft.mapsLink || typeof draft.lat === "number" ? { lat: draft.lat, lng: draft.lng, mapsUrl: draft.mapsLink, placeId: draft.placeId, label: draft.name?.trim() || undefined, address: draft.address } : null}
            onChange={(v) => setDraft((d) => ({ ...d, mapsLink: v?.mapsUrl, lat: v?.lat, lng: v?.lng, placeId: v?.placeId, address: v?.address }))}
            onPlace={(p) => setDraft((d) => ({ ...d, name: d.name?.trim() ? d.name : p.name }))}
          />
          <span className="type-body-s text-on-surface-variant">The Google Maps link goes out in confirmations through {"{{mapsLink}}"}.</span>
        </div>
      </div>
    </Sheet>
  );
}

