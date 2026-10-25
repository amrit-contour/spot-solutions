import { toast } from "sonner";
import type { LineupResetPlan, Show } from "@spot/shared";
import { formatDate } from "@spot/shared";
import { useApp } from "../lib/app";
import { applyResets } from "../lib/cleanup";
import { ConfirmDialog } from "./ConfirmDialog";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Confirms clearing one show's lineup or the whole week. `plans` only holds lineups that have comics. */
export function ResetDialog({ open, onClose, plans, shows, scope }: { open: boolean; onClose: () => void; plans: LineupResetPlan[]; shows: Show[]; scope: "show" | "week" }) {
  const { uid, week } = useApp();
  const comics = plans.reduce((n, p) => n + p.cleared, 0);
  const requests = plans.reduce((n, p) => n + p.requestResets.length, 0);
  const sent = plans.filter((p) => p.confirmed);
  const name = (id: string) => shows.find((s) => s.id === id)?.name ?? "Show";

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={scope === "show" ? `Reset ${shows[0]?.name ?? "show"}?` : `Reset the week of ${formatDate(week)}?`}
      confirmLabel={scope === "show" ? "Reset lineup" : `Reset ${plural(plans.length, "lineup")}`}
      disabled={!plans.length}
      ack={sent.length ? `I know ${sent.map((p) => name(p.showId)).join(", ")} already ${sent.length === 1 ? "has" : "have"} confirmations sent.` : undefined}
      onConfirm={async () => {
        await applyResets(uid, plans);
        toast.success(`Cleared ${plural(comics, "comic")}. Nothing was sent.`);
      }}
    >
      {plans.length ? (
        <>
          <ul className="flex flex-col gap-1 rounded-md bg-surface-container px-4 py-3">
            {plans.map((p) => (
              <li key={p.lineupId} className="flex items-baseline justify-between gap-3">
                <span className="truncate text-on-surface">{name(p.showId)}</span>
                <span className="flex-none tabular">{plural(p.cleared, "comic")}</span>
              </li>
            ))}
          </ul>
          <p>
            This takes {plural(comics, "comic")} off the lineup and moves {requests === 1 ? "their request" : `${requests} requests`} back to Waiting. No one is messaged.
          </p>
          {sent.length > 0 && (
            <p className="text-error">
              {sent.map((p) => name(p.showId)).join(", ")} {sent.length === 1 ? "was" : "were"} already confirmed, so those comics have been told they're on. Resetting reopens {sent.length === 1 ? "it" : "them"} as a draft. They won't be told anything.
            </p>
          )}
        </>
      ) : (
        <p>Nothing to reset. No one is placed.</p>
      )}
    </ConfirmDialog>
  );
}
