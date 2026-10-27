import { useState } from "react";
import { toast } from "sonner";
import type { PublishedRosterDoc } from "@spot/shared";
import { Button, IconButton, IconTrash, Sheet } from "@spot/ui";
import { setCoMaintainers } from "../../lib/rosters";
import type { MemberEntry } from "../../lib/members";
import { MemberPicker } from "../MemberPicker";
import { ListGroup, ListRow, Notice } from "../ui";

/** Owner only: who else approves suggestions. They don't need to be publishers. */
export function MaintainersSheet({ roster, open, onClose }: { roster: PublishedRosterDoc; open: boolean; onClose: () => void }) {
  const [picked, setPicked] = useState<MemberEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const names = roster.maintainerNames ?? {};

  const save = async (uids: string[], map: Record<string, string>) => {
    await setCoMaintainers(roster, uids, Object.fromEntries(uids.map((u) => [u, map[u] ?? "Member"])));
  };

  const add = async () => {
    setError("");
    setBusy(true);
    try {
      const m = picked;
      if (!m) return;
      if (m.uid === roster.ownerUid) throw new Error("They own this roster already.");
      if (roster.coMaintainers.includes(m.uid)) throw new Error("They are a co-maintainer already.");
      await save([...roster.coMaintainers, m.uid], { ...names, [m.uid]: m.name ?? m.email });
      toast.success(`${m.name ?? m.email} can now approve suggestions`);
      setPicked(null);
    } catch (e) {
      setError(e instanceof Error && !/permission|insufficient/i.test(e.message) ? e.message : "Couldn't add them. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (uid: string) => {
    try {
      await save(roster.coMaintainers.filter((u) => u !== uid), names);
      toast("Removed");
    } catch {
      toast.error("Couldn't remove them. Try again.");
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Co-maintainers" footer={<Button variant="text" onClick={onClose}>Done</Button>}>
      <div className="flex min-w-0 flex-col gap-6">
        <p className="type-body-l text-on-surface-variant">Co-maintainers approve or reject suggestions for {roster.title}. They can't publish from their own rooms or change who maintains it.</p>
        <ListGroup>
          <ListRow title={roster.ownerName ?? "Owner"} trailing={<span className="type-label-m">Owner</span>} />
          {roster.coMaintainers.map((u) => (
            <ListRow key={u} title={names[u] ?? "Member"} className="py-1" trailing={<IconButton icon={IconTrash} label={`Remove ${names[u] ?? "this person"}`} onClick={() => void remove(u)} />} />
          ))}
        </ListGroup>
        <div className="flex min-w-0 flex-col gap-3">
          <MemberPicker label="Add a co-maintainer" hint="Anyone approved in the app. Type a name or email." value={picked} onChange={setPicked} exclude={[roster.ownerUid, ...roster.coMaintainers]} />
          {picked && <Button onClick={() => void add()} loading={busy} className="self-start">Add {picked.name}</Button>}
        </div>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Sheet>
  );
}
