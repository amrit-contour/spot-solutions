// The day-after cleanup asks before clearing a show's group: when the mic didn't happen (the same comics may repeat next
// week), or when the show is set to ask every time.
import { useState } from "react";
import { toast } from "sonner";
import { formatDate, type Lineup, type Show } from "@spot/shared";
import { useApp } from "../../lib/app";
import { runCommand } from "../../lib/data";
import { Button } from "../ui";
import { IconGroup } from "../icons";
import { UpdateItem } from "./shared";

export function CleanupCard({ lineup: l, show }: { lineup: Lineup; show: Show }) {
  const { uid } = useApp();
  const [busy, setBusy] = useState<"clear" | "keep" | null>(null);
  const canned = l.cleanup?.reason === "canned";
  const answer = async (keep: boolean) => {
    setBusy(keep ? "keep" : "clear");
    try {
      const r = await runCommand<{ removed?: number; failed?: number } | null>(uid, "cleanup_group", { lineupId: l.id, keep }, 10 * 60_000);
      if (keep) toast.success(`Kept everyone in the ${show.name} group`);
      else toast.success(`Cleared the ${show.name} group${r?.removed !== undefined ? ` (${r.removed} removed)` : ""}`);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(null);
    }
  };
  return (
    <UpdateItem className="bg-surface-container">
      <div className="flex gap-3 px-4 pt-4">
        <IconGroup className="icon mt-0.5 size-6 flex-none text-primary" />
        <div className="min-w-0 flex-1">
          <p className="type-body-l">
            {canned ? (
              <>
                <span className="type-title-s">{show.name}</span> on {formatDate(l.date)} didn't happen. Clear the group, or are the same comics repeating next week?
              </>
            ) : (
              <>
                <span className="type-title-s">{show.name}</span> on {formatDate(l.date)} is done. Clear the group for next week?
              </>
            )}
          </p>
          <p className="mt-1 type-body-s text-on-surface-variant">POCs, regulars, co-hosts and admins stay. Your after-show message goes first.</p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2 px-3 pb-3">
        <Button variant="text" loading={busy === "keep"} disabled={Boolean(busy)} onClick={() => void answer(true)}>
          {canned ? "They're repeating" : "Keep everyone"}
        </Button>
        <Button loading={busy === "clear"} disabled={Boolean(busy)} onClick={() => void answer(false)} data-primary>
          Clear the group
        </Button>
      </div>
    </UpdateItem>
  );
}
