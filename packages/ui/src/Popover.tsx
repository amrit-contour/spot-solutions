// A small panel opened from an icon button: an anchored popover on desktop, a bottom sheet on phones.
// Rendered in a portal, so columns that clip or scroll never cut it off, and opening one never moves the page.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { IconButton, cx, type Icon } from "./ui";
import { IconClose } from "./icons";

const GAP = 6;
const MARGIN = 12;
const PHONE = "(max-width: 639px)";

function usePhone() {
  const [phone, setPhone] = useState(() => (typeof window === "undefined" ? false : window.matchMedia(PHONE).matches));
  useEffect(() => {
    const m = window.matchMedia(PHONE);
    const on = () => setPhone(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return phone;
}

/** Clicks inside menus, selects and dialogs opened from the panel are portalled elsewhere but still belong to it. */
const NESTED = '[role="menu"],[role="listbox"],[role="dialog"],[role="alertdialog"],[data-popover-owned]';

export function Popover({ trigger, title, children, width = 340, controlledOpen, onOpenChange, anchorClassName, anchorStyle }: { trigger: (toggle: () => void, open: boolean) => ReactNode; title: string; children: (close: () => void) => ReactNode; width?: number; controlledOpen?: boolean; onOpenChange?: (o: boolean) => void; /** Replaces the default `relative inline-flex` wrapper, e.g. to absolutely position the trigger in a grid. */ anchorClassName?: string; anchorStyle?: CSSProperties }) {
  const phone = usePhone();
  const [inner, setInner] = useState(false);
  const open = controlledOpen ?? inner;
  const setOpen = (o: boolean) => (onOpenChange ? onOpenChange(o) : setInner(o));
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; origin: string; maxH: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || phone) return setPos(null);
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const p = panel.current;
      if (!a || !p) return;
      const w = p.offsetWidth;
      const h = p.scrollHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const below = vh - a.bottom - GAP - MARGIN;
      const above = a.top - GAP - MARGIN;
      const up = h > below && above > below;
      const maxH = Math.max(200, Math.min(560, up ? above : below));
      const hh = Math.min(h, maxH);
      const top = up ? a.top - GAP - hh : a.bottom + GAP;
      // Right edges line up by default; when that would run off the left, line the left edges up instead.
      const left = Math.min(Math.max(MARGIN, a.right - w < MARGIN ? a.left : a.right - w), vw - MARGIN - w);
      setPos({ top, left, maxH, origin: `${up ? "bottom" : "top"} right` });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, phone]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (phone) return; // the scrim handles it
      if (!anchor.current?.contains(t) && !panel.current?.contains(t) && !t.closest?.(NESTED)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Let an open menu or dialog take the Escape first.
      if (document.querySelector('[role="menu"],[role="listbox"],[role="alertdialog"],[role="dialog"]')) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    if (phone) document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
      if (phone) document.body.style.overflow = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phone]);

  const close = () => setOpen(false);
  const body = (
    <>
      <div className="flex h-12 flex-none items-center gap-2 pl-4 pr-1">
        <h3 className="min-w-0 flex-1 truncate type-title-s">{title}</h3>
        <IconButton icon={IconClose} label="Close" onClick={close} className="size-9" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">{children(close)}</div>
    </>
  );

  return (
    <div ref={anchor} className={anchorClassName ?? "relative inline-flex"} style={anchorStyle}>
      {trigger(() => setOpen(!open), open)}
      {createPortal(
        <AnimatePresence>
          {open && phone && (
            <div key="sheet" className="fixed inset-0 z-[58]">
              <motion.div className="absolute inset-0 bg-scrim/40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} onClick={close} />
              <motion.div
                ref={panel}
                role="dialog"
                aria-label={title}
                className="absolute inset-x-0 bottom-0 flex max-h-[80dvh] flex-col rounded-t-xl bg-surface-container pb-[env(safe-area-inset-bottom)] shadow-xl"
                initial={{ transform: "translateY(100%)" }}
                animate={{ transform: "translateY(0%)", transition: { duration: 0.26, ease: [0.23, 1, 0.32, 1] } }}
                exit={{ transform: "translateY(100%)", transition: { duration: 0.18, ease: [0.4, 0, 1, 1] } }}
              >
                {body}
              </motion.div>
            </div>
          )}
          {open && !phone && (
            <motion.div
              key="pop"
              ref={panel}
              role="dialog"
              aria-label={title}
              initial={{ opacity: 0, transform: "scale(0.96)" }}
              animate={{ opacity: pos ? 1 : 0, transform: "scale(1)", transition: { duration: 0.16, ease: [0.23, 1, 0.32, 1] } }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? -9999, width, maxHeight: pos?.maxH, transformOrigin: pos?.origin }}
              className={cx("z-[58] flex max-w-[calc(100vw-24px)] flex-col rounded-md bg-surface-container shadow-xl ring-1 ring-outline-variant/40")}
            >
              {body}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}

/** Icon button for a column's toolbar. A count badge sits on the corner; `tone` marks something that needs a look. */
export function ToolButton({ icon: I, label, count, tone = "plain", active, onClick }: { icon: Icon; label: string; count?: number; tone?: "plain" | "attention" | "accent"; active?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={count ? `${label}, ${count}` : label}
      title={label}
      aria-expanded={active}
      onClick={onClick}
      className={cx("state-layer pressable relative grid size-9 flex-none place-items-center rounded-full", active ? "bg-secondary-container text-on-secondary-container" : tone === "attention" ? "text-tertiary" : tone === "accent" ? "text-primary" : "text-on-surface-variant")}
    >
      <I className="icon size-5" />
      {count ? (
        <span className={cx("absolute right-0 top-0 grid h-4 min-w-4 place-items-center rounded-full px-1 type-label-s tabular leading-none", tone === "attention" ? "bg-tertiary text-on-tertiary" : "bg-primary text-on-primary")}>{count > 99 ? "99+" : count}</span>
      ) : null}
    </button>
  );
}
