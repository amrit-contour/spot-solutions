import { useMemo } from "react";
import type { RosterChange } from "@spot/shared";
import { Button, Chip } from "@spot/ui";

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
                      <Chip tone={OP[c.op].tone} className="flex-none">{c.op === "added" ? verb : OP[c.op].label}</Chip>
                      <span className="min-w-0 truncate type-body-l">{c.label.split(" · ").slice(1).join(" · ") || (c.level === "room" ? "The whole room" : c.label)}</span>
                    </span>
                    {c.op === "changed" && (
                      <span className="mt-1 block break-words type-body-s text-on-surface-variant">
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
    </div>
  );
}
