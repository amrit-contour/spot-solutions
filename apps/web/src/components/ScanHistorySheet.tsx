import { useEffect, useRef, useState } from "react";
import { addDoc, onSnapshot, updateDoc } from "firebase/firestore";
import { toast } from "sonner";
import { SCAN_DAYS_MAX, SCAN_DAYS_MIN, TTL_DAYS, clampScanDays, type Command } from "@spot/shared";
import { useApp } from "../lib/app";
import { expireAt, runCommand, userCol, userDoc } from "../lib/data";
import { isDemoUser } from "../lib/demo";
import { Button, Segmented, Sheet } from "./ui";

interface ScanResult {
  chatsScanned: number;
  burstsChecked: number;
  requestsCreated: number;
  requestsUpdated: number;
  held: number;
  failed?: number;
  cancelled?: boolean;
}
type Live = Command & { progress?: { chats: number; done: number; found: number }; result?: ScanResult; cancel?: boolean };
type Phase = { kind: "idle" } | { kind: "running"; id: string; progress: { chats: number; done: number; found: number } | null; cancelling: boolean } | { kind: "done"; result: ScanResult } | { kind: "error"; message: string };

const DAY_MS = 86_400_000;
const PRESETS = [1, 3, 7, 14, 21].map((d) => ({ value: d, label: String(d) }));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Curator-triggered: read recent DMs on their own server and fill Requests. The worker never sends anything during a scan. */
export function ScanHistorySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { uid, settings } = useApp();
  const [days, setDays] = useState(() => clampScanDays(settings.scanDays));
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [chatTimes, setChatTimes] = useState<number[] | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const unsub = useRef<(() => void) | null>(null);
  const demo = isDemoUser();

  // Start from the curator's usual choice each time the sheet opens (not mid-scan).
  useEffect(() => {
    if (open && phase.kind !== "running") setDays(clampScanDays(settings.scanDays));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // When each chat last had traffic: lets the estimate follow the picker without asking again.
  useEffect(() => {
    if (!open || demo || chatTimes || previewFailed) return;
    let live = true;
    runCommand<{ chatTimes: number[] }>(uid, "scan_history", { preview: true }, 60_000)
      .then((r) => live && setChatTimes(r.chatTimes))
      .catch(() => live && setPreviewFailed(true));
    return () => {
      live = false;
    };
  }, [open, demo, uid, chatTimes, previewFailed]);

  useEffect(() => () => unsub.current?.(), []);

  const chats = chatTimes ? chatTimes.filter((t) => t >= Date.now() - days * DAY_MS).length : null;

  const start = async () => {
    try {
      const ref = await addDoc(userCol(uid, "commands"), { type: "scan_history", payload: { days }, status: "pending", createdAt: Date.now(), expireAt: expireAt(TTL_DAYS.commands) } satisfies Command);
      setPhase({ kind: "running", id: ref.id, progress: null, cancelling: false });
      unsub.current?.();
      unsub.current = onSnapshot(ref, (s) => {
        const d = s.data() as Live | undefined;
        if (!d) return;
        if (d.status === "done") {
          unsub.current?.();
          setPhase({ kind: "done", result: d.result as ScanResult });
        } else if (d.status === "error") {
          unsub.current?.();
          setPhase({ kind: "error", message: d.error ?? "The scan failed" });
        } else setPhase((p) => (p.kind === "running" ? { ...p, progress: d.progress ?? null } : p));
      });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const cancel = async () => {
    if (phase.kind !== "running") return;
    setPhase({ ...phase, cancelling: true });
    try {
      await updateDoc(userDoc(uid, "commands", phase.id), { cancel: true });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const again = () => setPhase({ kind: "idle" });
  const footer =
    phase.kind === "running" ? (
      <Button variant="outlined" loading={phase.cancelling} onClick={() => void cancel()}>
        Cancel scan
      </Button>
    ) : phase.kind === "idle" ? (
      <Button disabled={demo} onClick={() => void start()}>
        Scan {plural(days, "day")}
      </Button>
    ) : (
      <Button variant="tonal" onClick={again}>
        Scan again
      </Button>
    );

  return (
    <Sheet open={open} onClose={onClose} title="Scan past messages" footer={footer}>
      <div className="flex flex-col gap-6">
        <p className="type-body-m text-on-surface-variant">This reads your recent DMs on your own server to find spot requests. Nothing is sent to anyone, and messages that aren't spot requests aren't saved.</p>

        {demo && <p className="rounded-md bg-surface-container p-4 type-body-m text-on-surface-variant">This needs a linked WhatsApp, so it's off in the demo. Sign in with Google to try it for real.</p>}

        {(phase.kind === "idle" || demo) && (
          <div className="flex flex-col gap-4">
            <div className="type-title-s">How far back?</div>
            <Segmented value={days} onChange={setDays} options={PRESETS.map((p) => ({ ...p, label: `${p.label} ${p.value === 1 ? "day" : "days"}` }))} />
            <input type="range" min={SCAN_DAYS_MIN} max={SCAN_DAYS_MAX} value={days} onChange={(e) => setDays(clampScanDays(Number(e.target.value)))} disabled={demo} aria-label="Days to look back" className="w-full accent-primary" />
            <p className="type-body-m text-on-surface-variant">
              {previewFailed || chats === null ? `Last ${plural(days, "day")}. Takes a few minutes on your laptop.` : `Last ${plural(days, "day")}: about ${plural(chats, "chat")}; takes a few minutes on your laptop.`}
            </p>
            <p className="type-body-s text-on-surface-variant">Requests land in the week each message was sent. Your request window, ban and ignore lists still apply: anything outside them goes to Held. Requests you already placed, confirmed or closed are never changed.</p>
          </div>
        )}

        {phase.kind === "running" && (
          <div className="flex flex-col gap-3" aria-live="polite">
            <div className="type-title-s">{phase.cancelling ? "Stopping…" : "Reading your chats…"}</div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-high" role="progressbar" aria-valuemin={0} aria-valuemax={phase.progress?.chats ?? 0} aria-valuenow={phase.progress?.done ?? 0}>
              <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: phase.progress?.chats ? `${Math.round((phase.progress.done / phase.progress.chats) * 100)}%` : "4%" }} />
            </div>
            <p className="type-body-m text-on-surface-variant tabular">{phase.progress ? `${phase.progress.done} of ${plural(phase.progress.chats, "chat")} read · ${plural(phase.progress.found, "request")} found so far` : "Starting…"}</p>
            <p className="type-body-s text-on-surface-variant">You can close this. The scan keeps going on your server.</p>
          </div>
        )}

        {phase.kind === "done" && <Summary r={phase.result} />}
        {phase.kind === "error" && <p className="rounded-md bg-error-container p-4 type-body-m text-on-error-container">{phase.message}</p>}
      </div>
    </Sheet>
  );
}

function Summary({ r }: { r: ScanResult }) {
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <div className="type-title-m">{r.cancelled ? "Stopped" : "Done"}</div>
      <p className="type-body-m text-on-surface-variant">
        Read {plural(r.chatsScanned, "chat")} ({plural(r.burstsChecked, "burst")} of messages). {r.requestsCreated || r.requestsUpdated ? `${plural(r.requestsCreated, "new request")}, ${plural(r.requestsUpdated, "updated")}.` : "No new spot requests found."}
        {r.held ? ` ${r.held} of them ${r.held === 1 ? "is" : "are"} in Held.` : ""}
        {r.failed ? ` ${plural(r.failed, "chat")} could not be read.` : ""}
      </p>
    </div>
  );
}
