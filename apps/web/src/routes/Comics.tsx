import { useEffect, useMemo, useState } from "react";
import { ComicAvatar } from "../lib/photos";
import { Link, useSearchParams } from "react-router-dom";
import { deleteDoc, setDoc, writeBatch } from "firebase/firestore";
import { motion } from "motion/react";
import { toast } from "sonner";
import { cancellations, formatDate, localNow, shiftWeek, type Comic, type ComicList, type Tier } from "@spot/shared";
import { useApp } from "../lib/app";
import { isDemoUser } from "../lib/demo";
import { userDoc } from "../lib/data";
import { db } from "@spot/ui/firebase";
import { saveComicToGoogle } from "../lib/googleContacts";
import { PageHeader } from "@spot/ui";
import { StickyBar } from "@spot/ui";
import { ConfirmDialog } from "@spot/ui";
import { Menu, MenuItem } from "@spot/ui";
import { PastSpotSheet } from "../components/PastSpotSheet";
import { ImportContactsSheet, ImportFileSheet, ImportGoogleSheet } from "../components/ImportSheets";
import { Button, Chip, CompactButton, Empty, Field, IconButton, Segmented, Sheet, TextArea, TextInput, buttonClass, cx } from "@spot/ui";
import { IconChat, IconCheck, IconComics, IconCrown, IconHistory, IconPen, IconSearch, IconStar, IconTrash, IconUserPlus, IconImport } from "@spot/ui";

const LIST_LABEL: Record<ComicList, string> = { host: "Host", ignored: "Ignored", banned: "Banned" };

const TIERS: { value: Tier; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "regular", label: "Regular" },
  { value: "featured", label: "Featured" },
];

export function Comics() {
  const { uid, comics, currentWeek, shows, session } = useApp();
  const [importing, setImporting] = useState<"contacts" | "file" | "google" | null>(null);
  const waHint = isDemoUser() ? "Off in demo" : session?.status !== "ready" ? "Connect WhatsApp" : undefined;
  const [q, setQ] = useState("");
  const [tier, setTier] = useState<Tier | "all">("all");
  const [editing, setEditing] = useState<Partial<Comic> | null>(null);
  const lastWeek = shiftWeek(currentWeek, -1);
  // Bulk select: tick several comics and remove them together.
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const exitSelect = () => (setSelecting(false), setSel(new Set()), setConfirming(false));
  useEffect(() => {
    if (!selecting || confirming) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && exitSelect();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [selecting, confirming]);
  // The Updates panel links here: ?edit=<comicId> opens a profile, ?add=<name> starts a new one.
  const [params, setParams] = useSearchParams();
  const editId = params.get("edit");
  const addName = params.get("add");
  useEffect(() => {
    if (addName) setEditing({ tier: "open", name: addName });
    else {
      const c = editId ? comics.find((x) => x.id === editId) : null;
      if (!c) return;
      setEditing(c);
    }
    setParams({}, { replace: true });
  }, [editId, addName, comics, setParams]);

  const list = useMemo(
    () =>
      comics
        .filter((c) => (tier === "all" || c.tier === tier) && (c.name.toLowerCase().includes(q.toLowerCase()) || c.phone.includes(q)))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [comics, q, tier],
  );
  // Only what's in view counts, so a hidden, filtered-out comic is never removed by accident.
  const chosen = list.filter((c) => sel.has(c.id));
  const allOn = list.length > 0 && chosen.length === list.length;
  const toggle = (id: string) => setSel((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const removeChosen = async () => {
    const gone = chosen;
    for (let i = 0; i < gone.length; i += 450) {
      const b = writeBatch(db);
      gone.slice(i, i + 450).forEach((c) => b.delete(userDoc(uid, "comics", c.id)));
      await b.commit();
    }
    exitSelect();
    toast.success(`Removed ${gone.length} ${gone.length === 1 ? "comic" : "comics"}`, {
      duration: 10000,
      action: {
        label: "Undo",
        onClick: async () => {
          try {
            for (let i = 0; i < gone.length; i += 450) {
              const b = writeBatch(db);
              gone.slice(i, i + 450).forEach((c) => b.set(userDoc(uid, "comics", c.id), c));
              await b.commit();
            }
            toast.success(`Restored ${gone.length}`);
          } catch (e) {
            toast.error((e as Error).message);
          }
        },
      },
    });
  };

  return (
    <div className="w-full">
      <PageHeader title="Comics" subtitle={`${comics.length} on your roster. New faces join when they message you.`} actions={
        <>
          <Menu
            align="right"
            trigger={(t) => (
              <CompactButton size="md" variant="tonal" icon={IconImport} label="Import" onClick={t} />
            )}
          >
            {(close) => (
              <>
                <MenuItem disabled={Boolean(waHint)} hint={waHint} onClick={() => (close(), setImporting("contacts"))}>From WhatsApp contacts</MenuItem>
                <MenuItem disabled={isDemoUser()} hint={isDemoUser() ? "Off in demo" : undefined} onClick={() => (close(), setImporting("google"))}>From Google Contacts</MenuItem>
                <MenuItem onClick={() => (close(), setImporting("file"))}>From a file (CSV / vCard)</MenuItem>
              </>
            )}
          </Menu>
          {!selecting && comics.length > 0 && <CompactButton size="md" variant="outlined" icon={IconCheck} label="Select" onClick={() => setSelecting(true)} />}
          <CompactButton icon={IconUserPlus} label="Add comic" variant="filled" size="md" onClick={() => setEditing({ tier: "open" })} />
        </>
      }
    />

      <div className={cx("px-4 sm:px-8", selecting ? "pb-6" : "pb-12")}>
        <StickyBar className="mb-1">
        <div className="flex flex-wrap items-center gap-2 py-2 sm:gap-3 sm:py-3">
          <div className="relative min-w-60 flex-1">
            <IconSearch className="icon pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-on-surface-variant" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or number" className="h-12 w-full rounded-full bg-surface-high pr-4 pl-12 type-body-l outline-none placeholder:text-on-surface-variant focus:shadow-[inset_0_0_0_2px_var(--md-sys-color-primary)]" />
          </div>
          <div className="w-full sm:w-auto"><Segmented size="sm" full value={tier} onChange={setTier} options={[{ value: "all", label: "All" }, ...TIERS]} /></div>
        </div>
        </StickyBar>
        {!list.length ? (
          <Empty icon={IconComics} title={comics.length ? "No matches" : "No comics yet"}>
            {comics.length ? "Try a different search." : "Once someone asks for a spot, they're added here automatically. You can also add people by hand."}
          </Empty>
        ) : (
          <>
          {selecting && (
            <label className="state-layer mb-2 flex cursor-pointer items-center gap-4 rounded-xl bg-surface-container px-4 py-3 sm:px-5">
              <input type="checkbox" className="size-5 flex-none accent-[var(--md-sys-color-primary)]" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(list.map((c) => c.id)))} />
              <span className="type-title-s">Select all{q || tier !== "all" ? " in this view" : ""} ({list.length})</span>
            </label>
          )}
          <motion.ul className="overflow-hidden rounded-xl bg-surface-low" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.02 } } }}>
            {list.map((c, i) => (
              <motion.li key={c.id} variants={{ hidden: { opacity: 0 }, show: { opacity: 1 } }} className={cx("flex items-center", i > 0 && "border-t border-outline-variant/50")}>
                <button onClick={() => (selecting ? toggle(c.id) : setEditing(c))} aria-pressed={selecting ? sel.has(c.id) : undefined} className={cx("state-layer flex min-w-0 flex-1 items-center gap-4 px-4 py-3 text-left sm:px-5", selecting && sel.has(c.id) && "bg-secondary-container/40")}>
                  {selecting && <input type="checkbox" tabIndex={-1} readOnly checked={sel.has(c.id)} className="pointer-events-none size-5 flex-none accent-[var(--md-sys-color-primary)]" aria-label={`Select ${c.name}`} />}
                  <ComicAvatar id={c.id} name={c.name} size={40} tone={c.tier === "featured" ? "tertiary" : c.tier === "regular" ? "secondary" : "primary"} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate type-title-m">{c.name}</span>
                      {c.tier === "featured" && <IconCrown className="icon size-4 text-tertiary" />}
                      {c.tier === "regular" && <IconStar className="icon size-4 text-secondary" />}
                      {c.list && <Chip tone={c.list === "host" ? "tertiary" : "error"}>{LIST_LABEL[c.list]}</Chip>}
                    </span>
                    <span className="block type-body-s text-on-surface-variant tabular">{c.phone ? `+${c.phone}` : "Number hidden by WhatsApp"}</span>
                  </span>
                  <span className="hidden flex-wrap justify-end gap-1.5 sm:flex">
                    {(c.regularOf ?? []).map((sid) => {
                      const s = shows.find((x) => x.id === sid);
                      return s ? <Chip key={sid}>{s.name}</Chip> : null;
                    })}
                    {c.lastPerformedWeek && (
                      <Chip icon={IconHistory} tone={c.lastPerformedWeek === lastWeek ? "primary" : "neutral"}>
                        {c.lastPerformedWeek === lastWeek ? "Last week" : formatDate(c.lastPerformedWeek)}
                      </Chip>
                    )}
                  </span>
                  {!selecting && <IconPen className="icon size-5 text-on-surface-variant" />}
                </button>
                {!selecting && (
                  <Link to={`/messages?c=${encodeURIComponent(c.id)}`} aria-label={`Chat with ${c.name}`} title={`Chat with ${c.name}`} className="state-layer pressable mr-2 grid size-10 flex-none place-items-center rounded-full text-primary sm:mr-3">
                    <IconChat className="icon size-5" />
                  </Link>
                )}
              </motion.li>
            ))}
          </motion.ul>
          </>
        )}
        {selecting && (
          <div className="fixed inset-x-4 bottom-[calc(var(--nav-h)+0.5rem)] z-30 flex items-center gap-2 rounded-full bg-inverse-surface py-2 pr-2 pl-5 text-inverse-on-surface shadow-lg sm:sticky sm:inset-x-auto sm:bottom-6 sm:mt-4">
            <span className="min-w-0 flex-1 truncate type-label-l tabular">{chosen.length} selected</span>
            <Button variant="text" onClick={exitSelect} className="text-inverse-on-surface!">Cancel</Button>
            <Button variant="danger" icon={IconTrash} disabled={!chosen.length} onClick={() => setConfirming(true)}>Remove</Button>
          </div>
        )}
      </div>
      <ConfirmDialog open={confirming} onClose={() => setConfirming(false)} title={`Remove ${chosen.length} ${chosen.length === 1 ? "comic" : "comics"}?`} confirmLabel="Remove" onConfirm={removeChosen}>
        <p>They come off your roster only. Nothing changes in WhatsApp or Google Contacts, and their past requests stay.</p>
        <p className="type-body-s">{chosen.slice(0, 5).map((c) => c.name).join(", ")}{chosen.length > 5 ? ` and ${chosen.length - 5} more` : ""}. You can undo right after.</p>
      </ConfirmDialog>
      <ComicEditor value={editing} onClose={() => setEditing(null)} />
      <ImportContactsSheet open={importing === "contacts"} onClose={() => setImporting(null)} />
      <ImportGoogleSheet open={importing === "google"} onClose={() => setImporting(null)} />
      <ImportFileSheet open={importing === "file"} onClose={() => setImporting(null)} />
    </div>
  );
}

function ComicEditor({ value, onClose }: { value: Partial<Comic> | null; onClose: () => void }) {
  const { uid, shows, settings, session, comicsById } = useApp();
  const today = localNow(new Date(), settings.timezone).date;
  const [pastOpen, setPastOpen] = useState(false);
  const [d, setD] = useState<Partial<Comic>>({});
  const [last, setLast] = useState<Partial<Comic> | null>(null);
  // Read live, so a past spot recorded from here shows straight away.
  const history = (d.id ? comicsById.get(d.id)?.history : undefined) ?? d.history;
  if (value !== last) {
    setLast(value);
    if (value) setD(value);
  }
  const isNew = !d.id;

  const save = async () => {
    const phone = (d.phone ?? "").replace(/\D/g, "");
    if (!d.name?.trim()) return toast.error("Give them a name");
    if (isNew && phone.length < 10) return toast.error("Add their WhatsApp number with country code");
    const full = !phone ? "" : phone.length === 10 ? `91${phone}` : phone;
    const id = d.id ?? `${full}@c.us`;
    const regularOf = d.regularOf ?? [];
    const nameSource = value?.name !== d.name || isNew ? "manual" : (d.nameSource ?? "manual");
    await setDoc(userDoc(uid, "comics", id), { ...d, id, nameSource, phone: full, tier: d.tier ?? "open", regularOf, lastPerformedWeek: d.lastPerformedWeek ?? null });
    // Keep each show's regulars list in sync with the comic's "regular of".
    await Promise.all(
      shows.map((s) => {
        const has = (s.regulars ?? []).includes(id);
        const want = regularOf.includes(s.id);
        if (has === want) return null;
        const regulars = want ? [...(s.regulars ?? []), id] : (s.regulars ?? []).filter((x) => x !== id);
        return setDoc(userDoc(uid, "shows", s.id), { regulars }, { merge: true });
      }),
    );
    // New comic, or a changed name or number: write it to Google Contacts if that's on.
    if (isNew || value?.name !== d.name) saveComicToGoogle({ id, name: d.name.trim(), phone: full }, settings.googleContacts.enabled, session?.phone ? [session.phone] : []);
    onClose();
  };
  const remove = async () => {
    if (d.id && confirm(`Remove ${d.name} from your roster?`)) {
      await deleteDoc(userDoc(uid, "comics", d.id));
      onClose();
    }
  };
  const toggleShow = (sid: string) => {
    const cur = new Set(d.regularOf ?? []);
    if (cur.has(sid)) cur.delete(sid);
    else cur.add(sid);
    setD({ ...d, regularOf: [...cur] });
  };

  return (
    <Sheet
      open={Boolean(value)}
      onClose={onClose}
      title={isNew ? "Add comic" : d.name}
      footer={
        <>
          {!isNew && <IconButton icon={IconTrash} label="Remove" onClick={remove} className="text-error" />}
          {!isNew && d.id && (
            <Link to={`/messages?c=${encodeURIComponent(d.id)}`} onClick={onClose} className={buttonClass({ variant: "tonal", size: "md", className: "mr-auto" })}>
              <IconChat className="icon size-5" /> Chat
            </Link>
          )}
          {isNew && <span className="mr-auto" />}
          <Button variant="text" onClick={onClose}>Cancel</Button>
          <Button onClick={save}>Save</Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <Field
          label="Name"
          hint={d.nameSource === "contact" ? "From your phone contacts" : d.nameSource === "whatsapp" ? "Their WhatsApp name. Save them in your phone, or edit it here." : d.nameSource === "manual" ? "Set by you. WhatsApp won't change it." : undefined}
        >
          <TextInput value={d.name ?? ""} onChange={(e) => setD({ ...d, name: e.target.value })} autoFocus={isNew} />
        </Field>
        <Field label="WhatsApp number" hint={isNew ? "With country code, e.g. 9198xxxxxxxx" : "Linked to their WhatsApp; can't be changed"}>
          <TextInput value={isNew ? (d.phone ?? "") : d.phone ? `+${d.phone}` : "Hidden by WhatsApp (privacy)"} disabled={!isNew} inputMode="tel" onChange={(e) => setD({ ...d, phone: e.target.value })} />
        </Field>
        <Field label="Experience">
          <Segmented value={d.tier ?? "open"} onChange={(t) => setD({ ...d, tier: t })} options={TIERS} />
        </Field>
        <Field label="List" hint="Requests from hosts, ignored or banned comics are held back automatically. You can still allow them one by one.">
          <Segmented
            value={d.list ?? "none"}
            onChange={(v) => setD({ ...d, list: v === "none" ? null : (v as ComicList) })}
            options={[
              { value: "none", label: "None" },
              { value: "host", label: "Host" },
              { value: "ignored", label: "Ignore" },
              { value: "banned", label: "Ban" },
            ]}
          />
        </Field>
        {shows.length > 0 && (
          <Field label="Regular at" hint="Regulars stay in the show's WhatsApp group even in weeks they're not on.">
            <div className="flex flex-wrap gap-1.5">
              {shows.map((s) => (
                <Chip key={s.id} selected={(d.regularOf ?? []).includes(s.id)} onClick={() => toggleShow(s.id)} icon={(d.regularOf ?? []).includes(s.id) ? IconStar : undefined}>
                  {s.name}
                </Chip>
              ))}
            </div>
          </Field>
        )}
        {d.profile && (d.profile.scene || d.profile.years || d.profile.travelling) && (
          <div className="flex flex-wrap gap-1.5">
            {d.profile.scene && <Chip>{d.profile.scene} scene</Chip>}
            {d.profile.years ? <Chip>{d.profile.years} yr{d.profile.years === 1 ? "" : "s"} in comedy</Chip> : null}
            {d.profile.travelling && <Chip tone="tertiary">Travelling</Chip>}
          </div>
        )}
        {!isNew && (
          <div>
            <div className="mb-2 flex items-center justify-between type-label-l text-on-surface-variant">
              <span>Spot history</span>
              {cancellations(history) > 0 && <span className="text-error">{cancellations(history)} cancelled</span>}
            </div>
            {d.id && <Button size="sm" variant="tonal" icon={IconHistory} className="mb-2" onClick={() => setPastOpen(true)}>Add a past spot</Button>}
            {history?.length ? (
              <ul className="overflow-hidden rounded-md bg-surface-container">
                {history.slice(0, 8).map((h) => {
                  // A confirmed spot is only "performed" once the show date has passed.
                  const label = h.status === "cancelled" ? "Cancelled" : h.status === "canned" ? "Mic didn't happen" : h.date > today ? "Booked" : h.date === today ? "Tonight" : h.adhoc ? "Performed · ad hoc" : "Performed";
                  return (
                    <li key={`${h.date}-${h.showId}`} className="flex items-center gap-3 border-b border-outline-variant/40 px-3 py-2 last:border-0">
                      <span className="w-16 type-label-m tabular text-on-surface-variant">{formatDate(h.date)}</span>
                      <span className="flex-1 truncate type-body-m">{h.showName}</span>
                      <span className={cx("type-label-m", label.startsWith("Performed") ? "text-primary" : label === "Cancelled" ? "text-error" : label === "Mic didn't happen" ? "text-on-surface-variant" : "text-tertiary")}>{label}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="type-body-s text-on-surface-variant">No spots yet. History builds as you confirm lineups.</p>
            )}
          </div>
        )}
        <Field label="Notes"><TextArea value={d.notes ?? ""} onChange={(e) => setD({ ...d, notes: e.target.value })} placeholder="Closer material, good with crowd work…" /></Field>
      </div>
      {d.id && <PastSpotSheet open={pastOpen} onClose={() => setPastOpen(false)} comic={d as Comic} />}
    </Sheet>
  );
}
