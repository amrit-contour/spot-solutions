import { useMemo, useState } from "react";
import { deleteDoc, setDoc } from "firebase/firestore";
import { motion } from "motion/react";
import { toast } from "sonner";
import { formatDate, shiftWeek, type Comic, type Tier } from "@spot/shared";
import { useApp } from "../lib/app";
import { userDoc } from "../lib/data";
import { PageHeader } from "../components/Shell";
import { Avatar, Button, Chip, Empty, Field, IconButton, Segmented, Sheet, TextArea, TextInput, cx } from "../components/ui";
import { IconComics, IconCrown, IconHistory, IconPen, IconSearch, IconStar, IconTrash, IconUserPlus } from "../components/icons";

const TIERS: { value: Tier; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "regular", label: "Regular" },
  { value: "featured", label: "Featured" },
];

export function Comics() {
  const { comics, currentWeek, shows } = useApp();
  const [q, setQ] = useState("");
  const [tier, setTier] = useState<Tier | "all">("all");
  const [editing, setEditing] = useState<Partial<Comic> | null>(null);
  const lastWeek = shiftWeek(currentWeek, -1);

  const list = useMemo(
    () =>
      comics
        .filter((c) => (tier === "all" || c.tier === tier) && (c.name.toLowerCase().includes(q.toLowerCase()) || c.phone.includes(q)))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [comics, q, tier],
  );

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Comics" subtitle={`${comics.length} on your roster. New faces are added when they message you.`} actions={<Button icon={IconUserPlus} onClick={() => setEditing({ tier: "open" })}>Add comic</Button>}>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <div className="relative min-w-60 flex-1">
            <IconSearch className="icon pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-on-surface-variant" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or number" className="h-12 w-full rounded-full bg-surface-high pr-4 pl-12 type-body-l outline-none placeholder:text-on-surface-variant focus:shadow-[inset_0_0_0_2px_var(--md-sys-color-primary)]" />
          </div>
          <Segmented size="sm" value={tier} onChange={setTier} options={[{ value: "all", label: "All" }, ...TIERS]} />
        </div>
      </PageHeader>

      <div className="px-4 pb-12 sm:px-8">
        {!list.length ? (
          <Empty icon={IconComics} title={comics.length ? "No matches" : "No comics yet"}>
            {comics.length ? "Try a different search." : "Once someone asks for a spot, they're added here automatically. You can also add people by hand."}
          </Empty>
        ) : (
          <motion.ul className="overflow-hidden rounded-xl bg-surface-low" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.02 } } }}>
            {list.map((c, i) => (
              <motion.li key={c.id} variants={{ hidden: { opacity: 0 }, show: { opacity: 1 } }} className={cx(i > 0 && "border-t border-outline-variant/50")}>
                <button onClick={() => setEditing(c)} className="state-layer flex w-full items-center gap-4 px-4 py-3 text-left sm:px-5">
                  <Avatar name={c.name} size={40} tone={c.tier === "featured" ? "tertiary" : c.tier === "regular" ? "secondary" : "primary"} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate type-title-m">{c.name}</span>
                      {c.tier === "featured" && <IconCrown className="icon size-4 text-tertiary" />}
                      {c.tier === "regular" && <IconStar className="icon size-4 text-secondary" />}
                    </span>
                    <span className="block type-body-s text-on-surface-variant tabular">+{c.phone}</span>
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
                  <IconPen className="icon size-5 text-on-surface-variant" />
                </button>
              </motion.li>
            ))}
          </motion.ul>
        )}
      </div>
      <ComicEditor value={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function ComicEditor({ value, onClose }: { value: Partial<Comic> | null; onClose: () => void }) {
  const { uid, shows } = useApp();
  const [d, setD] = useState<Partial<Comic>>({});
  const [last, setLast] = useState<Partial<Comic> | null>(null);
  if (value !== last) {
    setLast(value);
    if (value) setD(value);
  }
  const isNew = !d.id;

  const save = async () => {
    const phone = (d.phone ?? "").replace(/\D/g, "");
    if (!d.name?.trim() || phone.length < 10) return toast.error("Name and a full phone number with country code, please");
    const full = phone.length === 10 ? `91${phone}` : phone;
    const id = d.id ?? `${full}@c.us`;
    const regularOf = d.regularOf ?? [];
    await setDoc(userDoc(uid, "comics", id), { ...d, id, phone: full, tier: d.tier ?? "open", regularOf, lastPerformedWeek: d.lastPerformedWeek ?? null });
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
          {!isNew && <IconButton icon={IconTrash} label="Remove" onClick={remove} className="mr-auto text-error" />}
          <Button variant="text" onClick={onClose}>Cancel</Button>
          <Button onClick={save}>Save</Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <Field label="Name"><TextInput value={d.name ?? ""} onChange={(e) => setD({ ...d, name: e.target.value })} autoFocus={isNew} /></Field>
        <Field label="WhatsApp number" hint={isNew ? "With country code, e.g. 9198xxxxxxxx" : "Linked to their WhatsApp; can't be changed"}>
          <TextInput value={d.phone ?? ""} disabled={!isNew} inputMode="tel" onChange={(e) => setD({ ...d, phone: e.target.value })} />
        </Field>
        <Field label="Experience">
          <Segmented value={d.tier ?? "open"} onChange={(t) => setD({ ...d, tier: t })} options={TIERS} />
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
        <Field label="Notes"><TextArea value={d.notes ?? ""} onChange={(e) => setD({ ...d, notes: e.target.value })} placeholder="Closer material, good with crowd work…" /></Field>
      </div>
    </Sheet>
  );
}
