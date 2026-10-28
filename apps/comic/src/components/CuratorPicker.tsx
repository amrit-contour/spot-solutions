import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button, IconPlus, SearchSelect } from "@spot/ui";
import type { Curator } from "@spot/shared";
import { auth } from "@spot/ui/firebase";
import { CuratorAvatar } from "../lib/photos";
import { useRoster } from "../lib/roster";
import { CuratorForm } from "./CuratorForm";

/** Pick a curator (type to search) or add a new one right here. Opens straight away; closing it without a choice calls onClose. */
export function CuratorPicker({ exclude, onPick, onClose }: { exclude: string[]; onPick: (id: string) => void; onClose: () => void }) {
  const store = useRoster();
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  // Closing the list to open the "new curator" form is not a cancel.
  const switching = useRef(false);
  const options = store.curators
    .filter((c) => !exclude.includes(c.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ value: c.id, label: c.name, hint: c.instagram ? `@${c.instagram}` : undefined, keywords: `${c.phone ?? ""} ${c.instagram ?? ""}` }));
  const byId = new Map(store.curators.map((c) => [c.id, c]));

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
        <CuratorForm existingIds={store.curators.map((c) => c.id)} onSave={(c) => void create(c)} onCancel={() => { switching.current = false; setAdding(false); }} saving={saving} />
      </div>
    );
  }
  return (
    <SearchSelect
      defaultOpen
      label="Curator"
      value=""
      placeholder="Search curators"
      searchPlaceholder="Search curators"
      emptyText={store.curators.length ? "No one by that name." : "No curators yet."}
      options={options}
      onChange={(id) => {
        switching.current = true;
        onPick(id);
        onClose();
      }}
      onOpenChange={(o) => {
        if (!o && !switching.current) onClose();
      }}
      renderOption={(o) => {
        const c = byId.get(o.value);
        return c ? <CuratorAvatar uid={auth.currentUser?.uid} curator={c} size={32} /> : null;
      }}
      footer={(close) => (
        <Button
          variant="tonal"
          icon={IconPlus}
          className="w-full"
          onClick={() => {
            switching.current = true;
            setAdding(true);
            close();
          }}
        >
          New curator
        </Button>
      )}
    />
  );
}
