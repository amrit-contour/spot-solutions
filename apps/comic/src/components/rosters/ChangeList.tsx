import { useMemo } from "react";
import { changeTitle, describeChange, type RosterChange } from "@spot/shared";
import { Button, Chip } from "@spot/ui";
import { CheckRow, ListGroup, SectionHeader } from "../ui";

const OP: Record<RosterChange["op"], { label: string; tone: "success" | "primary" | "error" }> = {
  added: { label: "Added", tone: "success" },
  changed: { label: "Changed", tone: "primary" },
  removed: { label: "Removed", tone: "error" },
};

/** The words under a change: "9 PM → 8:30 PM", "+ new-comics", or what a new show or room holds. Never raw values. */
export function ChangeDetail({ change }: { change: RosterChange }) {
  const t = describeChange(change);
  const line = t.diff ? <>{t.diff}</> : t.from !== undefined || t.to !== undefined ? (
    <>{t.from !== undefined && t.from}{t.from !== undefined && t.to !== undefined && <span aria-label="becomes"> → </span>}{t.to !== undefined && t.to}</>
  ) : t.summary ? <>{t.summary}</> : null;
  return line ? <span className="break-words">{line}</span> : null;
}

const groupOf = (c: RosterChange) => (c.level === "curator" ? "Curators" : c.label.split(" · ")[0]!);

/** Ticked by default: what is new or different. Removals start unticked so a partial roster never deletes a room by accident. */
export const defaultPicks = (changes: RosterChange[]) => new Set(changes.filter((c) => c.op !== "removed").map((c) => c.id));

/** The list of changes with a checkbox each, grouped by room. Same look as the import review. */
export function ChangeList({ changes, picked, onPick, verb = "Added" }: { changes: RosterChange[]; picked: Set<string>; onPick: (next: Set<string>) => void; verb?: string }) {
  const groups = useMemo(() => {
    const m = new Map<string, RosterChange[]>();
    for (const c of changes) m.set(groupOf(c), [...(m.get(groupOf(c)) ?? []), c]);
    return [...m.entries()];
  }, [changes]);
  const toggle = (ids: string[], on: boolean) => {
    const n = new Set(picked);
    for (const id of ids) {
      if (on) n.add(id);
      else n.delete(id);
    }
    onPick(n);
  };
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="tonal" onClick={() => toggle(changes.map((c) => c.id), true)}>Select all</Button>
        <Button size="sm" variant="outlined" onClick={() => toggle(changes.map((c) => c.id), false)}>Select none</Button>
      </div>
      {groups.map(([group, list]) => (
        <section key={group} className="flex min-w-0 flex-col gap-2">
          <SectionHeader
            title={group}
            action={
              <Button size="sm" variant="text" onClick={() => toggle(list.map((c) => c.id), !list.every((c) => picked.has(c.id)))}>
                {list.every((c) => picked.has(c.id)) ? "None" : "All"}
              </Button>
            }
          />
          <ListGroup>
            {list.map((c) => (
              <CheckRow
                key={c.id}
                checked={picked.has(c.id)}
                onChange={(on) => toggle([c.id], on)}
                lead={<Chip tone={OP[c.op].tone} className="flex-none">{c.op === "added" ? verb : OP[c.op].label}</Chip>}
                title={changeTitle(c)}
                detail={<ChangeDetail change={c} />}
              />
            ))}
          </ListGroup>
        </section>
      ))}
    </div>
  );
}
