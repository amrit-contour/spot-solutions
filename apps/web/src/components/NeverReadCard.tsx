// Settings → Rules & replies → Never read: people and groups whose messages are skipped before anything else happens.
// Picking uses the same live chat list as "Choose chats to learn from" (names only, never stored); what is saved is id + name.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { neverReadSubtitle, normalizeNeverReadId, searchNeverRead, selectAllState, splitNeverRead, type NeverReadEntry, type VoiceSourceItem } from "@spot/shared";
import { useApp } from "../lib/app";
import { runCommand, timeAgo } from "../lib/data";
import { useLinkedGroups, useNeverRead, type NeverReadItem } from "../lib/neverRead";
import { Avatar, Button, Chip, ConfirmDialog, IconButton, Info, Segmented, Sheet, Spinner, Switch, cx, useSectionOpen } from "@spot/ui";
import { IconCheck, IconClose, IconEye, IconSearch } from "@spot/ui";

const EXCEPTIONS = "Your show groups and Comedy's watched groups are still used.";

/** "Never read any group": one setting, shown on the card and at the top of the sheet's Groups tab. */
function AllGroupsSwitch({ id }: { id: string }) {
  const { allGroups, setAllGroups } = useNeverRead();
  return (
    <div className="flex items-center gap-3 rounded-lg bg-surface-container px-4 py-3">
      <span className="min-w-0 flex-1">
        <label id={`${id}-label`} className="block type-title-s">Never read any group</label>
        <span className="block type-body-s text-on-surface-variant">{allGroups ? `Every group is skipped. ${EXCEPTIONS}` : "Skip every WhatsApp group in one go. Your show groups and Comedy's watched groups stay in use."}</span>
      </span>
      <Switch checked={allGroups} label="Never read any group" onChange={(v) => void setAllGroups(v).then(() => toast.success(v ? "Groups are skipped. Your show groups and watched groups are still used." : "Groups are read again."))} />
    </div>
  );
}

function EntryRow({ e, onRemove }: { e: NeverReadEntry; onRemove: () => void }) {
  const { comicsById } = useApp();
  return (
    <li className="flex min-h-14 items-center gap-3 py-2 pr-1 pl-2">
      <Avatar name={e.name || (e.kind === "group" ? "Group" : "#")} size={36} tone={e.kind === "group" ? "tertiary" : "primary"} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate type-title-s">{e.name || (e.kind === "group" ? "Group" : "Unnamed")}</span>
          {comicsById.has(e.id) && <Chip tone="error">Comic</Chip>}
        </span>
        <span className="block truncate type-body-s text-on-surface-variant">{neverReadSubtitle(e)}</span>
      </span>
      <IconButton icon={IconClose} label={`Remove ${e.name || "this chat"} from Never read`} onClick={onRemove} />
    </li>
  );
}

const SUMMARY = "Messages from these people and groups are skipped: never read, never sent to AI, never stored.";

/** "Alex", "Alex and Sam", "Alex, Sam and 2 others". */
function names(list: string[]) {
  if (list.length <= 2) return list.join(" and ");
  return `${list.slice(0, 2).join(", ")} and ${list.length - 2} other${list.length - 2 === 1 ? "" : "s"}`;
}

export function NeverReadCard() {
  const { list, remove, clear, allGroups } = useNeverRead();
  const [adding, setAdding] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [open, setOpen] = useSectionOpen("never-read-list", false); // remembered per device
  const reduce = useReducedMotion();
  const [q, setQ] = useState("");
  const shown = useMemo(() => splitNeverRead(searchNeverRead(list, q)), [list, q]);
  const all = useMemo(() => splitNeverRead(list), [list]);
  const sections = [
    { key: "people", label: "People", total: all.people.length, rows: shown.people },
    { key: "groups", label: "Groups", total: all.groups.length, rows: shown.groups },
  ];
  const hasRows = shown.people.length + shown.groups.length > 0;
  const counts = [list.length ? `${all.people.length} ${all.people.length === 1 ? "person" : "people"} · ${all.groups.length} group${all.groups.length === 1 ? "" : "s"}` : "", allGroups ? "All groups on" : ""].filter(Boolean).join(" · ");

  return (
    <section className="rounded-xl bg-surface-low p-4 sm:p-6">
      <header className="mb-2 flex items-center gap-3">
        <span className="grid size-10 flex-none place-items-center rounded-md bg-secondary-container text-on-secondary-container">
          <IconEye className="icon size-5" />
        </span>
        <h2 className="min-w-0 type-title-l">Never read</h2>
        <Info label="About Never read">
          Family, friends, your partner, banks, delivery apps, anyone who isn't a comic. Their chats are skipped before anything else: not read by the AI, not stored, not counted, no requests, no replies, not in scans, voice learning or group watching. Hidden from Messages too. You can still message them yourself in WhatsApp.
        </Info>
      </header>
      <p className="type-body-m text-on-surface-variant">Skipped before anything else: never read, never sent to AI, never stored.</p>
      {counts && <p className="mt-1 type-label-l text-on-surface tabular">{counts}</p>}

      <div className="mt-4">
        <AllGroupsSwitch id="nr-card" />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="tonal" onClick={() => setAdding(true)}>
          Add people or groups
        </Button>
        {list.length > 0 && (
          <Button variant="text" aria-expanded={open} aria-controls="never-read-list" onClick={() => setOpen(!open)}>
            {open ? "Hide" : `Show all (${list.length})`}
          </Button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {open && list.length > 0 && (
          <motion.div id="never-read-list" key="list" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: reduce ? 0 : 0.25, ease: [0.23, 1, 0.32, 1] }} style={{ overflow: "hidden" }}>
            <div className="pt-4">
              {list.length > 6 && (
                <label className="relative mb-3 block">
                  <IconSearch className="icon pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-on-surface-variant" />
                  <input value={q} onChange={(e) => setQ(e.target.value)} type="search" aria-label="Search your Never read list" placeholder="Search the list" className="h-11 w-full rounded-full border border-outline-variant bg-surface pr-3 pl-10 text-base outline-none focus:border-primary" />
                </label>
              )}
              {!hasRows ? (
                <p className="py-6 text-center type-body-m text-on-surface-variant">Nothing on the list matches “{q.trim()}”.</p>
              ) : (
                <div className="flex flex-col gap-4">
                  {sections.map(
                    (g) =>
                      g.rows.length > 0 && (
                        <section key={g.key} aria-label={g.label}>
                          <h3 className="mb-1 px-1 type-label-l text-on-surface-variant tabular">
                            {g.label} · {q.trim() ? `${g.rows.length} of ${g.total}` : g.total}
                          </h3>
                          <ul className="flex flex-col rounded-lg bg-surface-container px-2 py-1">
                            {g.rows.map((e) => (
                              <EntryRow key={e.id} e={e} onRemove={() => void remove(e.id).then(() => toast.success("Removed. Their messages are read again."))} />
                            ))}
                          </ul>
                        </section>
                      ),
                  )}
                </div>
              )}
              <div className="mt-3">
                <Button variant="text" onClick={() => setClearing(true)}>
                  Remove all
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <NeverReadSheet open={adding} onClose={() => setAdding(false)} />
      <ConfirmDialog
        open={clearing}
        onClose={() => setClearing(false)}
        title="Remove everyone from Never read?"
        confirmLabel={`Remove all ${list.length}`}
        onConfirm={async () => {
          await clear();
          toast.success("Cleared. Their messages are read again.");
        }}
      >
        <p>
          All {list.length} {list.length === 1 ? "chat" : "chats"} ({all.people.length} {all.people.length === 1 ? "person" : "people"}, {all.groups.length} group{all.groups.length === 1 ? "" : "s"}) go back to being read. This doesn't change "Never read any group".
        </p>
      </ConfirmDialog>
    </section>
  );
}

/** Pick from your recent WhatsApp chats and groups, or type a number. */
export function NeverReadSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { uid } = useApp();
  const nr = useNeverRead();
  const { shows, settings } = useApp();
  const { linked } = useLinkedGroups(uid, shows, settings);
  const [items, setItems] = useState<VoiceSourceItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Map<string, NeverReadItem>>(new Map());
  const [tab, setTab] = useState<"groups" | "people">("people");
  const [q, setQ] = useState("");
  const [typed, setTyped] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPicked(new Map());
    setError(null);
    setItems(null);
    setQ("");
    setTyped("");
    let live = true;
    runCommand<{ chats: VoiceSourceItem[] }>(uid, "list_voice_sources", {}, 120_000, { ephemeral: true })
      .then((r) => live && setItems(r.chats))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, uid]);

  const needle = q.trim().toLowerCase();
  const inView = useMemo(
    () => (items ?? []).filter((c) => c.isGroup === (tab === "groups") && !nr.has(c.id) && (!needle || c.name.toLowerCase().includes(needle) || c.id.split("@")[0].includes(needle.replace(/\D/g, "") || "\u0000"))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, tab, needle, nr.list],
  );
  /** Rows you can pick: linked groups (show groups, Comedy watched groups, host poll group) are shown but cannot be added. */
  const selectable = useMemo(() => inView.filter((c) => !linked.has(c.id)), [inView, linked]);
  const count = (g: boolean) => (items ?? []).filter((c) => c.isGroup === g && !nr.has(c.id)).length;
  const toggle = (c: VoiceSourceItem) =>
    setPicked((p) => {
      const n = new Map(p);
      if (n.has(c.id)) n.delete(c.id);
      else n.set(c.id, { id: c.id, kind: c.isGroup ? "group" : "person", name: c.name });
      return n;
    });

  const sel = selectAllState(selectable.map((c) => c.id), new Set(picked.keys()));
  /** Select all: every visible (filtered) row not yet ticked; when they are all ticked, untick just those. */
  const toggleAll = () =>
    setPicked((p) => {
      const n = new Map(p);
      if (sel.all) for (const c of selectable) n.delete(c.id);
      else for (const c of selectable) n.set(c.id, { id: c.id, kind: c.isGroup ? "group" : "person", name: c.name });
      return n;
    });

  const typedId = normalizeNeverReadId(typed, { countryCode: nr.countryCode });
  const typedItem: NeverReadItem | null = typedId && typedId.kind === "person" && !nr.has(typedId.id) ? { id: typedId.id, kind: "person", name: nr.comicsAmong([typedId.id])[0]?.name } : null;
  const all = [...picked.values(), ...(typedItem ? [typedItem] : [])];
  const hitComics = nr.comicsAmong(all.map((i) => i.id));

  const save = async () => {
    setSaving(true);
    try {
      await nr.add(all);
      toast.success(`${all.length} added to Never read`);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add to Never read"
      footer={
        <>
          <span className="mr-auto type-body-m text-on-surface-variant tabular" aria-live="polite">{all.length} selected</span>
          <Button variant="text" onClick={onClose}>Cancel</Button>
          <Button loading={saving} disabled={!all.length} onClick={() => void save()}>{all.length ? `Add ${all.length}` : "Add"}</Button>
        </>
      }
    >
      <p className="mb-3 type-body-m text-on-surface-variant">{SUMMARY}</p>

      <div className="mb-3 flex flex-col gap-1.5">
        <label className="type-label-l" htmlFor="never-read-number">Or type a number</label>
        <input id="never-read-number" value={typed} onChange={(e) => setTyped(e.target.value)} inputMode="tel" autoComplete="off" placeholder={`+${nr.countryCode} 98765 43210`} className="h-11 w-full rounded-lg border border-outline-variant bg-surface-low px-3.5 text-base outline-none focus:border-primary" />
        {typed.trim() && !typedId && <span className="type-body-s text-error">That doesn't look like a phone number.</span>}
        {typedId && !typedItem && <span className="type-body-s text-on-surface-variant">{typedId.kind === "group" ? "Groups can't be typed. Pick them from the list below." : "Already on the list."}</span>}
        {typedItem && <span className="type-body-s text-on-surface-variant">Will add {neverReadSubtitle({ ...typedItem, addedAt: 0 })}{typedItem.name ? ` (${typedItem.name})` : ""}. Numbers without a country code use +{nr.countryCode}.</span>}
      </div>

      {hitComics.length > 0 && (
        <p role="alert" className="mb-3 rounded-lg bg-error-container px-4 py-3 type-body-m text-on-error-container">
          <b>{names(hitComics.map((c) => c.name))}</b> {hitComics.length === 1 ? "is" : "are"} on your Comics list. Their spot requests will be ignored.
        </p>
      )}

      {error ? (
        <p role="alert" className="rounded-lg bg-error-container px-4 py-3 type-body-m text-on-error-container">{error} You can still type a number above.</p>
      ) : !items ? (
        <div className="grid place-items-center py-12 text-primary"><Spinner className="size-7" /></div>
      ) : (
        <>
          <div className="sticky top-0 z-10 -mx-4 flex flex-col gap-2 bg-surface px-4 pb-3 sm:-mx-8 sm:px-8">
            <label className="relative block">
              <IconSearch className="icon pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-on-surface-variant" />
              <input value={q} onChange={(e) => setQ(e.target.value)} type="search" aria-label="Search chats" placeholder="Search name or number" className="h-11 w-full rounded-full border border-outline-variant bg-surface-low pr-3 pl-10 text-base outline-none focus:border-primary" />
            </label>
            <Segmented full value={tab} onChange={setTab} options={[{ value: "people", label: `People · ${count(false)}` }, { value: "groups", label: `Groups · ${count(true)}` }]} />
            {selectable.length > 0 && (
              <div className="flex items-center gap-2 border-b border-outline-variant/60 pb-1">
                <button role="checkbox" aria-checked={sel.all ? true : sel.some ? "mixed" : false} aria-label={`Select all ${selectable.length} ${needle ? "matching " : ""}${tab}`} onClick={toggleAll} className="state-layer flex min-h-11 flex-1 items-center gap-3 rounded-lg px-2 text-left type-label-l">
                  <span className={cx("grid size-6 flex-none place-items-center rounded-xs border-2", sel.all || sel.some ? "border-primary bg-primary text-on-primary" : "border-outline")}>
                    {sel.all && <IconCheck className="icon size-4" />}
                    {sel.some && <span className="h-0.5 w-3 rounded-full bg-on-primary" />}
                  </span>
                  Select all ({selectable.length})
                </button>
                <span className="pr-2 type-body-s text-on-surface-variant tabular">{picked.size ? `${picked.size} selected` : ""}</span>
              </div>
            )}
          </div>
          {tab === "groups" && <div className="mb-3"><AllGroupsSwitch id="nr-sheet" /></div>}
          {inView.length === 0 ? (
            <p className="py-10 text-center type-body-m text-on-surface-variant">{needle ? `No ${tab} match “${q.trim()}”.` : `No ${tab} left to add.`}</p>
          ) : (
            <ul className="flex flex-col">
              {inView.map((c) => {
                const on = picked.has(c.id);
                const why = linked.get(c.id);
                return (
                  <li key={c.id}>
                    <button role="checkbox" aria-checked={on} aria-label={why ? `${c.name}. ${why}, can't be added` : c.name} aria-disabled={!!why} disabled={!!why} onClick={() => toggle(c)} className="state-layer flex min-h-14 disabled:opacity-60 w-full items-center gap-3 rounded-lg px-2 py-2 text-left">
                      <span className={cx("grid size-6 flex-none place-items-center rounded-xs border-2", on ? "border-primary bg-primary text-on-primary" : why ? "border-outline-variant" : "border-outline")}>{on && <IconCheck className="icon size-4" />}</span>
                      <Avatar name={c.name} size={36} tone={c.isGroup ? "tertiary" : "primary"} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate type-title-s">{c.name}</span>
                        <span className="block type-body-s text-on-surface-variant">{why ?? (c.lastAt ? `Last active ${timeAgo(c.lastAt)}` : "No recent activity")}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </Sheet>
  );
}
