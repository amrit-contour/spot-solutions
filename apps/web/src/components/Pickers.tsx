import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { formatTime } from "@spot/shared";
import { cx } from "./ui";
import { IconClock } from "./icons";

const GAP = 6;
const MARGIN = 12;

/** Field-style trigger shared by Select and TimePicker so they line up with TextInput. */
const TRIGGER =
  "state-layer flex h-12 w-full items-center gap-2 rounded-sm border border-outline bg-transparent pr-2.5 pl-4 text-left type-body-l text-on-surface outline-none transition-[border-color,box-shadow] duration-150 focus-visible:border-primary focus-visible:shadow-[inset_0_0_0_1px_var(--md-sys-color-primary)] aria-expanded:border-primary aria-expanded:shadow-[inset_0_0_0_1px_var(--md-sys-color-primary)] disabled:opacity-40";

/** Anchored, portalled popover: flips above when short on space, clamps to the viewport, closes on outside press. */
function usePopover(open: boolean, close: () => void, anchor: RefObject<HTMLElement | null>, panel: RefObject<HTMLDivElement | null>, matchWidth: boolean) {
  const [pos, setPos] = useState<{ top: number; left: number; width?: number; maxHeight: number; origin: string } | null>(null);

  useLayoutEffect(() => {
    if (!open) return setPos(null);
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const p = panel.current;
      if (!a || !p) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const natural = p.scrollHeight;
      const w = matchWidth ? Math.max(a.width, 0) : p.offsetWidth;
      const below = vh - a.bottom - GAP - MARGIN;
      const above = a.top - GAP - MARGIN;
      const up = natural > below && above > below;
      const maxHeight = Math.max(matchWidth ? 120 : 296, Math.min(360, up ? above : below));
      const h = Math.min(natural, maxHeight);
      const top = Math.max(MARGIN, Math.min(up ? a.top - GAP - h : a.bottom + GAP, vh - MARGIN - h));
      const left = Math.min(Math.max(MARGIN, a.left), vw - MARGIN - w);
      setPos({ top, left, width: matchWidth ? a.width : undefined, maxHeight, origin: `${up ? "bottom" : "top"} left` });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, panel, matchWidth]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!anchor.current?.contains(t) && !panel.current?.contains(t)) close();
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open, close, anchor, panel]);

  return pos;
}

function Panel({ open, pos, panel, children, className, ...aria }: { open: boolean; pos: ReturnType<typeof usePopover>; panel: RefObject<HTMLDivElement | null>; children: React.ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={panel}
          initial={{ opacity: 0, transform: "scale(0.97)" }}
          animate={{ opacity: 1, transform: "scale(1)", transition: { duration: 0.14, ease: [0.23, 1, 0.32, 1] } }}
          exit={{ opacity: 0, transition: { duration: 0.1 } }}
          style={{ position: "fixed", visibility: pos ? "visible" : "hidden", top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: pos?.width, maxHeight: pos?.maxHeight, transformOrigin: pos?.origin }}
          className={cx("z-[70] max-w-[calc(100vw-24px)] overflow-y-auto overscroll-contain rounded-md bg-surface-container shadow-xl ring-1 ring-outline-variant/40", className)}
          {...(aria as object)}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg className={cx("size-5 shrink-0 text-on-surface-variant transition-transform duration-200", open && "rotate-180")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 9.5l6 6 6-6" />
  </svg>
);

/* ---------- Select ---------- */

export interface SelectOption {
  value: string;
  label: string;
}

export function Select({ value, onChange, options, className, wrapperClassName, placeholder, disabled, label }: { value: string; onChange: (v: string) => void; options: SelectOption[]; className?: string; wrapperClassName?: string; placeholder?: string; disabled?: boolean; label?: string }) {
  const all = useMemo<SelectOption[]>(() => (placeholder ? [{ value: "", label: placeholder }, ...options] : options), [options, placeholder]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const id = useId();
  const close = () => setOpen(false);
  const pos = usePopover(open, close, anchor, panel, true);
  const selectedIndex = all.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? all[selectedIndex] : undefined;
  const showingPlaceholder = !selected || (placeholder !== undefined && value === "");

  const openMenu = () => {
    setActive(Math.max(0, selectedIndex));
    setOpen(true);
  };
  const choose = (i: number) => {
    onChange(all[i].value);
    setOpen(false);
    trigger.current?.focus();
  };

  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, pos]);

  const onKeyDown = (e: KeyboardEvent) => {
    const n = all.length;
    if (!n) return;
    const move = (i: number) => {
      e.preventDefault();
      if (!open) {
        setActive(Math.min(n - 1, Math.max(0, i)));
        return setOpen(true);
      }
      setActive(Math.min(n - 1, Math.max(0, i)));
    };
    switch (e.key) {
      case "ArrowDown":
        return move(open ? active + 1 : Math.max(0, selectedIndex));
      case "ArrowUp":
        return move(open ? active - 1 : Math.max(0, selectedIndex));
      case "Home":
        return open ? move(0) : undefined;
      case "End":
        return open ? move(n - 1) : undefined;
      case "Enter":
      case " ":
        e.preventDefault();
        return open ? choose(active) : openMenu();
      case "Escape":
        if (open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }
        return;
      case "Tab":
        return setOpen(false);
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      typed.current.text = now - typed.current.at > 700 ? e.key.toLowerCase() : typed.current.text + e.key.toLowerCase();
      typed.current.at = now;
      const from = typed.current.text.length === 1 ? (open ? active : selectedIndex) + 1 : open ? active : selectedIndex;
      const order = [...all.keys()].map((_, k) => (from + k + n) % n);
      const hit = order.find((i) => all[i].label.toLowerCase().startsWith(typed.current.text));
      if (hit !== undefined) move(hit);
    }
  };

  return (
    <div ref={anchor} className={cx("relative", wrapperClassName)}>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
        className={cx(TRIGGER, className)}
      >
        <span className={cx("min-w-0 flex-1 truncate", showingPlaceholder && "text-on-surface-variant/60")}>{selected?.label ?? placeholder ?? " "}</span>
        <Chevron open={open} />
      </button>
      <Panel open={open} pos={pos} panel={panel} className="py-2" id={id} role="listbox" aria-label={label}>
        {all.map((o, i) => {
          const on = i === selectedIndex;
          return (
            <div
              key={o.value || "__none"}
              id={`${id}-${i}`}
              role="option"
              aria-selected={on}
              data-i={i}
              onPointerEnter={() => setActive(i)}
              onClick={() => choose(i)}
              className={cx("relative flex min-h-12 cursor-pointer items-center gap-3 px-4 py-2.5 type-body-l select-none", on && "bg-secondary-container/60 text-on-secondary-container", i === active && "after:absolute after:inset-0 after:bg-current after:opacity-[0.08]", o.value === "" && placeholder && "text-on-surface-variant")}
            >
              <span className="min-w-0 flex-1 break-words">{o.label}</span>
              {on && (
                <svg className="size-5 shrink-0 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
              )}
            </div>
          );
        })}
      </Panel>
    </div>
  );
}

/* ---------- TimePicker ---------- */

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1);
const STEP_MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);

function parse(v: string) {
  const [h, m] = v.split(":").map(Number);
  const hh = Number.isFinite(h) ? h : 0;
  return { h12: hh % 12 || 12, pm: hh >= 12, m: Number.isFinite(m) ? m : 0 };
}
const build = (h12: number, m: number, pm: boolean) => `${String(((h12 % 12) + (pm ? 12 : 0)) % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

/** 12-hour display, "HH:MM" 24-hour value. */
export function TimePicker({ value, onChange, className, wrapperClassName, disabled, label }: { value: string; onChange: (v: string) => void; className?: string; wrapperClassName?: string; disabled?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  const pos = usePopover(open, close, anchor, panel, false);
  const t = parse(value);
  const minutes = STEP_MINUTES.includes(t.m) ? STEP_MINUTES : [...STEP_MINUTES, t.m].sort((a, b) => a - b);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      panel.current?.querySelectorAll<HTMLElement>("[role=radiogroup]").forEach((col) => {
        const el = col.querySelector<HTMLElement>("[aria-checked=true]");
        if (el) col.scrollTop = el.offsetTop - col.clientHeight / 2 + el.offsetHeight / 2;
      });
      panel.current?.querySelector<HTMLElement>("[data-col=h][aria-checked=true]")?.focus({ preventScroll: true });
    });
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    const el = e.target as HTMLElement;
    const col = el.dataset.col;
    if (!col) return;
    const cols = ["h", "m", "p"];
    const items = [...(el.parentElement?.querySelectorAll<HTMLElement>("button") ?? [])];
    const idx = items.indexOf(el);
    let next: HTMLElement | undefined;
    if (e.key === "ArrowDown") next = items[Math.min(items.length - 1, idx + 1)];
    else if (e.key === "ArrowUp") next = items[Math.max(0, idx - 1)];
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const target = cols[cols.indexOf(col) + (e.key === "ArrowRight" ? 1 : -1)];
      next = panel.current?.querySelector<HTMLElement>(`[data-col=${target}][aria-checked=true]`) ?? undefined;
    } else return;
    e.preventDefault();
    if (next) {
      next.focus();
      next.click();
    }
  };

  const cell = (on: boolean) => cx("state-layer flex h-10 w-full items-center justify-center rounded-full type-label-l tabular", on ? "bg-primary text-on-primary" : "text-on-surface");

  return (
    <div ref={anchor} className={cx("relative", wrapperClassName)}>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === "Escape" && open && (e.stopPropagation(), setOpen(false))}
        className={cx(TRIGGER, className)}
      >
        <span className="min-w-0 flex-1 truncate tabular">{formatTime(value)}</span>
        <IconClock className="icon size-5 shrink-0 text-on-surface-variant" aria-hidden />
      </button>
      <Panel open={open} pos={pos} panel={panel} className="p-3" role="dialog" aria-label={label ?? "Choose a time"} onKeyDown={onKeyDown}>
        <div className="flex gap-1.5">
          <div role="radiogroup" aria-label="Hour" className="relative flex max-h-52 w-14 flex-col gap-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {HOURS.map((h) => (
              <button key={h} type="button" role="radio" data-col="h" aria-checked={h === t.h12} tabIndex={h === t.h12 ? 0 : -1} onClick={() => onChange(build(h, t.m, t.pm))} className={cell(h === t.h12)}>
                {h}
              </button>
            ))}
          </div>
          <div role="radiogroup" aria-label="Minute" className="relative flex max-h-52 w-14 flex-col gap-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {minutes.map((m) => (
              <button key={m} type="button" role="radio" data-col="m" aria-checked={m === t.m} tabIndex={m === t.m ? 0 : -1} onClick={() => onChange(build(t.h12, m, t.pm))} className={cell(m === t.m)}>
                {String(m).padStart(2, "0")}
              </button>
            ))}
          </div>
          <div role="radiogroup" aria-label="AM or PM" className="flex w-14 flex-col gap-1">
            {(["AM", "PM"] as const).map((p) => {
              const on = (p === "PM") === t.pm;
              return (
                <button key={p} type="button" role="radio" data-col="p" aria-checked={on} tabIndex={on ? 0 : -1} onClick={() => onChange(build(t.h12, t.m, p === "PM"))} className={cx(cell(on), on && "bg-secondary-container text-on-secondary-container")}>
                  {p}
                </button>
              );
            })}
          </div>
        </div>
        <button type="button" onClick={() => (setOpen(false), trigger.current?.focus())} className="state-layer pressable mt-3 flex h-10 w-full items-center justify-center rounded-full bg-secondary-container type-label-l text-on-secondary-container">
          Done
        </button>
      </Panel>
    </div>
  );
}
