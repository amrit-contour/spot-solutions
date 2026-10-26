import { useState } from "react";
import { toast } from "sonner";
import { Button, IconAdd, IconSearch, TextInput } from "@spot/ui";
import type { Curator } from "@spot/shared";
import { useRoster } from "../lib/roster";
import { CuratorForm } from "./CuratorForm";

/** Pick a curator from the list, or add a new one right here. Inline (no popup), so it works inside a full-screen editor. */
export function CuratorPicker({ exclude, onPick, onClose }: { exclude: string[]; onPick: (id: string) => void; onClose: () => void }) {
  const store = useRoster();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const list = store.curators
    .filter((c) => !exclude.includes(c.id) && c.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  const create = async (c: Curator) => {
    setSaving(true);
    try {
      await store.saveCurator(c);
      onPick(c.id);
      onClose();
    } catch {
      toast.error("Couldn't save that curator. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  if (adding) {
    return (
      <div className="rounded-md bg-surface-container p-3">
        <CuratorForm existingIds={store.curators.map((c) => c.id)} onSave={(c) => void create(c)} onCancel={() => setAdding(false)} saving={saving} />
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md bg-surface-container p-3">
      <div className="relative">
        <IconSearch aria-hidden className="icon pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-on-surface-variant" />
        <TextInput value={q} onChange={(e) => setQ(e.target.value)} className="pl-11" placeholder="Search curators" type="search" autoFocus />
      </div>
      <ul className="max-h-52 overflow-y-auto overscroll-contain">
        {list.map((c) => (
          <li key={c.id}>
            <button onClick={() => { onPick(c.id); onClose(); }} className="state-layer flex min-h-12 w-full min-w-0 items-center gap-2 rounded-sm px-3 text-left type-body-l">
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              {c.instagram && <span className="max-w-[40%] truncate type-label-m text-on-surface-variant">@{c.instagram}</span>}
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="px-3 py-3 type-body-m text-on-surface-variant">{store.curators.length ? "No one by that name." : "No curators yet."}</li>}
      </ul>
      <div className="flex justify-between gap-2">
        <Button variant="text" onClick={onClose}>Cancel</Button>
        <Button variant="tonal" icon={IconAdd} onClick={() => setAdding(true)}>New curator</Button>
      </div>
    </div>
  );
}
