import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cx } from "./ui";

/** Small anchored menu that scales from its trigger. */
export function Menu({ trigger, children, align = "left" }: { trigger: (open: () => void, isOpen: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger(() => setOpen((o) => !o), open)}
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, transform: "scale(0.96)" }}
            animate={{ opacity: 1, transform: "scale(1)", transition: { duration: 0.16, ease: [0.23, 1, 0.32, 1] } }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            style={{ transformOrigin: align === "left" ? "top left" : "top right" }}
            className={cx("absolute top-full z-30 mt-1 min-w-56 overflow-hidden rounded-sm bg-surface-container py-2 shadow-lg ring-1 ring-outline-variant/40", align === "left" ? "left-0" : "right-0")}
          >
            {children(() => setOpen(false))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function MenuItem({ children, onClick, hint, highlighted, disabled }: { children: ReactNode; onClick: () => void; hint?: ReactNode; highlighted?: boolean; disabled?: boolean }) {
  return (
    <button role="menuitem" disabled={disabled} onClick={onClick} className={cx("state-layer flex w-full items-center gap-3 px-4 py-2.5 text-left type-body-l disabled:opacity-40", highlighted && "text-primary")}>
      <span className="flex-1">{children}</span>
      {hint && <span className="type-label-m text-on-surface-variant">{hint}</span>}
    </button>
  );
}
