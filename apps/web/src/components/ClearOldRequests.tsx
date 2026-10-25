import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { formatDate, shiftWeek } from "@spot/shared";
import { useApp } from "../lib/app";
import { countOldRequests, deleteOldRequests } from "../lib/cleanup";
import { ConfirmDialog } from "./ConfirmDialog";
import { Field, Select } from "./ui";

const plural = (n: number) => `${n} request${n === 1 ? "" : "s"}`;

/** Delete requests from weeks before a chosen week. Lineups, comics and history are kept. */
export function ClearOldRequests({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { uid, currentWeek } = useApp();
  const [before, setBefore] = useState(currentWeek);
  const [count, setCount] = useState<number | null>(null);
  const options = useMemo(
    () => Array.from({ length: 27 }, (_, k) => shiftWeek(currentWeek, -k)).map((w, k) => ({ value: w, label: k === 0 ? `Before this week (${formatDate(w)})` : `Before the week of ${formatDate(w)}` })),
    [currentWeek],
  );

  useEffect(() => {
    if (!open) return;
    let live = true;
    setCount(null);
    countOldRequests(uid, before)
      .then((n) => live && setCount(n))
      .catch((e) => live && (toast.error((e as Error).message), setCount(0)));
    return () => {
      live = false;
    };
  }, [open, uid, before]);

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title="Clear old requests?"
      confirmLabel={count ? `Delete ${plural(count)}` : "Delete"}
      disabled={!count}
      onConfirm={async () => {
        const n = await deleteOldRequests(uid, before);
        toast.success(`Deleted ${plural(n)}`);
      }}
    >
      <Field label="Delete requests from before">
        <Select value={before} onChange={setBefore} options={options} />
      </Field>
      <p>
        {count === null ? "Counting…" : count ? <><span className="text-on-surface">{plural(count)}</span> will be deleted for good.</> : "No requests that old."} Lineups, comics and their history stay as they are.
      </p>
    </ConfirmDialog>
  );
}
