import type { Limit, RoomShow } from "@spot/shared";
import { Button, Chip, IconAdd, IconButton, IconTrash, Segmented, Select, Stepper } from "@spot/ui";
import { ToggleRow } from "./ui";
import { validateLimit } from "../lib/rooms";

const PERIODS = [
  { key: "perDay", label: "A day" },
  { key: "perWeek", label: "A week" },
  { key: "perMonth", label: "A month" },
] as const;

/** The only enforced rule: how many spots a comic can take here. Everything else is a tag. */
export function LimitsEditor({ limits, shows, onChange }: { limits: Limit[]; shows: RoomShow[]; onChange: (l: Limit[]) => void }) {
  const set = (i: number, next: Limit) => onChange(limits.map((l, j) => (j === i ? next : l)));
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {limits.map((l, i) => {
        const problem = validateLimit(l, shows);
        return (
          <div key={i} className="flex min-w-0 flex-col gap-3 rounded-md bg-surface-container p-3">
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0 flex-1">
                <Segmented
                  full
                  size="sm"
                  value={l.scope}
                  onChange={(scope) => set(i, scope === "room" ? { ...l, scope, showId: undefined } : { ...l, scope, showId: shows[0]?.id })}
                  options={[{ value: "room", label: "Whole room" }, { value: "show", label: "One show" }]}
                />
              </div>
              <IconButton icon={IconTrash} label="Remove this limit" onClick={() => onChange(limits.filter((_, j) => j !== i))} />
            </div>
            {l.scope === "show" && (
              <Select label="Which show" value={l.showId ?? ""} onChange={(showId) => set(i, { ...l, showId })} placeholder="Pick a show" options={shows.map((s) => ({ value: s.id, label: s.name || s.id }))} />
            )}
            <ToggleRow label="No limit here" checked={Boolean(l.unlimited)} onChange={(u) => set(i, u ? { scope: l.scope, showId: l.showId, unlimited: true } : { ...l, unlimited: undefined })} />
            {!l.unlimited && (
              <div className="flex min-w-0 flex-col gap-2.5">
                {PERIODS.map((p) => (
                  <div key={p.key} className="flex min-w-0 flex-wrap items-center gap-3">
                    <Chip selected={l[p.key] !== undefined} onClick={() => set(i, { ...l, [p.key]: l[p.key] === undefined ? 1 : undefined })} className="min-w-20 justify-center">
                      {p.label}
                    </Chip>
                    {l[p.key] !== undefined && <Stepper value={l[p.key]!} min={1} max={31} suffix={l[p.key] === 1 ? "spot" : "spots"} onChange={(v) => set(i, { ...l, [p.key]: v })} />}
                  </div>
                ))}
              </div>
            )}
            {problem && <p className="type-body-s text-error">{problem}</p>}
          </div>
        );
      })}
      <div>
        <Button variant="tonal" icon={IconAdd} onClick={() => onChange([...limits, { scope: "room", perMonth: 1 }])}>
          Add a limit
        </Button>
      </div>
    </div>
  );
}
