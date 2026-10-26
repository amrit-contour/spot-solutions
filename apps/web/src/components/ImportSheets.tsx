import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { getDocFromServer } from "firebase/firestore";
import { comicIdForPhone, parsePeopleFile, type WaContact } from "@spot/shared";
import { useApp } from "../lib/app";
import { isDemoUser } from "../lib/demo";
import { runCommand, userDoc } from "../lib/data";
import { importPeople, rosterLookup } from "../lib/people";
import { useGoogleSync } from "./GoogleContactsSync";
import { Avatar, Button, Chip, Empty, Spinner, cx } from "./ui";
import { Sheet } from "./ui";
import { IconCheck, IconPhone, IconSearch, IconUserPlus, IconWarn } from "./icons";

interface Row {
  key: string;
  name: string;
  phone: string;
  /** On the roster already: shown, never re-imported. */
  known: boolean;
}

const SHOWN = 300;

/** Comma-separated keywords match any of them: "comic, standup, open mic". */
const matcher = (q: string) => {
  const terms = q.toLowerCase().split(",").map((t) => t.trim()).filter(Boolean);
  if (!terms.length) return null;
  return (r: Row) => terms.some((t) => r.name.toLowerCase().includes(t) || (t.replace(/\D/g, "").length > 2 && r.phone.includes(t.replace(/\D/g, ""))));
};

function Checklist({ rows, picked, setPicked }: { rows: Row[]; picked: Set<string>; setPicked: (s: Set<string>) => void }) {
  const [q, setQ] = useState("");
  const [onlyPicked, setOnlyPicked] = useState(false);
  const filtered = useMemo(() => {
    const m = matcher(q);
    return rows.filter((r) => (!m || m(r)) && (!onlyPicked || picked.has(r.key)));
  }, [rows, q, onlyPicked, picked]);
  const searching = Boolean(matcher(q)) || onlyPicked;
  const selectable = filtered.filter((r) => !r.known);
  const pickedHere = selectable.filter((r) => picked.has(r.key)).length;
  const allOn = selectable.length > 0 && pickedHere === selectable.length;
  const hidden = picked.size - pickedHere;
  const toggle = (k: string) => {
    const n = new Set(picked);
    if (!n.delete(k)) n.add(k);
    setPicked(n);
  };
  const setMany = (on: boolean) => {
    const n = new Set(picked);
    for (const r of selectable) on ? n.add(r.key) : n.delete(r.key);
    setPicked(n);
  };
  return (
    <>
      <div className="relative">
        <IconSearch className="icon pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-on-surface-variant" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or number · commas match any: comic, standup" className="h-12 w-full rounded-full bg-surface-high pr-4 pl-12 type-body-l outline-none placeholder:text-on-surface-variant focus:shadow-[inset_0_0_0_2px_var(--md-sys-color-primary)]" />
      </div>
      <div className="mt-3 mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 type-label-l text-on-surface-variant">
        <span className="min-w-0 flex-1 tabular">
          {searching ? `${filtered.length} match${filtered.length === 1 ? "" : "es"} · ` : ""}
          {picked.size} selected{hidden > 0 ? ` (${hidden} not shown)` : ""}
        </span>
        <button type="button" onClick={() => setOnlyPicked((v) => !v)} disabled={!picked.size && !onlyPicked} className={cx("state-layer rounded-full px-3 py-1 type-label-m disabled:opacity-40", onlyPicked ? "bg-secondary-container text-on-secondary-container" : "border border-outline-variant")}>
          Selected only
        </button>
        <Button size="sm" variant="text" onClick={() => setMany(true)} disabled={allOn || !selectable.length}>
          {allOn ? "All selected" : searching ? `Select ${selectable.length - pickedHere} match${selectable.length - pickedHere === 1 ? "" : "es"}` : "Select all"}
        </Button>
        <Button size="sm" variant="text" onClick={() => setMany(false)} disabled={!pickedHere}>
          {searching ? "Clear these" : "Select none"}
        </Button>
      </div>
      {!filtered.length ? (
        <p className="py-10 text-center type-body-l text-on-surface-variant">No matches.</p>
      ) : (
        <ul className="overflow-hidden rounded-xl bg-surface-low">
          {filtered.slice(0, SHOWN).map((r, i) => (
            <li key={r.key} className={cx(i > 0 && "border-t border-outline-variant/50")}>
              <label className={cx("state-layer flex items-center gap-3 px-4 py-2.5", r.known ? "opacity-50" : "cursor-pointer")}>
                <Avatar name={r.name} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate type-title-s">{r.name}</span>
                  <span className="block type-body-s text-on-surface-variant tabular">+{r.phone}</span>
                </span>
                {r.known ? (
                  <Chip>On roster</Chip>
                ) : (
                  <input type="checkbox" className="size-5 accent-[var(--md-sys-color-primary)]" checked={picked.has(r.key)} onChange={() => toggle(r.key)} aria-label={`Import ${r.name}`} />
                )}
              </label>
            </li>
          ))}
        </ul>
      )}
      {filtered.length > SHOWN && <p className="mt-2 text-center type-body-s text-on-surface-variant">Showing {SHOWN} of {filtered.length}. Search to narrow down; Select all covers every match.</p>}
    </>
  );
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const summary = (r: { added: number; updated: number }) => [r.added && `${plural(r.added, "comic")} added`, r.updated && `${r.updated} renamed`].filter(Boolean).join(", ") || "Nothing new to add";

/** After an import: if Google Contacts saving is on, offer it (the curator confirms the counts first, nothing runs silently). */
function useOfferGoogle() {
  const { settings } = useApp();
  const sync = useGoogleSync();
  const offer = (r: { changed: { id: string; name: string; phone: string }[] }) => {
    if (!settings.googleContacts.enabled || isDemoUser() || !r.changed.length) return;
    toast("Save these names to Google Contacts too?", { duration: 15_000, action: { label: "Review", onClick: () => void sync.start(r.changed) } });
  };
  return { offer, dialog: sync.dialog };
}

export function ImportContactsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { uid, comics, comicsLoaded } = useApp();
  const [contacts, setContacts] = useState<WaContact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const find = useMemo(() => rosterLookup(comics), [comics]);
  const google = useOfferGoogle();

  const load = async () => {
    setError(null);
    setContacts(null);
    try {
      // The worker leaves the contacts in contactsImport chunks (a command result is too small for a big phonebook).
      const r = await runCommand<{ count: number; chunks: number }>(uid, "list_contacts", {}, 180_000);
      const docs = await Promise.all(Array.from({ length: r.chunks }, (_, n) => getDocFromServer(userDoc(uid, "contactsImport", `chunk${n}`))));
      setContacts(docs.flatMap((d) => (d.data()?.contacts as WaContact[] | undefined) ?? []));
      // Start empty: a phonebook is mostly not comics. Search, then select the matches.
      setPicked(new Set());
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const rows: Row[] = useMemo(() => (contacts ?? []).map((c) => ({ key: c.id, name: c.name, phone: c.phone, known: Boolean(find(c)) })), [contacts, find]);
  const save = async () => {
    setSaving(true);
    try {
      const chosen = (contacts ?? []).filter((c) => picked.has(c.id)).map((c) => ({ ...c, nameSource: "contact" as const }));
      const done = await importPeople(uid, chosen, find);
      toast.success(summary(done));
      google.offer(done);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
    <Sheet
      open={open}
      onClose={onClose}
      title="Import WhatsApp contacts"
      footer={
        <>
          <Button variant="text" onClick={onClose}>Cancel</Button>
          <Button icon={IconUserPlus} onClick={save} loading={saving} disabled={!picked.size || !comicsLoaded}>{picked.size ? `Import ${plural(picked.size, "comic")}` : "Import"}</Button>
        </>
      }
    >
      {error ? (
        <Empty icon={IconWarn} title="Couldn't read your contacts" action={<Button variant="tonal" onClick={load}>Try again</Button>}>{error}</Empty>
      ) : !contacts ? (
        <div className="flex flex-col items-center gap-3 py-16 text-on-surface-variant">
          <Spinner className="size-7 text-primary" />
          Reading your saved contacts…
        </div>
      ) : !contacts.length ? (
        <Empty icon={IconPhone} title="No saved contacts found">WhatsApp has no saved contacts for this number yet.</Empty>
      ) : (
        <>
          <p className="mb-4 type-body-m text-on-surface-variant">Your saved WhatsApp contacts. Pick who to add to your roster; nobody is messaged.</p>
          <Checklist rows={rows} picked={picked} setPicked={setPicked} />
        </>
      )}
    </Sheet>
    {google.dialog}
    </>
  );
}

export function ImportFileSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { uid, comics, comicsLoaded } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<{ file: string; people: { name: string; phone: string }[]; duplicates: number } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const find = useMemo(() => rosterLookup(comics), [comics]);
  const google = useOfferGoogle();

  useEffect(() => {
    if (!open) {
      setParsed(null);
      setPicked(new Set());
    }
  }, [open]);

  const read = async (file: File) => {
    try {
      const { people, duplicates } = parsePeopleFile(await file.text());
      if (!people.length) return toast.error("No names with phone numbers found in that file");
      setParsed({ file: file.name, people, duplicates });
      setPicked(new Set());
    } catch {
      toast.error("Couldn't read that file");
    }
  };

  const rows: Row[] = useMemo(
    () => (parsed?.people ?? []).map((p) => ({ key: p.phone, name: p.name, phone: p.phone, known: Boolean(find({ id: comicIdForPhone(p.phone), phone: p.phone })) })),
    [parsed, find],
  );
  const save = async () => {
    setSaving(true);
    try {
      // Names typed in your own file count as set by you, so WhatsApp never renames them.
      const chosen = (parsed?.people ?? []).filter((p) => picked.has(p.phone)).map((p) => ({ ...p, id: comicIdForPhone(p.phone), nameSource: "manual" as const }));
      const done = await importPeople(uid, chosen, find);
      toast.success(summary(done));
      google.offer(done);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
    <Sheet
      open={open}
      onClose={onClose}
      title="Import from a file"
      footer={
        <>
          {parsed && <Button variant="text" onClick={() => setParsed(null)} className="mr-auto">Choose another file</Button>}
          <Button variant="text" onClick={onClose}>Cancel</Button>
          <Button icon={IconUserPlus} onClick={save} loading={saving} disabled={!picked.size || !comicsLoaded}>{picked.size ? `Import ${plural(picked.size, "comic")}` : "Import"}</Button>
        </>
      }
    >
      {!parsed ? (
        <div className="flex flex-col gap-4">
          <p className="type-body-m text-on-surface-variant">Upload a CSV (name and phone columns, like a Google Contacts export) or a vCard (.vcf). It's read in your browser and you review it before anything is saved.</p>
          <input ref={input} type="file" accept=".csv,.vcf,.vcard,text/csv,text/vcard,text/x-vcard,text/plain" hidden onChange={(e) => (e.target.files?.[0] && void read(e.target.files[0]), (e.target.value = ""))} />
          <button
            onClick={() => input.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => (e.preventDefault(), e.dataTransfer.files[0] && void read(e.dataTransfer.files[0]))}
            className="state-layer flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-outline-variant type-label-l text-on-surface-variant"
          >
            <IconUserPlus className="icon size-7 text-primary" />
            Choose a .csv or .vcf file, or drop it here
          </button>
          <p className="type-body-s text-on-surface-variant">Ten-digit numbers are treated as Indian (+91). Anyone already on your roster, matched by number, is skipped.</p>
        </div>
      ) : (
        <>
          <p className="mb-4 flex items-center gap-2 type-body-m text-on-surface-variant">
            <IconCheck className="icon size-5 flex-none text-primary" />
            {parsed.people.length} {parsed.people.length === 1 ? "person" : "people"} in {parsed.file}
            {parsed.duplicates ? `. ${plural(parsed.duplicates, "repeated number")} merged.` : "."}
          </p>
          <Checklist rows={rows} picked={picked} setPicked={setPicked} />
        </>
      )}
    </Sheet>
    {google.dialog}
    </>
  );
}
