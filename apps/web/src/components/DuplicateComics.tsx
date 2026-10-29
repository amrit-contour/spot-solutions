// "Possible duplicates" on the Comics page: the same person stored as two comic docs (a phone id and an @lid, or the same number
// saved twice), or two numbers under the same name. Merge keeps the doc WhatsApp can reach and moves everything onto it (worker
// command merge_comics). The safe cases (same number, same WhatsApp account) the worker also merges by itself (mergeComics.ts).
// "Not same person" / "Not this person" are stored as pairs of comic ids in users/{uid}.settings.dupDismissed, so they follow the
// account across devices and the worker's automatic merge respects them.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { arrayRemove, arrayUnion, doc, setDoc } from "firebase/firestore";
import { dismissedPairs, duplicateSuggestions, mergeComics, pairKeysFromSetKeys, pairKeysWithin, splitPairKeys, type Comic, type DuplicateSet } from "@spot/shared";
import { Button, ConfirmDialog, Segmented, Sheet, cx } from "@spot/ui";
import { IconUserCheck, IconUserMinus, IconWarn } from "@spot/ui";
import { db } from "@spot/ui/firebase";
import { useApp } from "../lib/app";
import { isDemoUser } from "../lib/demo";
import { runCommand } from "../lib/data";

const numberOf = (c: Comic) => (c.phone ? `+${c.phone}` : "Number hidden by WhatsApp");

type MergeResult = { merged: number; name?: string; moved?: { requests: number; lineups: number; shows: number; offers: number; actions: number } };

/** Pairs the curator said are different people (synced on the user doc). */
function useDismissed(): string[] {
  const { settings } = useApp();
  return useMemo(() => (Array.isArray(settings.dupDismissed) ? settings.dupDismissed.filter((k): k is string => typeof k === "string") : []), [settings.dupDismissed]);
}

export function useDuplicateComics(): DuplicateSet<Comic>[] {
  const { comics, shows } = useApp();
  const dismissed = useDismissed();
  // Every show's cached group members link a phone id to the @lid WhatsApp also knows them by.
  return useMemo(() => duplicateSuggestions(comics, shows.flatMap((s) => s.groupMembers?.members ?? []), dismissed), [comics, shows, dismissed]);
}

const membersOf = (s: DuplicateSet<Comic>) => [s.keep, ...s.others];
const setKey = (s: DuplicateSet<Comic>) => [...new Set(membersOf(s).map((c) => c.id))].sort().join("|");

const saveDismissed = (uid: string, add: string[], remove: string[] = []) => {
  const ref = doc(db, "users", uid);
  const ops = [add.length && setDoc(ref, { settings: { dupDismissed: arrayUnion(...add) } }, { merge: true }), remove.length && setDoc(ref, { settings: { dupDismissed: arrayRemove(...remove) } }, { merge: true })].filter(Boolean);
  return Promise.all(ops).catch((e) => void toast.error(`Couldn't save that: ${(e as Error).message}`));
};

/** Dismissals used to live in this browser only: moved to the account once, then the local copy is removed. */
const legacyKey = (uid: string) => `spot:duplicate-ignored:${uid}`;
function useMigrateLocalDismissals(uid: string) {
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(legacyKey(uid));
    } catch {
      return;
    }
    if (raw == null) return;
    let keys: string[] = [];
    try {
      keys = pairKeysFromSetKeys(JSON.parse(raw));
    } catch {
      /* junk: just drop it */
    }
    const drop = () => {
      try {
        window.localStorage.removeItem(legacyKey(uid));
      } catch {
        /* ignore */
      }
    };
    if (!keys.length) return drop();
    setDoc(doc(db, "users", uid), { settings: { dupDismissed: arrayUnion(...keys) } }, { merge: true }).then(drop, () => undefined);
  }, [uid]);
}

/** "moved 3 requests, 2 lineups": what a merge carried over, or "" when it was only the contact. */
function movedText(m: MergeResult["moved"]): string {
  if (!m) return "";
  const parts = ([["requests", "request"], ["lineups", "lineup"], ["shows", "show role"], ["offers", "offer"], ["actions", "reply"]] as const).filter(([k]) => m[k] > 0).map(([k, one]) => `${m[k]} ${one}${m[k] === 1 ? "" : "s"}`);
  return parts.length ? `moved ${parts.join(", ")}` : "";
}

interface Job {
  keepId: string;
  dropIds: string[];
  name: string;
}

// Merges run one after another, even across sheet opens (a second tap waits for the first). Ids being merged are hidden from the list.
let queue: Promise<void> = Promise.resolve();
const busy = new Set<string>();
const busyListeners = new Set<() => void>();
const setBusy = (ids: string[], on: boolean) => {
  ids.forEach((id) => (on ? busy.add(id) : busy.delete(id)));
  busyListeners.forEach((f) => f());
};
function useBusyIds(): ReadonlySet<string> {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    busyListeners.add(f);
    return () => void busyListeners.delete(f);
  }, []);
  return busy;
}

function runMerges(uid: string, jobs: Job[]) {
  const ids = jobs.flatMap((j) => [j.keepId, ...j.dropIds]);
  setBusy(ids, true);
  const t = toast.loading(jobs.length > 1 ? `Merging 1 of ${jobs.length}: ${jobs[0].name}…` : `Merging ${jobs[0].name}…`);
  queue = queue.then(async () => {
    let done = 0;
    let last: MergeResult | null = null;
    const total = { requests: 0, lineups: 0, shows: 0, offers: 0, actions: 0 };
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i];
      if (jobs.length > 1) toast.loading(`Merging ${i + 1} of ${jobs.length}: ${j.name}…`, { id: t });
      try {
        last = await runCommand<MergeResult>(uid, "merge_comics", { keepId: j.keepId, dropIds: j.dropIds }, 120_000);
        done++;
        for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += last.moved?.[k] ?? 0;
      } catch (e) {
        toast.error(`${j.name}: ${(e as Error)?.message ?? "Merge failed"}`);
      } finally {
        setBusy([j.keepId, ...j.dropIds], false);
      }
    }
    if (!done) return void toast.dismiss(t);
    const moved = movedText(total);
    const head = jobs.length === 1 ? `Merged ${last?.name ?? jobs[0].name}` : `Merged ${done} of ${jobs.length} contacts`;
    toast.success(moved ? `${head} · ${moved}` : head, { id: t });
  });
}

export function DuplicateComics() {
  const { uid, comics } = useApp();
  const all = useDuplicateComics();
  const dismissed = useDismissed();
  const busyIds = useBusyIds();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<DuplicateSet<Comic> | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [keepChoice, setKeepChoice] = useState<Record<string, string>>({});
  const [restoring, setRestoring] = useState(false);
  const [filter, setFilter] = useState<"all" | "certain" | "name">("all");
  const demo = isDemoUser();
  useMigrateLocalDismissals(uid);

  // Not memoised: `busyIds` is one shared Set that changes in place (useBusyIds re-renders on every change).
  const sets = busyIds.size ? all.filter((s) => !membersOf(s).some((c) => busyIds.has(c.id))) : all;
  const restorable = useMemo(() => dismissedPairs(comics, dismissed), [comics, dismissed]);
  const bothKinds = sets.some((s) => s.why === "name") && sets.some((s) => s.why !== "name");
  const shown = !bothKinds || filter === "all" ? sets : sets.filter((s) => (filter === "name" ? s.why === "name" : s.why !== "name"));
  const picked = shown.filter((s) => selected.has(setKey(s)));

  if (!sets.length && !open && !restorable.length) return null;

  const keeperOf = (s: DuplicateSet<Comic>) => membersOf(s).find((c) => c.id === keepChoice[setKey(s)]) ?? s.keep;
  const jobOf = (s: DuplicateSet<Comic>): Job => {
    const k = keeperOf(s);
    const rest = membersOf(s).filter((c) => c.id !== k.id);
    return { keepId: k.id, dropIds: rest.map((c) => c.id), name: mergeComics(k, rest).name };
  };
  const result = target ? jobOf(target).name : "";

  const startMerge = (picks: DuplicateSet<Comic>[]) => {
    if (!picks.length || demo) return;
    runMerges(uid, picks.map(jobOf));
    setSelected(new Set());
    setOpen(false); // the toast follows the merge; nothing waits here
  };

  const dismissWhole = (picks: DuplicateSet<Comic>[]) => {
    const keys = picks.flatMap((s) => pairKeysWithin(membersOf(s).map((c) => c.id)));
    setSelected(new Set());
    void saveDismissed(uid, keys);
    toast(picks.length > 1 ? `${picks.length} suggestions hidden` : "Hidden: not the same person", { description: "Undo any time under Not the same person." });
  };

  const notThisPerson = (s: DuplicateSet<Comic>, c: Comic) => {
    void saveDismissed(uid, splitPairKeys(membersOf(s).map((x) => x.id), [c.id]));
    toast(`${c.name} taken out of this merge`);
  };

  const toggleSelect = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <>
      {sets.length > 0 && (
        <button type="button" aria-label={`${sets.length} possible duplicate${sets.length === 1 ? "" : "s"}`} className="state-layer fixed right-6 bottom-6 z-20 flex items-center gap-3 rounded-full bg-tertiary-container px-4 py-3 text-on-tertiary-container shadow-lg" onClick={() => setOpen(true)}>
          <IconWarn className="icon size-5 flex-none" />
          <span className="type-body-m tabular">{sets.length}</span>
        </button>
      )}
      <Sheet open={open} onClose={() => setOpen(false)} title="Possible duplicates">
        <p className="mb-5 type-body-m text-on-surface-variant">Same WhatsApp account under two ids merges by itself. Different numbers need your OK.</p>

        {!sets.length ? (
          <p className="type-body-m text-on-surface-variant">No duplicates left.</p>
        ) : (
          <>
            <div className="mb-3 flex min-h-10 items-center gap-3">
              <p className="min-w-0 flex-1 truncate type-label-l text-on-surface-variant">
                {shown.length} suggestion{shown.length === 1 ? "" : "s"}
              </p>
              {bothKinds && (
                <Segmented
                  size="sm"
                  compact
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: "all", label: "All" },
                    { value: "certain", label: "Certain" },
                    { value: "name", label: "Name match" },
                  ]}
                />
              )}
            </div>

            <div className="mb-4 grid grid-cols-2 gap-2">
              <Button size="sm" variant="tonal" disabled={demo || !picked.length} onClick={() => startMerge(picked)}>
                Approve{picked.length ? ` ${picked.length}` : ""} selected
              </Button>
              <Button size="sm" variant="outlined" disabled={!picked.length} onClick={() => dismissWhole(picked)}>
                Dismiss selected
              </Button>
            </div>

            <ul className="flex flex-col gap-4">
              {shown.map((s) => {
                const k = setKey(s);
                const keep = keeperOf(s);
                const members = membersOf(s);
                return (
                  <li key={k} className="rounded-lg bg-surface-container p-4">
                    <label className="mb-1 flex items-center gap-3">
                      <input type="checkbox" className="size-5 flex-none accent-[var(--md-sys-color-primary)]" checked={selected.has(k)} onChange={() => toggleSelect(k)} />
                      <span className="type-label-l text-on-surface-variant">{s.why === "number" ? "Same number" : s.why === "name" ? "Same name, different number" : "Same WhatsApp account"}</span>
                    </label>
                    {members.length > 2 && <p className="mb-1 type-body-s text-on-surface-variant">Tap Merged in to keep that one instead. Not this person takes someone out; the rest still merge.</p>}
                    <ul className="divide-y divide-outline-variant/50">
                      {members.map((c) => {
                        const keeps = c.id === keep.id;
                        return (
                          <li key={c.id} className="flex items-center gap-3 py-2">
                            <span className="min-w-0 flex-1">
                              <span className="block truncate type-title-s">{c.name}</span>
                              <span className="block truncate type-body-s text-on-surface-variant tabular">
                                {numberOf(c)}
                                {c.history?.length ? ` · ${c.history.length} past spot${c.history.length === 1 ? "" : "s"}` : ""}
                              </span>
                              {members.length > 2 && (
                                <button type="button" className="state-layer -ml-1 mt-0.5 inline-flex h-8 items-center gap-1 rounded-full px-1.5 type-label-m text-primary" onClick={() => notThisPerson(s, c)}>
                                  <IconUserMinus className="icon size-4" />
                                  Not this person
                                </button>
                              )}
                            </span>
                            <Button
                              size="sm"
                              variant={keeps ? "tonal" : "outlined"}
                              icon={keeps ? IconUserCheck : undefined}
                              aria-pressed={keeps}
                              aria-label={keeps ? `${c.name} keeps` : `Keep ${c.name} instead`}
                              className={cx("w-[7.5rem] flex-none", keeps && "pointer-events-none")}
                              onClick={() => setKeepChoice((m) => ({ ...m, [k]: c.id }))}
                            >
                              {keeps ? "Keeps" : "Merged in"}
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Button size="sm" variant="outlined" onClick={() => dismissWhole([s])}>
                        Not same person
                      </Button>
                      <Button size="sm" variant="tonal" disabled={demo} onClick={() => setTarget(s)}>
                        {s.why === "name" ? "Same person" : "Merge into one"}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {restorable.length > 0 && (
          <div className="mt-6">
            <div className="mb-2 flex items-center justify-between">
              <p className="type-label-l text-on-surface-variant">Not the same person ({restorable.length})</p>
              <Button size="sm" variant="text" onClick={() => setRestoring(!restoring)}>
                {restoring ? "Done" : "Show"}
              </Button>
            </div>
            {restoring && (
              <ul className="flex flex-col gap-2">
                {restorable.map((p) => (
                  <li key={p.key} className="flex items-center justify-between gap-2 rounded-lg bg-surface-container py-1 pr-1 pl-3">
                    <span className="min-w-0 truncate type-body-s">
                      {p.a.name} / {p.b.name}
                    </span>
                    <Button size="sm" variant="text" onClick={() => void saveDismissed(uid, [], [p.key])}>
                      Restore
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Sheet>
      <ConfirmDialog open={Boolean(target)} onClose={() => setTarget(null)} title={`Merge into ${result}?`} confirmLabel="Merge" tone="primary" onConfirm={async () => { if (target) startMerge([target]); }}>
        <p>Everything moves onto {result}: past spots, notes, numbers, tier and regular marks, requests, lineup spots and show roles. The other {target && target.others.length > 1 ? `${target.others.length} copies are` : "copy is"} then deleted.</p>
        <p className="type-body-s">This can't be undone. Nothing changes in WhatsApp or Google Contacts, and nobody is messaged.</p>
      </ConfirmDialog>
    </>
  );
}
