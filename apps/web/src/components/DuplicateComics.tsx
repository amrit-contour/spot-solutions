// "Possible duplicates" on the Comics page: the same person stored as two comic docs (a phone id and an @lid, or the same number
// saved twice). Merge keeps the doc WhatsApp can reach and moves everything onto it (worker command merge_comics).
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { findDuplicateComics, linksFromMembers, memberKeySet, mergeComics, type Comic, type DuplicateSet } from "@spot/shared";
import { Button, ConfirmDialog, Sheet } from "@spot/ui";
import { IconUserCheck, IconWarn } from "@spot/ui";
import { useApp } from "../lib/app";
import { isDemoUser } from "../lib/demo";
import { runCommand } from "../lib/data";
import { Pill } from "./Pills";

const numberOf = (c: Comic) => (c.phone ? `+${c.phone}` : "Number hidden by WhatsApp");

export function useDuplicateComics(): DuplicateSet<Comic>[] {
  const { comics, shows } = useApp();
  return useMemo(() => {
    // Every show's cached group members link a phone id to the @lid WhatsApp also knows them by.
    const members = shows.flatMap((s) => s.groupMembers?.members ?? []);
    return findDuplicateComics(comics, linksFromMembers(members), memberKeySet(members));
  }, [comics, shows]);
}

export function DuplicateComics() {
  const { uid } = useApp();
  const sets = useDuplicateComics();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<DuplicateSet<Comic> | null>(null);
  if (!sets.length && !open) return null;
  // The name they end up with (the best-sourced one), not necessarily the kept doc's.
  const result = target ? mergeComics(target.keep, target.others).name : "";
  const merge = async () => {
    if (!target) return;
    const r = await runCommand<{ merged: number }>(uid, "merge_comics", { keepId: target.keep.id, dropIds: target.others.map((o) => o.id) }, 120_000);
    toast.success(`Merged into ${result}${r.merged > 1 ? ` (${r.merged} duplicates)` : ""}`);
  };
  return (
    <>
      {sets.length > 0 && (
        <div className="mb-2 flex items-center gap-3 rounded-xl bg-tertiary-container px-4 py-3 text-on-tertiary-container">
          <IconWarn className="icon size-5 flex-none" />
          <p className="min-w-0 flex-1 type-body-m">
            {sets.length} possible duplicate{sets.length === 1 ? "" : "s"}: the same person saved twice.
          </p>
          <Button size="sm" variant="tonal" onClick={() => setOpen(true)}>Review</Button>
        </div>
      )}
      <Sheet open={open} onClose={() => setOpen(false)} title="Possible duplicates">
        <p className="mb-5 type-body-m text-on-surface-variant">WhatsApp sometimes gives the same person as a phone number and as a hidden ID, so they end up on your roster twice. Merging keeps the one WhatsApp can reach.</p>
        {!sets.length ? (
          <p className="type-body-m text-on-surface-variant">No duplicates left.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {sets.map((s) => (
              <li key={s.keep.id} className="rounded-lg bg-surface-container p-4">
                <p className="mb-2 type-label-l text-on-surface-variant">{s.why === "number" ? "Same number" : "Same WhatsApp contact"}</p>
                <ul className="divide-y divide-outline-variant/50">
                  {[s.keep, ...s.others].map((c) => (
                    <li key={c.id} className="flex items-center gap-3 py-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate type-title-s">{c.name}</span>
                        <span className="block truncate type-body-s text-on-surface-variant tabular">{numberOf(c)}{c.history?.length ? ` · ${c.history.length} past spot${c.history.length === 1 ? "" : "s"}` : ""}</span>
                      </span>
                      {c === s.keep ? <Pill tone="told" icon={IconUserCheck}>Keeps</Pill> : <Pill tone="plain">Merged in</Pill>}
                    </li>
                  ))}
                </ul>
                <Button className="mt-3 w-full" variant="tonal" disabled={isDemoUser()} onClick={() => setTarget(s)}>
                  Merge into one
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Sheet>
      <ConfirmDialog open={Boolean(target)} onClose={() => setTarget(null)} title={`Merge into ${result}?`} confirmLabel="Merge" onConfirm={merge}>
        <p>Everything moves onto {result}: past spots, notes, tier and regular marks, requests, lineup spots and show roles. The other {target && target.others.length > 1 ? `${target.others.length} copies are` : "copy is"} then deleted.</p>
        <p className="type-body-s">This can't be undone. Nothing changes in WhatsApp or Google Contacts, and nobody is messaged.</p>
      </ConfirmDialog>
    </>
  );
}
