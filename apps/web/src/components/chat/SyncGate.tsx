// "Not synced yet" safety for anything that acts on a chat (send, react, send a photo, Done, Never read, Needs reply).
// While what is on screen is a saved copy (or the last sync failed or went stale) the page says so, and an action asks first.
// If the sync finishes while the question is open, the action simply goes ahead.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import { savedFromLabel } from "@spot/shared";
import { Button, IconWarn, Spinner } from "@spot/ui";

/** The inline strip: shown while what you see may be behind. */
export function SyncBanner({ savedAt, now, tz, syncing, onRetry }: { savedAt: number | null; now: number; tz: string; syncing: boolean; onRetry: () => void }) {
  return (
    <div role="status" className="flex flex-none items-center gap-2 bg-tertiary-container px-4 py-2 text-on-tertiary-container">
      {syncing ? <Spinner className="size-4 flex-none" /> : <IconWarn className="icon size-4 flex-none" />}
      <p className="min-w-0 flex-1 type-body-s">{savedAt ? `Showing saved messages from ${savedFromLabel(savedAt, now, tz)}. New ones may be missing.` : "Not synced yet. What you see may be out of date."}</p>
      {!syncing && (
        <button type="button" onClick={onRetry} className="state-layer -my-1 -mr-2 flex-none rounded-full px-3 py-1.5 type-label-l">
          Sync now
        </button>
      )}
    </div>
  );
}

interface Pending {
  run: () => void;
  verb: string;
  anyway: string;
  waiting: boolean;
}

/**
 * `guard(run, ...)` runs `run` at once when `ok`, else asks. `dialog` is the in-page question to render once.
 * `sync` is what "Wait for sync" and "Sync now" call.
 */
export function useSyncGate(ok: boolean, sync: () => void, savedAt: number | null, now: number, tz: string) {
  const [pending, setPending] = useState<Pending | null>(null);
  const okRef = useRef(ok);
  okRef.current = ok;
  const guard = useCallback((run: () => void, opts: { verb?: string; anyway?: string } = {}) => {
    if (okRef.current) return run();
    setPending({ run, verb: opts.verb ?? "go ahead", anyway: opts.anyway ?? "Continue anyway", waiting: false });
  }, []);
  // The sync finished while the question was open: carry on as normal.
  useEffect(() => {
    if (ok && pending) {
      const run = pending.run;
      setPending(null);
      run();
    }
  }, [ok, pending]);

  const dialog = pending
    ? createPortal(
        <motion.div className="fixed inset-0 z-[70] grid place-items-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.15 } }}>
          <div className="absolute inset-0 bg-scrim/40" onClick={() => setPending(null)} />
          <motion.div
            role="alertdialog"
            aria-modal
            aria-label="Not synced yet"
            className="relative flex w-full max-w-sm flex-col gap-3 rounded-xl bg-surface-high p-6 shadow-xl"
            initial={{ transform: "scale(0.96)" }}
            animate={{ transform: "scale(1)", transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
          >
            <h2 className="type-headline-s">Not synced yet — {pending.verb} anyway?</h2>
            <p className="type-body-m text-on-surface-variant">{savedAt ? `You're looking at saved messages from ${savedFromLabel(savedAt, now, tz)}. Something newer may have arrived.` : "This page hasn't read WhatsApp yet, so what you see may be out of date."}</p>
            {pending.waiting && (
              <p role="status" className="flex items-center gap-2 type-body-m text-on-surface-variant">
                <Spinner className="size-4" /> Waiting for sync. It will go ahead by itself.
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              {pending.waiting ? (
                <Button variant="text" onClick={() => setPending(null)}>Cancel</Button>
              ) : (
                <Button
                  variant="text"
                  onClick={() => {
                    setPending({ ...pending, waiting: true });
                    sync();
                  }}
                >
                  Wait for sync
                </Button>
              )}
              <Button
                onClick={() => {
                  const run = pending.run;
                  setPending(null);
                  run();
                }}
              >
                {pending.anyway}
              </Button>
            </div>
          </motion.div>
        </motion.div>,
        document.body,
      )
    : (null as ReactNode);
  return { guard, dialog };
}
