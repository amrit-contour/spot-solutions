import { useMemo, useState } from "react";
import { toast } from "sonner";
import { applyMerge, diffRosters, type RosterChange, type Roster } from "@spot/shared";
import { Button, Sheet } from "@spot/ui";
import { useRoster } from "../lib/roster";
import { Notice } from "./ui";
import { ChangeList, defaultPicks } from "./rosters/ChangeList";

export interface Incoming {
  roster: Roster;
  /** "bangalore.json", "Bangalore starter". */
  source: string;
  /** Shown as a warning above the list. */
  warning?: string;
}

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
    setPicked(defaultPicks(changes));
  }

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
          {incoming.warning && <Notice tone="warn">{incoming.warning}</Notice>}
          {changes.length === 0 ? <Notice>Nothing to change. Your rooms already match this file.</Notice> : <ChangeList changes={changes} picked={picked} onPick={setPicked} />}
        </div>
      )}
    </Sheet>
  );
}
