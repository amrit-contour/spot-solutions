import { useEffect, useMemo, useRef, useState } from "react";
import { addDoc, onSnapshot } from "firebase/firestore";
import { toast } from "sonner";
import {
  DAY_SHORT,
  RECONCILE_SKIP_TEXT,
  TTL_DAYS,
  reconcileBucket,
  reconcileTicked,
  type Command,
  type Lineup,
  type ReconcileApplyItem,
  type ReconcileApplyResult,
  type ReconcileBucket,
  type ReconcileSuggestion,
  type Show,
} from "@spot/shared";
import { useApp } from "../lib/app";
import { expireAt, runCommand, userCol } from "../lib/data";
import { isDemoUser } from "../lib/demo";
import { Bubble, Button, Chip, Sheet, cx } from "./ui";
import { IconArrowDown, IconChatCheck, IconGroup } from "./icons";

interface CheckResult {
  suggestions: ReconcileSuggestion[];
  checked: number;
  unreadable?: number;
  modelFailed?: number;
  groupErrors?: string[];
}
type Live = Command & { progress?: { chats: number; done: number; found: number }; result?: CheckResult };
type Phase =
  | { kind: "idle" }
  | { kind: "running"; progress: { chats: number; done: number; found: number } | null }
  | { kind: "review"; result: CheckResult }
  | { kind: "applying"; result: CheckResult }
  | { kind: "error"; message: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const NOT_SENT = "Nothing is sent to anyone and no groups are changed. This only makes the app match what you already did.";

const SECTIONS: { bucket: ReconcileBucket; title: string; hint: string }[] = [
  { bucket: "gave", title: "Gave a spot", hint: "You told them they're on." },
  { bucket: "group", title: "In a group, no reply found", hint: "They're in a show's group but you haven't said anything we could find. A guess, so these start unticked." },
  { bucket: "declined", title: "Declined", hint: "You told them there's no spot. They're closed without a message." },
  { bucket: "none", title: "Nothing found", hint: "No reply and not in a group." },
];

/** "Check what I've done" in the Waiting column header, and the review that follows. */
export function ReconcileButton({ lineups }: { lineups: Lineup[] }) {
  const { uid, week, shows, comicsById } = useApp();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const unsub = useRef<(() => void) | null>(null);
  const demo = isDemoUser();

  useEffect(() => () => unsub.current?.(), []);
  // A different week is a different list.
  useEffect(() => {
    unsub.current?.();
    setPhase({ kind: "idle" });
  }, [week]);

  const start = async () => {
    setPhase({ kind: "running", progress: null });
    try {
      const ref = await addDoc(userCol(uid, "commands"), { type: "reconcile_waiting", payload: { weekOf: week }, status: "pending", createdAt: Date.now(), expireAt: expireAt(TTL_DAYS.commands) } satisfies Command);
      unsub.current?.();
      unsub.current = onSnapshot(ref, (s) => {
        const d = s.data() as Live | undefined;
        if (!d) return;
        if (d.status === "done" && d.result) {
          unsub.current?.();
          setTicked(new Set(d.result.suggestions.filter(reconcileTicked).map((x) => x.requestId)));
          setPhase({ kind: "review", result: d.result });
        } else if (d.status === "error") {
          unsub.current?.();
          setPhase({ kind: "error", message: d.error ?? "The check failed" });
        } else setPhase((p) => (p.kind === "running" ? { ...p, progress: d.progress ?? null } : p));
      });
    } catch (e) {
      setPhase({ kind: "error", message: (e as Error).message });
    }
  };

  const openSheet = () => {
    setOpen(true);
    if (!demo && (phase.kind === "idle" || phase.kind === "error")) void start();
  };

  const showById = useMemo(() => new Map(shows.map((s) => [s.id, s])), [shows]);
  const result = phase.kind === "review" || phase.kind === "applying" ? phase.result : null;
  // Shows already at their slot count: ticked rows for them will be skipped, so say so up front.
  const fullShows = useMemo(() => new Set(shows.filter((s) => (lineups.find((l) => l.showId === s.id)?.slots.length ?? 0) >= s.slotCount).map((s) => s.id)), [shows, lineups]);

  const items = (): ReconcileApplyItem[] =>
    (result?.suggestions ?? [])
      .filter((s) => ticked.has(s.requestId) && s.action !== "none")
      .map((s) => (s.action === "close_declined" ? { requestId: s.requestId, action: "close_declined" } : { requestId: s.requestId, action: "place", showId: s.showId ?? undefined, markTold: s.markTold, addToGroup: s.addToGroup }));

  const apply = async () => {
    if (!result) return;
    const list = items();
    if (!list.length) return;
    setPhase({ kind: "applying", result });
    try {
      const r = await runCommand<ReconcileApplyResult>(uid, "apply_reconcile", { weekOf: week, items: list }, 3 * 60_000);
      const bits = [r.placed.length && `${plural(r.placed.length, "comic")} placed`, r.closed.length && `${r.closed.length} closed`].filter(Boolean).join(", ");
      const nameOf = (id?: string) => (id ? (comicsById.get(id)?.name ?? `+${id.split("@")[0]}`).split(" ")[0] : "Someone");
      if (r.skipped.length) {
        const why = r.skipped.slice(0, 3).map((x) => `${nameOf(x.comicId)}: ${RECONCILE_SKIP_TEXT[x.reason]}`).join("; ");
        toast.warning(`${bits || "Nothing changed"}. Skipped ${r.skipped.length}: ${why}${r.skipped.length > 3 ? "…" : ""}`);
      } else toast.success(bits || "Nothing to change");
      setOpen(false);
      setPhase({ kind: "idle" });
    } catch (e) {
      toast.error((e as Error).message);
      setPhase({ kind: "review", result });
    }
  };

  const count = items().length;
  const footer =
    result ? (
      <>
        <Button variant="outlined" disabled={phase.kind === "applying"} onClick={() => void start()}>
          Check again
        </Button>
        <Button loading={phase.kind === "applying"} disabled={!count} onClick={() => void apply()}>
          {count ? `Apply ${plural(count, "change")}` : "Nothing ticked"}
        </Button>
      </>
    ) : phase.kind === "error" && !demo ? (
      <Button onClick={() => void start()}>Try again</Button>
    ) : undefined;

  return (
    <>
      <Button size="sm" variant="tonal" icon={IconChatCheck} className="w-full" title="Looks at your own WhatsApp replies and the show groups, and suggests who to place or close. Nothing is sent." onClick={openSheet}>
        Check what I've done
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Check what I've done" footer={footer} wide>
        <div className="flex flex-col gap-5">
          <p className="type-body-m text-on-surface-variant">
            Sometimes you answer a comic or add them to the group by hand, and they still show as Waiting. This reads your own replies and the show groups for this week and suggests what to tidy. {NOT_SENT} Anyone who still needs adding to a group shows as Joining in the group panel.
          </p>
          {demo && <p className="rounded-md bg-surface-container p-4 type-body-m text-on-surface-variant">This needs a linked WhatsApp, so it's off in the demo. Sign in with Google to try it for real.</p>}
          {phase.kind === "running" && <Running progress={phase.progress} />}
          {phase.kind === "error" && !demo && <p className="rounded-md bg-error-container p-4 type-body-m text-on-error-container">{phase.message}</p>}
          {result && <Review result={result} ticked={ticked} setTicked={setTicked} showById={showById} fullShows={fullShows} busy={phase.kind === "applying"} />}
        </div>
      </Sheet>
    </>
  );
}

function Running({ progress }: { progress: { chats: number; done: number; found: number } | null }) {
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <div className="type-title-s">Reading your replies…</div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-high" role="progressbar" aria-valuemin={0} aria-valuemax={progress?.chats ?? 0} aria-valuenow={progress?.done ?? 0}>
        <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: progress?.chats ? `${Math.round((progress.done / progress.chats) * 100)}%` : "4%" }} />
      </div>
      <p className="type-body-m text-on-surface-variant tabular">{progress ? `${progress.done} of ${plural(progress.chats, "comic")} checked · ${progress.found} found so far` : "Starting. This can take a minute on your laptop."}</p>
    </div>
  );
}

function Review({ result, ticked, setTicked, showById, fullShows, busy }: { result: CheckResult; ticked: Set<string>; setTicked: (s: Set<string>) => void; showById: Map<string, Show>; fullShows: Set<string>; busy: boolean }) {
  const [noneOpen, setNoneOpen] = useState(false);
  const flip = (id: string) => {
    const next = new Set(ticked);
    if (!next.delete(id)) next.add(id);
    setTicked(next);
  };
  const by = (b: ReconcileBucket) => result.suggestions.filter((s) => reconcileBucket(s) === b);
  const notes = [
    result.unreadable ? `${plural(result.unreadable, "chat")} couldn't be read.` : "",
    result.modelFailed ? `The model failed on ${result.modelFailed}.` : "",
    result.groupErrors?.length ? `Couldn't refresh the group for ${result.groupErrors.join(", ")}.` : "",
  ].filter(Boolean);

  if (!result.checked) return <p className="rounded-md bg-surface-container p-4 type-body-m text-on-surface-variant">Nobody is waiting this week.</p>;
  return (
    <div className="flex flex-col gap-6">
      <p className="type-body-m text-on-surface-variant">Checked {plural(result.checked, "waiting comic")}. {notes.join(" ")}</p>
      {SECTIONS.map(({ bucket, title, hint }) => {
        const rows = by(bucket);
        if (!rows.length) return null;
        const collapsed = bucket === "none" && !noneOpen;
        return (
          <section key={bucket} className="flex flex-col gap-3">
            <button type="button" disabled={bucket !== "none"} onClick={() => setNoneOpen(!noneOpen)} aria-expanded={bucket === "none" ? noneOpen : undefined} className={cx("flex items-center gap-2 text-left", bucket !== "none" && "cursor-default")}>
              <h3 className="type-title-s">{title}</h3>
              <span className="rounded-full bg-surface-high px-2 py-0.5 type-label-m tabular">{rows.length}</span>
              {bucket === "none" && <IconArrowDown className={cx("icon size-4 transition-transform duration-200", noneOpen && "rotate-180")} />}
            </button>
            {!collapsed && <p className="type-body-s text-on-surface-variant">{hint}</p>}
            {!collapsed && (
              <ul className="flex flex-col gap-3">
                {rows.map((s) => (
                  <Row key={s.requestId} s={s} show={s.showId ? showById.get(s.showId) : undefined} full={Boolean(s.showId && fullShows.has(s.showId))} checked={ticked.has(s.requestId)} disabled={busy || s.action === "none"} onToggle={() => flip(s.requestId)} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Row({ s, show, full, checked, disabled, onToggle }: { s: ReconcileSuggestion; show?: Show; full: boolean; checked: boolean; disabled: boolean; onToggle: () => void }) {
  const label = show ? `${DAY_SHORT[show.weekday]} · ${show.name}` : null;
  return (
    <li className="flex items-start gap-3 rounded-md bg-surface-container p-3">
      {s.action !== "none" ? (
        <input type="checkbox" className="mt-1 size-5 flex-none accent-[var(--md-sys-color-primary)]" checked={checked} disabled={disabled} onChange={onToggle} aria-label={`Apply the change for ${s.comicName}`} />
      ) : (
        <span className="size-5 flex-none" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="type-title-s">{s.comicName}</span>
          {s.action === "place" && label && <Chip tone="primary">{label}</Chip>}
          {s.action === "close_declined" && <Chip tone="neutral">Close, no message</Chip>}
          {s.action === "place" && s.confidence === "low" && <Chip tone="reading">Lower confidence</Chip>}
          {s.addToGroup && (
            <Chip tone="tertiary" icon={IconGroup}>
              Not in the group yet
            </Chip>
          )}
          {full && s.action === "place" && <Chip tone="error">Show is full</Chip>}
        </div>
        {s.evidence && <Bubble>{s.evidence}</Bubble>}
        <p className="type-body-s text-on-surface-variant">
          {s.reason}
          {s.action === "place" && s.markTold ? ". Marked as told, so Send updates won't message them" : ""}
          {s.replies ? ` (read ${plural(s.replies, "reply")})` : ""}.
        </p>
      </div>
    </li>
  );
}
