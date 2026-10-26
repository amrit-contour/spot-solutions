import { useLayoutEffect, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { cx } from "./ui";

const GAP = 6;
const MARGIN = 12;

/**
 * Anchored menu rendered in a portal, so cards with overflow-hidden can't clip it.
 * Flips above the trigger when there's no room below and clamps to the viewport.
 */
export function Menu({ trigger, children, align = "left" }: { trigger: (open: () => void, isOpen: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; origin: string } | null>(null);

  useLayoutEffect(() => {
    if (!open) return setPos(null);
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const p = panel.current;
      if (!a || !p) return;
      const w = p.offsetWidth;
      const h = p.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const below = vh - a.bottom - GAP - MARGIN;
      const up = h > below && a.top - GAP - MARGIN > below;
      const top = up ? Math.max(MARGIN, a.top - GAP - h) : Math.min(a.bottom + GAP, vh - MARGIN - h);
      let left = align === "right" ? a.right - w : a.left;
      left = Math.min(Math.max(MARGIN, left), vw - MARGIN - w);
      setPos({ top, left, origin: `${up ? "bottom" : "top"} ${align === "right" ? "right" : "left"}` });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!anchor.current?.contains(t) && !panel.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={anchor} className="relative inline-flex">
      {trigger(() => setOpen((o) => !o), open)}
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              ref={panel}
              role="menu"
              initial={{ opacity: 0, transform: "scale(0.96)" }}
              animate={{ opacity: pos ? 1 : 0, transform: "scale(1)", transition: { duration: 0.16, ease: [0.23, 1, 0.32, 1] } }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? -9999, transformOrigin: pos?.origin }}
              className={cx("z-[60] max-h-[min(70dvh,420px)] max-w-[calc(100vw-24px)] min-w-56 overflow-y-auto rounded-md bg-surface-container py-2 shadow-xl ring-1 ring-outline-variant/40")}
            >
              {children(() => setOpen(false))}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}

export function MenuItem({ children, onClick, hint, highlighted, disabled }: { children: ReactNode; onClick: () => void; hint?: ReactNode; highlighted?: boolean; disabled?: boolean }) {
  return (
    <button role="menuitem" disabled={disabled} onClick={onClick} className={cx("state-layer flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left type-body-l disabled:opacity-40", highlighted && "text-primary")}>
      <span className="min-w-0 flex-1">{children}</span>
      {hint && <span className="type-label-m text-on-surface-variant tabular">{hint}</span>}
    </button>
  );
}
