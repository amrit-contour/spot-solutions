import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DAY_SHORT, curatorUsage, daysLabel, type Curator } from "@spot/shared";
import { Button, ConfirmDialog, IconPlus, IconButton, IconComics, IconPen, IconTrash, Sheet } from "@spot/ui";
import { auth } from "@spot/ui/firebase";
import { CuratorAvatar } from "../lib/photos";
import { useRoster } from "../lib/roster";
import { CuratorForm } from "./CuratorForm";
import { Card, EmptyState, Section } from "./ui";

/** Everyone who curates a show, with where and when. */
export function CuratorsPanel({ q }: { q: string }) {
  const store = useRoster();
  const usage = useMemo(() => curatorUsage(store.rooms), [store.rooms]);
  const [editing, setEditing] = useState<Curator | "new" | null>(null);
  const [removing, setRemoving] = useState<Curator | null>(null);
  const [saving, setSaving] = useState(false);
  const needle = q.trim().toLowerCase();
  const list = store.curators
    .filter((c) => !needle || c.name.toLowerCase().includes(needle) || (c.instagram ?? "").toLowerCase().includes(needle) || (usage.get(c.id) ?? []).some((u) => u.roomName.toLowerCase().includes(needle)))
    .sort((a, b) => a.name.localeCompare(b.name));

  const save = async (c: Curator) => {
    setSaving(true);
    try {
      await store.saveCurator(c);
      toast.success("Saved");
      setEditing(null);
    } catch {
      toast.error("Couldn't save. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: Curator) => {
    // Take them off every day first, so no show points at someone who is gone.
    const rooms = store.rooms.map((r) => ({ ...r, shows: r.shows.map((s) => ({ ...s, days: s.days.map((d) => ({ ...d, curatorIds: d.curatorIds.filter((id) => id !== c.id) })) })) }));
    await store.replaceRoster({ rooms, curators: store.curators.filter((x) => x.id !== c.id) });
    toast(`Removed ${c.name}`);
    setRemoving(null);
  };

  return (
    <>
      <Section title="Curators" count={list.length} action={<Button icon={IconPlus} variant="tonal" size="sm" onClick={() => setEditing("new")}>Add a curator</Button>}>
        {list.length === 0 ? (
          <EmptyState icon={IconComics} title={store.curators.length ? "No one matches" : "No curators yet"} action={!store.curators.length && <Button icon={IconPlus} onClick={() => setEditing("new")}>Add a curator</Button>}>
            {store.curators.length ? "Try another name." : "Curators are who you ask for a spot. Add them here, or while adding a show."}
          </EmptyState>
        ) : (
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
            {list.map((c) => {
              const uses = usage.get(c.id) ?? [];
              return (
                <li key={c.id}>
                  <Card pad={false}>
                    <div className="flex min-w-0 items-center gap-3 py-2 pr-2 pl-4">
                      <CuratorAvatar uid={auth.currentUser?.uid} curator={c} size={40} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate type-title-s">{c.name}</p>
                        <p className="truncate type-body-s text-on-surface-variant">
                          {[c.phone ?? "No number yet", c.instagram ? `@${c.instagram}` : null].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                      <IconButton icon={IconPen} label={`Edit ${c.name}`} onClick={() => setEditing(c)} />
                      <IconButton icon={IconTrash} label={`Remove ${c.name}`} onClick={() => setRemoving(c)} />
                    </div>
                    <div className="border-t border-outline-variant/50 px-4 py-3">
                      {uses.length === 0 ? (
                        <p className="type-body-s text-on-surface-variant">Not on any show yet.</p>
                      ) : (
                        <ul className="flex min-w-0 flex-col gap-1">
                          {uses.map((u) => (
                            <li key={`${u.roomId}/${u.showId}`} className="min-w-0 truncate type-body-m">
                              {u.roomName} <span className="text-on-surface-variant">· {u.showName} · {daysLabel(u.weekdays)}{u.primary ? "" : " (co-curator)"}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      <Sheet open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" || editing === null ? "Add a curator" : `Edit ${editing.name}`}>
        {editing !== null && <CuratorForm key={editing === "new" ? "new" : editing.id} initial={editing === "new" ? undefined : editing} existingIds={store.curators.map((c) => c.id)} onSave={(c) => void save(c)} onCancel={() => setEditing(null)} saving={saving} />}
      </Sheet>
      <ConfirmDialog open={removing !== null} onClose={() => setRemoving(null)} title={`Remove ${removing?.name ?? ""}?`} confirmLabel="Remove" onConfirm={async () => {
        if (removing) await remove(removing);
      }}>
        {removing && (usage.get(removing.id)?.length ? `They come off ${usage.get(removing.id)!.length} show${usage.get(removing.id)!.length === 1 ? "" : "s"} (${[...new Set(usage.get(removing.id)!.flatMap((u) => u.weekdays))].map((d) => DAY_SHORT[d]).join(", ")}). ` : "") + "The rooms stay."}
      </ConfirmDialog>
    </>
  );
}
