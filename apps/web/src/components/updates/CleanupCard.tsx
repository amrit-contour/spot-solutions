// The cleanup asks before clearing a show's group when the show's rule says so: "Ask me", or "decide by repeat next week" with
// no answer yet (then the question is the repeat one, and its answer settles the group too).
import { useState } from "react";
import { toast } from "sonner";
import { formatDate, type Lineup, type Show } from "@spot/shared";
import { useApp } from "../../lib/app";
import { runCommand } from "../../lib/data";
import { Button } from "@spot/ui";
import { IconGroup } from "@spot/ui";
import { UpdateItem } from "./shared";

/** A pass that left people in the group: who is left and why, when it tries again, and a Retry now. */
function LeftoverCard({ lineup: l, show }: { lineup: Lineup; show: Show }) {
  const { uid } = useApp();
  const [busy, setBusy] = useState(false);
  const c = l.cleanup!;
  const pending = c.pending ?? [];
  const retry = async () => {
    setBusy(true);
    try {
      const r = await runCommand<{ removed?: number; failed?: number } | null>(uid, "cleanup_group", { lineupId: l.id }, 10 * 60_000);
      toast.success(r?.failed ? `${r.failed} still couldn't be removed from the ${show.name} group` : `The ${show.name} group is cleared`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <UpdateItem className="bg-surface-container">
      <div className="flex gap-3 px-4 pt-4">
        <IconGroup className="icon mt-0.5 size-6 flex-none text-primary" />
        <div className="min-w-0 flex-1">
          <p className="type-body-l">
            <span className="type-title-s">{show.name}</span> on {formatDate(l.date)}: {pending.length} {pending.length === 1 ? "person is" : "people are"} still in the group.
          </p>
          <ul className="mt-2 flex flex-col gap-1 type-body-s text-on-surface-variant">
            {pending.map((p) => (
              <li key={p.id}>
                <span className="text-on-surface">{p.name ?? `+${p.id.split("@")[0]}`}</span>: {p.reason}
              </li>
            ))}
          </ul>
          <p className="mt-2 type-body-s text-on-surface-variant">
            {c.retryAt ? `Trying again ${new Date(c.retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : "Not retrying any more. Remove them by hand in WhatsApp, or retry now."}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2 px-3 pb-3">
        <Button loading={busy} disabled={busy} onClick={() => void retry()} data-primary>
          Retry now
        </Button>
      </div>
    </UpdateItem>
  );
}

export function CleanupCard({ lineup: l, show }: { lineup: Lineup; show: Show }) {
  if (l.cleanup?.status === "partial") return <LeftoverCard lineup={l} show={show} />;
  return <AskCard lineup={l} show={show} />;
}

function AskCard({ lineup: l, show }: { lineup: Lineup; show: Show }) {
  const { uid } = useApp();
  const [busy, setBusy] = useState<"clear" | "keep" | null>(null);
  const reason = l.cleanup?.reason;
  const off = l.status === "cancelled" ? "was called off" : "didn't happen";
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
            {reason === "repeat" ? (
              <>
                <span className="type-title-s">{show.name}</span> on {formatDate(l.date)} {off}. Are the same comics repeating next week?
              </>
            ) : reason === "canned" ? (
              <>
                <span className="type-title-s">{show.name}</span> on {formatDate(l.date)} {off}. Clear the group?
              </>
            ) : (
              <>
                <span className="type-title-s">{show.name}</span> on {formatDate(l.date)} is done. Clear the group for next week?
              </>
            )}
          </p>
          <p className="mt-1 type-body-s text-on-surface-variant">
            {reason === "repeat" ? "Not repeating clears the group. " : ""}POCs, regulars, co-hosts and admins stay. Your after-show message goes first.
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2 px-3 pb-3">
        <Button variant="text" loading={busy === "keep"} disabled={Boolean(busy)} onClick={() => void answer(true)}>
          {reason === "repeat" ? "They're repeating" : "Keep everyone"}
        </Button>
        <Button loading={busy === "clear"} disabled={Boolean(busy)} onClick={() => void answer(false)} data-primary>
          {reason === "repeat" ? "Not repeating, clear it" : "Clear the group"}
        </Button>
      </div>
    </UpdateItem>
  );
}
