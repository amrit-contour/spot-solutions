import type { RoomNote } from "@spot/shared";
import { Field, IconButton, IconTrash, TextInput, Menu, MenuItem, Button, IconAdd } from "@spot/ui";

const KIND_LABEL: Record<RoomNote["kind"], string> = {
  instagram: "Instagram",
  website: "Website",
  walk_in: "Walk in",
  check_bms: "Check BookMyShow",
  fcfs: "First come, first served",
  other: "Other note",
};
const KINDS = Object.keys(KIND_LABEL) as RoomNote["kind"][];

/** Ways to get a spot that aren't a WhatsApp message. They are notes the app shows, never actions. */
export function NotesEditor({ notes, onChange }: { notes: RoomNote[]; onChange: (n: RoomNote[]) => void }) {
  const set = (i: number, patch: Partial<RoomNote>) => onChange(notes.map((n, j) => (j === i ? { ...n, ...patch } : n)));
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {notes.map((n, i) => (
        <div key={i} className="flex min-w-0 items-start gap-2 rounded-md bg-surface-container p-3">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <span className="type-label-l text-on-surface-variant">{KIND_LABEL[n.kind]}</span>
            {n.kind === "instagram" && (
              <Field label="Handle" hint="Without the @.">
                <TextInput value={n.handle ?? ""} onChange={(e) => set(i, { handle: e.target.value.replace(/^@/, "") })} placeholder="comedybandar" autoCapitalize="none" autoCorrect="off" />
              </Field>
            )}
            {n.kind === "website" && (
              <Field label="Address">
                <TextInput value={n.url ?? ""} onChange={(e) => set(i, { url: e.target.value })} placeholder="https://ministryofcomedy.in" inputMode="url" autoCapitalize="none" />
              </Field>
            )}
            <Field label={n.kind === "other" ? "Note" : "Note (optional)"}>
              <TextInput value={n.text ?? ""} onChange={(e) => set(i, { text: e.target.value })} placeholder={n.kind === "website" ? "Login is on their site" : n.kind === "walk_in" ? "Registration starts at 5 PM" : "English acts only"} />
            </Field>
          </div>
          <IconButton icon={IconTrash} label={`Remove ${KIND_LABEL[n.kind]} note`} onClick={() => onChange(notes.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div>
        <Menu trigger={(open) => <Button variant="tonal" icon={IconAdd} onClick={open}>Add a way to ask</Button>}>
          {(close) => KINDS.map((k) => <MenuItem key={k} onClick={() => { onChange([...notes, { kind: k }]); close(); }}>{KIND_LABEL[k]}</MenuItem>)}
        </Menu>
      </div>
    </div>
  );
}
