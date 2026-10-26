import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { Button, TextInput, cx } from "./ui";

/**
 * Centered confirmation, for destructive actions by default (`tone="primary"` for safe bulk ones). `children` must state exactly what goes.
 * `ack` adds a checkbox that has to be ticked; `typed` makes the user type a value first.
 */
export function ConfirmDialog({ open, onClose, title, children, confirmLabel, onConfirm, ack, typed, disabled, tone = "danger" }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; confirmLabel: string; onConfirm: () => Promise<void>; ack?: string; typed?: { expect: string; label: string }; disabled?: boolean; tone?: "danger" | "primary" }) {
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);
  const [text, setText] = useState("");

  useEffect(() => {
    if (!open) return;
    setChecked(false);
    setText("");
    const k = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, busy, onClose]);

  const ready = !disabled && (!ack || checked) && (!typed || text.trim().toLowerCase() === typed.expect.toLowerCase());
  const go = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[70] grid place-items-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.15 } }} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
          <div className="absolute inset-0 bg-scrim/40" onClick={() => !busy && onClose()} />
          <motion.div
            role="alertdialog"
            aria-modal
            aria-label={typeof title === "string" ? title : undefined}
            className="relative flex max-h-[90dvh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-xl bg-surface-high p-6 shadow-xl"
            initial={{ transform: "scale(0.96)" }}
            animate={{ transform: "scale(1)", transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
          >
            <h2 className="type-headline-s">{title}</h2>
            <div className="flex flex-col gap-3 type-body-m text-on-surface-variant">{children}</div>
            {ack && (
              <label className={cx("flex items-start gap-3 rounded-md bg-error-container/60 p-3 type-body-m text-on-error-container")}>
                <input type="checkbox" className="mt-0.5 size-5 flex-none accent-[var(--md-sys-color-error)]" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
                {ack}
              </label>
            )}
            {typed && (
              <label className="flex flex-col gap-1.5">
                <span className="type-label-l text-on-surface-variant">{typed.label}</span>
                <TextInput value={text} onChange={(e) => setText(e.target.value)} placeholder={typed.expect} autoComplete="off" spellCheck={false} />
              </label>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="text" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button variant={tone === "danger" ? "danger" : "filled"} loading={busy} disabled={!ready} onClick={() => void go()}>
                {confirmLabel}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
