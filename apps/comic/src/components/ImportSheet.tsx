import { useMemo, useState } from "react";
import { toast } from "sonner";
import { applyMerge, diffRosters, type RosterChange, type Roster } from "@spot/shared";
import { Button, Chip, IconWarn, Sheet, cx } from "@spot/ui";
import { useRoster } from "../lib/roster";

export interface Incoming {
  roster: Roster;
  /** "bangalore.json", "Bangalore starter". */
  source: string;
  /** Shown as a warning above the list. */
  warning?: string;
}

const OP: Record<RosterChange["op"], { label: string; tone: "success" | "primary" | "error" }> = {
  added: { label: "Added", tone: "success" },
  changed: { label: "Changed", tone: "primary" },
  removed: { label: "Removed", tone: "error" },
};

const show = (v: unknown): string => {
  if (v === undefined || v === null || v === "") return "nothing";
  if (typeof v === "string" || typeof v === "number") return String(v);
  const s = JSON.stringify(v);
  return s.length > 140 ? `${s.slice(0, 137)}...` : s;
};

/** Where a change belongs, for grouping: the room (or "Curators"). */
const groupOf = (c: RosterChange) => (c.level === "curator" ? "Curators" : c.label.split(" · ")[0]!);

/** The review before anything is written: what the file adds, changes and removes, with a checkbox each.
 * `onApplied` runs after a successful apply (before the sheet closes): community rosters use it to mark an update as seen. */
export function ImportSheet({ incoming, onClose, onApplied }: { incoming: Incoming | null; onClose: () => void; onApplied?: () => void }) {
  const store = useRoster();
  const changes = useMemo(() => (incoming ? diffRosters({ rooms: store.rooms, curators: store.curators }, incoming.roster) : []), [incoming, store.rooms, store.curators]);
  // Added and changed start ticked. Removed starts unticked: a partial file shouldn't wipe a room by accident.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [seen, setSeen] = useState<Incoming | null>(null);
  const [saving, setSaving] = useState(false);
  if (incoming !== seen) {
    setSeen(incoming);
    setPicked(new Set(changes.filter((c) => c.op !== "removed").map((c) => c.id)));
  }

  const groups = useMemo(() => {
    const m = new Map<string, RosterChange[]>();
    for (const c of changes) m.set(groupOf(c), [...(m.get(groupOf(c)) ?? []), c]);
    return [...m.entries()];
  }, [changes]);
  const toggle = (ids: string[], on: boolean) => setPicked((p) => {
    const n = new Set(p);
    for (const id of ids) on ? n.add(id) : n.delete(id);
    return n;
  });
  const count = (op: RosterChange["op"]) => changes.filter((c) => c.op === op).length;

  const apply = async () => {
    if (!incoming) return;
    setSaving(true);
    try {
      const next = applyMerge({ rooms: store.rooms, curators: store.curators }, incoming.roster, picked);
      await store.replaceRoster(next);
      toast.success(`Applied ${picked.size} change${picked.size === 1 ? "" : "s"}`);
      onApplied?.();
      onClose();
    } catch {
      toast.error("Couldn't save the import. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open={incoming !== null}
      onClose={onClose}
      wide
      title="Review the import"
      footer={
        <>
          <Button variant="text" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void apply()} loading={saving} disabled={picked.size === 0}>
            Apply {picked.size || ""}
          </Button>
        </>
      }
    >
      {incoming && (
        <div className="flex min-w-0 flex-col gap-5">
          <p className="type-body-l text-on-surface-variant">
            <span className="break-words text-on-surface">{incoming.source}</span> would add {count("added")}, change {count("changed")} and remove {count("removed")}. Nothing is saved until you apply.
          </p>
          {incoming.warning && (
            <div className="flex items-start gap-3 rounded-md bg-tertiary-container p-4 text-on-tertiary-container">
              <IconWarn aria-hidden className="icon mt-0.5 size-5 flex-none" />
              <p className="min-w-0 type-body-m whitespace-pre-line">{incoming.warning}</p>
            </div>
          )}
          {changes.length === 0 ? (
            <p className="rounded-md bg-surface-container p-4 type-body-m">Nothing to change. Your rooms already match this file.</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="tonal" onClick={() => toggle(changes.map((c) => c.id), true)}>Select all</Button>
                <Button size="sm" variant="outlined" onClick={() => toggle(changes.map((c) => c.id), false)}>Select none</Button>
              </div>
              {groups.map(([group, list]) => (
                <section key={group} className="min-w-0">
                  <div className="mb-2 flex min-w-0 items-center gap-2">
                    <h3 className="min-w-0 flex-1 truncate type-title-m">{group}</h3>
                    <Button size="sm" variant="text" onClick={() => toggle(list.map((c) => c.id), !list.every((c) => picked.has(c.id)))}>
                      {list.every((c) => picked.has(c.id)) ? "None" : "All"}
                    </Button>
                  </div>
                  <ul className="flex min-w-0 flex-col overflow-hidden rounded-md bg-surface-low">
                    {list.map((c) => (
                      <li key={c.id} className="min-w-0 border-b border-outline-variant/40 last:border-b-0">
                        <label className="state-layer flex min-h-12 min-w-0 cursor-pointer items-start gap-3 px-3 py-3">
                          <input type="checkbox" className="mt-1 size-5 flex-none accent-[var(--md-sys-color-primary)]" checked={picked.has(c.id)} onChange={(e) => toggle([c.id], e.target.checked)} />
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-2">
                              <Chip tone={OP[c.op].tone} className="flex-none">{OP[c.op].label}</Chip>
                              <span className="min-w-0 truncate type-body-l">{c.label.split(" · ").slice(1).join(" · ") || (c.level === "room" ? "The whole room" : c.label)}</span>
                            </span>
                            {c.op === "changed" && (
                              <span className={cx("mt-1 block break-words type-body-s text-on-surface-variant")}>
                                {show(c.before)} <span aria-label="becomes">→</span> {show(c.after)}
                              </span>
                            )}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}
