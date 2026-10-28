// "Possible duplicates" on the Comics page: the same person stored as two comic docs (a phone id and an @lid, or the same number
// saved twice). Merge keeps the doc WhatsApp can reach and moves everything onto it (worker command merge_comics).
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { findDuplicateComics, findSamePersonByName, linksFromMembers, memberKeySet, mergeComics, type Comic, type DuplicateSet } from "@spot/shared";
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
    return [...findDuplicateComics(comics, linksFromMembers(members), memberKeySet(members)), ...findSamePersonByName(comics, linksFromMembers(members), memberKeySet(members))];
  }, [comics, shows]);
}

const setKey = (s: DuplicateSet<Comic>) => [...new Set([s.keep.id, ...s.others.map((o) => o.id)])].sort().join("|");

const ignoredStorageKey = (uid: string | null | undefined) => `spot:duplicate-ignored:${uid ?? "local"}`;

function loadIgnored(uid: string | null | undefined): Set<string> {
  try {
    const raw = window.localStorage.getItem(ignoredStorageKey(uid));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveIgnored(uid: string | null | undefined, ignored: Set<string>) {
  try {
    window.localStorage.setItem(ignoredStorageKey(uid), JSON.stringify([...ignored]));
  } catch {
    /* ignore */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function DuplicateComics() {
  const { uid } = useApp();
  const sets = useDuplicateComics();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<DuplicateSet<Comic> | null>(null);
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [keepChoice, setKeepChoice] = useState<Record<string, string>>({});
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    setIgnored(loadIgnored(uid));
  }, [uid]);

  useEffect(() => {
    saveIgnored(uid, ignored);
  }, [ignored, uid]);

  const visibleSets = useMemo(() => sets.filter((s) => !ignored.has(setKey(s))), [sets, ignored]);
  const ignoredSets = useMemo(() => sets.filter((s) => ignored.has(setKey(s))), [sets, ignored]);
  const chosenKeep = (s: DuplicateSet<Comic>) => {
    const id = keepChoice[setKey(s)];
    return ([s.keep, ...s.others].find((c) => c.id === id) ?? s.keep);
  };
  const visible = visibleSets;

  if (!sets.length && !open && !ignoredSets.length) return null;
  const result = target ? mergeComics(chosenKeep(target), target.others.filter((o) => o.id !== chosenKeep(target).id)).name : "";

  const mergeOne = async (s: DuplicateSet<Comic>) => {
    const k = chosenKeep(s);
    const drops = [s.keep, ...s.others].filter((c) => c.id !== k.id).map((c) => c.id);
    await runCommand<{ merged: number }>(uid, "merge_comics", { keepId: k.id, dropIds: drops }, 120_000);
    toast.success(`Merged into ${k.name}`);
  };

  const merge = async () => {
    if (!target) return;
    const s = target;
    const k = chosenKeep(s);
    const drops = [s.keep, ...s.others].filter((c) => c.id !== k.id).map((c) => c.id);
    const r = await runCommand<{ merged: number }>(uid, "merge_comics", { keepId: k.id, dropIds: drops }, 120_000);
    toast.success(`Merged into ${k.name}${r.merged > 1 ? ` (${r.merged} duplicates)` : ""}`);
    if (sets.length <= 1) setOpen(false);
  };

  const approveSelected = async () => {
    const picks = visible.filter((s) => selected.has(setKey(s)));
    if (!picks.length) {
      toast.error("Select at least one suggestion first.");
      return;
    }
    if (isDemoUser()) return;
    for (let i = 0; i < picks.length; i++) {
      try {
        await mergeOne(picks[i]);
      } catch (e) {
        toast.error((e as Error)?.message ?? "Merge failed");
      }
      if (i < picks.length - 1) await sleep(400); // built-in lingering between merges
    }
    setSelected(new Set());
    if (visible.length <= picks.length) setOpen(false);
  };

  const dismissSelected = () => {
    setIgnored((prev) => {
      const next = new Set(prev);
      visible.filter((s) => selected.has(setKey(s))).forEach((s) => next.add(setKey(s)));
      return next;
    });
    setSelected(new Set());
  };

  const toggleSelect = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  return (
    <>
      {visible.length > 0 && (
        <button type="button" className="state-layer fixed bottom-6 right-6 z-20 flex items-center gap-3 rounded-full bg-tertiary-container px-4 py-3 text-on-tertiary-container shadow-lg" onClick={() => setOpen(true)}>
          <IconWarn className="icon size-5 flex-none" />
          <span className="type-body-m">{visible.length}</span>
        </button>
      )}
      <Sheet open={open} onClose={() => setOpen(false)} title="Possible duplicates">
        <p className="mb-5 type-body-m text-on-surface-variant">WhatsApp sometimes gives the same person as a phone number and as a hidden ID, so they end up on your roster twice. Merging keeps the one WhatsApp can reach.</p>

        <div className="mb-4 flex flex-wrap gap-2">
          <Button size="sm" variant="tonal" disabled={isDemoUser() || !selected.size} onClick={approveSelected}>Approve all selected</Button>
          <Button size="sm" variant="text" disabled={!selected.size} onClick={dismissSelected}>Dismiss selected (not same person)</Button>
        </div>

        {!sets.length ? (
          <p className="type-body-m text-on-surface-variant">No duplicates left.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {visible.map((s) => {
              const k = setKey(s);
              const keep = chosenKeep(s);
              return (
                <li key={k} className="rounded-lg bg-surface-container p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <input type="checkbox" className="size-4 accent-[var(--md-sys-color-primary)]" checked={selected.has(k)} onChange={() => toggleSelect(k)} />
                    <p className="type-label-l text-on-surface-variant">{s.why === "number" ? "Same number" : s.why === "name" ? "Same name, different number" : "Same WhatsApp contact"}</p>
                  </div>
                  <ul className="divide-y divide-outline-variant/50">
                    {[s.keep, ...s.others].map((c) => (
                      <li key={c.id} className="flex items-center gap-3 py-2">
                        <input type="radio" name={`keep-${k}`} className="size-4 accent-[var(--md-sys-color-primary)]" checked={keep.id === c.id} onChange={() => setKeepChoice((m) => ({ ...m, [k]: c.id }))} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate type-title-s">{c.name}</span>
                          <span className="block truncate type-body-s text-on-surface-variant tabular">{numberOf(c)}{c.history?.length ? ` · ${c.history.length} past spot${c.history.length === 1 ? "" : "s"}` : ""}</span>
                        </span>
                        {c.id === keep.id ? <Pill tone="told" icon={IconUserCheck}>Keeps</Pill> : <Pill tone="plain">Merged in</Pill>}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" variant="text" onClick={() => setIgnored((d) => new Set(d).add(k))}>Not same person</Button>
                    <Button size="sm" variant="tonal" className="flex-1" disabled={isDemoUser()} onClick={() => setTarget(s)}>
                      {s.why === "name" ? "Same person" : "Merge into one"}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {ignoredSets.length > 0 && (
          <div className="mt-6">
            <div className="mb-2 flex items-center justify-between">
              <p className="type-label-l text-on-surface-variant">Ignored ({ignoredSets.length})</p>
              <Button size="sm" variant="text" onClick={() => setRestoring(!restoring)}>{restoring ? "Done" : "Restore"}</Button>
            </div>
            {restoring && (
              <ul className="flex flex-col gap-2">
                {ignoredSets.map((s) => (
                  <li key={setKey(s)} className="flex items-center justify-between rounded-lg bg-surface-container px-3 py-2">
                    <span className="truncate type-body-s">{s.keep.name} / {s.others.map((o) => o.name).join(", ")}</span>
                    <Button size="sm" variant="text" onClick={() => setIgnored((prev) => { const n = new Set(prev); n.delete(setKey(s)); return n; })}>Restore</Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Sheet>
      <ConfirmDialog open={Boolean(target)} onClose={() => setTarget(null)} title={`Merge into ${result}?`} confirmLabel="Merge" onConfirm={merge}>
        <p>Everything moves onto {result}: past spots, notes, tier and regular marks, requests, lineup spots and show roles. The other {target && target.others.length > 1 ? `${target.others.length} copies are` : "copy is"} then deleted.</p>
        <p className="type-body-s">This can't be undone. Nothing changes in WhatsApp or Google Contacts, and nobody is messaged.</p>
      </ConfirmDialog>
    </>
  );
}
