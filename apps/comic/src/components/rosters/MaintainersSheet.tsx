import { useState } from "react";
import { toast } from "sonner";
import type { PublishedRosterDoc } from "@spot/shared";
import { Button, IconButton, IconTrash, Sheet } from "@spot/ui";
import { setCoMaintainers } from "../../lib/rosters";
import type { MemberEntry } from "../../lib/members";
import { MemberPicker } from "../MemberPicker";

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
        <ul className="flex min-w-0 flex-col overflow-hidden rounded-md bg-surface-low">
          <li className="flex min-h-12 min-w-0 items-center gap-3 border-b border-outline-variant/40 px-3 py-2">
            <span className="min-w-0 flex-1 truncate type-body-l">{roster.ownerName ?? "Owner"}</span>
            <span className="type-label-m text-on-surface-variant">Owner</span>
          </li>
          {roster.coMaintainers.map((u) => (
            <li key={u} className="flex min-h-12 min-w-0 items-center gap-3 border-b border-outline-variant/40 px-3 py-1 last:border-b-0">
              <span className="min-w-0 flex-1 truncate type-body-l">{names[u] ?? "Member"}</span>
              <IconButton icon={IconTrash} label={`Remove ${names[u] ?? "this person"}`} onClick={() => void remove(u)} />
            </li>
          ))}
        </ul>
        <div className="flex min-w-0 flex-col gap-3">
          <MemberPicker label="Add a co-maintainer" hint="Anyone approved in the app. Type a name or email." value={picked} onChange={setPicked} exclude={[roster.ownerUid, ...roster.coMaintainers]} />
          {picked && <Button onClick={() => void add()} loading={busy} className="h-12 self-start">Add {picked.name}</Button>}
        </div>
        {error && <p role="alert" className="rounded-md bg-error-container p-4 type-body-m text-on-error-container">{error}</p>}
      </div>
    </Sheet>
  );
}
