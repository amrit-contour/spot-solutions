import { useState } from "react";
import { toast } from "sonner";
import { buildExport, type Room, type Roster } from "@spot/shared";
import { Button, IconImport, Segmented, Sheet } from "@spot/ui";
import { downloadText } from "../lib/files";
import { CheckRow, ListGroup, SectionHeader, ToggleRow } from "./ui";

/** "Export": one sheet for CSV or JSON, all rooms or some, and a full backup (JSON with private notes). */
export function ExportSheet({ open, onClose, roster, stamp }: { open: boolean; onClose: () => void; roster: Roster; stamp: string }) {
  const [format, setFormat] = useState<"csv" | "json">("json");
  const [scope, setScope] = useState<"all" | "some">("all");
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [full, setFull] = useState(false);

  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) { setScope("all"); setSkip(new Set()); setFull(false); }
  }

  const toggle = (id: string) => setSkip((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  const chosen = roster.rooms.filter((r: Room) => !skip.has(r.id));
  const count = scope === "all" ? roster.rooms.length : chosen.length;

  const run = () => {
    const f = buildExport(roster, { format, stamp, full: format === "json" && full, roomIds: scope === "some" ? new Set(chosen.map((r) => r.id)) : undefined });
    if (!f) return toast.error(roster.rooms.length ? "Pick at least one room." : "Add a room first. There's nothing to export yet.");
    downloadText(f.filename, f.text, f.type);
    toast.success(`Exported ${count} room${count === 1 ? "" : "s"}`);
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Export rooms"
      footer={
        <>
          <Button variant="text" onClick={onClose}>Cancel</Button>
          <Button icon={IconImport} onClick={run} disabled={count === 0}>Export {count}</Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-6">
        <p className="type-body-l text-on-surface-variant">Download your rooms as a file to share, open in a spreadsheet, or keep as a backup.</p>
        <Segmented full value={format} onChange={setFormat} options={[{ value: "json", label: "JSON" }, { value: "csv", label: "CSV spreadsheet" }]} />
        <Segmented full value={scope} onChange={setScope} options={[{ value: "all", label: "All rooms" }, { value: "some", label: "Choose rooms" }]} />
        {format === "json" && (
          <ToggleRow label="Include my private notes" hint="A full backup: your notes, role and spots too, so you can restore it. Leave off to share the file with someone." checked={full} onChange={setFull} />
        )}
        {format === "csv" && <p className="type-body-s text-on-surface-variant">A spreadsheet only has the shareable fields. Choose JSON for a backup with your private notes.</p>}
        {scope === "some" && (
          <section className="flex min-w-0 flex-col gap-2">
            <SectionHeader title="Rooms" count={chosen.length} action={<Button size="sm" variant="text" onClick={() => setSkip(skip.size ? new Set() : new Set(roster.rooms.map((r) => r.id)))}>{skip.size ? "All" : "None"}</Button>} />
            <ListGroup>
              {roster.rooms.map((r) => (
                <CheckRow key={r.id} checked={!skip.has(r.id)} onChange={() => toggle(r.id)} title={r.name} detail={[r.area, r.city].filter(Boolean).join(" · ") || undefined} />
              ))}
            </ListGroup>
          </section>
        )}
      </div>
    </Sheet>
  );
}
