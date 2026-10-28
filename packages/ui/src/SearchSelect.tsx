// SearchSelect: a select you can type into. Use it for any list that can be long (groups, curators, venues, rooms, shows, models);
// short fixed lists (days, Yes/No) stay on <Select>.
//  - desktop: a popover under the field, search box at its top, matching width;
//  - phones: a bottom sheet with the search box at the top. The sheet follows the visual viewport (CSS vars written straight to the
//    element, no React state) so the on-screen keyboard never covers the list.
// Scrolling: ONE scroll container (the list), overscroll-behavior: contain, touch-action: pan-y, and nothing re-renders while it
// scrolls: the highlight only follows a real mouse, the position is frozen when the panel opens, and the panel's height is fixed so
// filtering never moves anything. Past MAX_SHOWN matches the list is cut with a "keep typing" row (cheaper than a virtual list and
// the search box is the way to reach the rest).
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { IconButton, cx } from "./ui";
import { IconClose, IconSearch } from "./icons";
import { usePhone } from "./Popover";
import { usePopover } from "./Pickers";

export interface SearchOption {
  value: string;
  label: string;
  /** Second line, and also searched (e.g. "@handle", "42 members", a city). */
  hint?: string;
  /** More words to match that are not shown. */
  keywords?: string;
  disabled?: boolean;
}

export interface SearchOptionState {
  selected: boolean;
  active: boolean;
  /** True when drawing the closed field rather than a row in the list. */
  inTrigger: boolean;
}

const MAX_SHOWN = 200;

const TRIGGER =
  "state-layer flex h-12 w-full items-center gap-2 rounded-sm border border-outline bg-transparent pr-2.5 pl-4 text-left type-body-l text-on-surface outline-none transition-[border-color,box-shadow] duration-150 focus-visible:border-primary focus-visible:shadow-[inset_0_0_0_1px_var(--md-sys-color-primary)] aria-expanded:border-primary aria-expanded:shadow-[inset_0_0_0_1px_var(--md-sys-color-primary)] disabled:opacity-40";

const fold = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Every word typed must appear somewhere in the label, hint or keywords; prefix matches on the label sort first (stable otherwise). */
export function filterOptions(options: SearchOption[], query: string): SearchOption[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  const scored: { o: SearchOption; rank: number; i: number }[] = [];
  options.forEach((o, i) => {
    const label = fold(o.label);
    const hay = `${label} ${fold(o.hint ?? "")} ${fold(o.keywords ?? "")}`;
    if (!words.every((w) => hay.includes(w))) return;
    scored.push({ o, i, rank: label.startsWith(words[0]) ? 0 : label.split(/[\s\-_.@]+/).some((t) => t.startsWith(words[0])) ? 1 : 2 });
  });
  return scored.sort((a, b) => a.rank - b.rank || a.i - b.i).map((x) => x.o);
}

const Check = () => (
  <svg className="size-5 shrink-0 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

const Chevron = ({ open }: { open: boolean }) => (
  <svg className={cx("size-5 shrink-0 text-on-surface-variant transition-transform duration-200", open && "rotate-180")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 9.5l6 6 6-6" />
  </svg>
);

export function SearchSelect({
  value,
  onChange,
  options,
  label,
  placeholder = "Choose…",
  searchPlaceholder = "Search",
  noneLabel,
  emptyText = "Nothing matches",
  renderOption,
  disabled,
  className,
  wrapperClassName,
  defaultOpen,
  onOpenChange,
  footer,
}: {
  value: string;
  onChange: (v: string) => void;
  options: SearchOption[];
  /** Names the field for screen readers and titles the phone sheet. */
  label?: string;
  /** Shown in the closed field when nothing is chosen. */
  placeholder?: string;
  searchPlaceholder?: string;
  /** Adds a first row (value "") that clears the choice, e.g. "None". */
  noneLabel?: string;
  emptyText?: ReactNode;
  /** The leading slot of a row and of the closed field: an avatar, photo or icon (e.g. GroupAvatar). The text is drawn by the component. */
  renderOption?: (o: SearchOption, state: SearchOptionState) => ReactNode;
  disabled?: boolean;
  className?: string;
  wrapperClassName?: string;
  /** Open as soon as it mounts (a picker that was itself opened by a button). */
  defaultOpen?: boolean;
  /** Called with the new state each time the panel opens or closes (not for the first render). */
  onOpenChange?: (open: boolean) => void;
  /** A pinned row under the list, e.g. "New curator". Gets a function that closes the panel. */
  footer?: (close: () => void) => ReactNode;
}) {
  const phone = usePhone();
  const id = useId();
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const byKeys = useRef(false);

  const none: SearchOption | null = noneLabel ? { value: "", label: noneLabel } : null;
  const all = useMemo(() => (none ? [none, ...options] : options), [options, noneLabel]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => {
    const q = query.trim();
    const hits = q ? filterOptions(options, q) : options;
    const rows = none && (!q || fold(none.label).includes(fold(q))) ? [none, ...hits] : hits;
    return rows;
  }, [options, query, noneLabel]); // eslint-disable-line react-hooks/exhaustive-deps
  const visible = shown.length > MAX_SHOWN ? shown.slice(0, MAX_SHOWN) : shown;
  const more = shown.length - visible.length;
  const selected = all.find((o) => o.value === value);
  const hasValue = Boolean(selected) && !(noneLabel && value === "");

  const close = useCallback(() => setOpen(false), []);
  const first = useRef(true);
  const openChanged = useRef(onOpenChange);
  openChanged.current = onOpenChange;
  useEffect(() => {
    if (first.current) return void (first.current = false);
    openChanged.current?.(open);
  }, [open]);
  const pos = usePopover(open && !phone, close, anchor, panel, true);

  const openIt = (seed = "") => {
    setQuery(seed);
    const i = (seed ? filterOptions(options, seed) : all).findIndex((o) => o.value === value);
    setActive(Math.max(0, i));
    setOpen(true);
  };
  const choose = (o: SearchOption) => {
    if (o.disabled) return;
    onChange(o.value);
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };

  // Desktop: the field is ready to type as soon as the panel is placed. Phones: leave the keyboard down until the search box is tapped.
  useEffect(() => {
    if (open && !phone && pos) input.current?.focus({ preventScroll: true });
  }, [open, phone, pos !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Land on the chosen row before paint, once per opening (never again while it is open).
  const landed = useRef(false);
  useLayoutEffect(() => {
    if (!open) return void (landed.current = false);
    const ul = list.current;
    if (!ul || landed.current || (!phone && !pos)) return;
    landed.current = true;
    const el = ul.querySelector<HTMLElement>("[aria-selected=true]");
    if (el) ul.scrollTop = Math.max(0, el.offsetTop - ul.clientHeight / 2 + el.offsetHeight / 2);
  }, [open, phone, pos !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // The typed text changes the rows: back to the top, first match highlighted.
  useEffect(() => {
    if (!open) return;
    setActive(0);
    if (list.current) list.current.scrollTop = 0;
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard navigation moves the list's own scrollTop (scrollIntoView would also scroll the shell and any Sheet around us).
  useEffect(() => {
    const ul = list.current;
    if (!open || !ul || !byKeys.current) return;
    byKeys.current = false;
    const el = ul.children[active] as HTMLElement | undefined;
    if (!el) return;
    if (el.offsetTop < ul.scrollTop) ul.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > ul.scrollTop + ul.clientHeight) ul.scrollTop = el.offsetTop + el.offsetHeight - ul.clientHeight;
  }, [open, active]);

  // Phone sheet: track the visual viewport with CSS variables on the element itself, so the keyboard never covers the list and no
  // render happens while the viewport moves.
  useLayoutEffect(() => {
    if (!open || !phone) return;
    const el = panel.current;
    const vv = window.visualViewport;
    if (!el) return;
    const fit = () => {
      const h = vv ? vv.height : window.innerHeight;
      const bottom = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
      el.style.setProperty("--ss-h", `${h}px`);
      el.style.setProperty("--ss-bottom", `${bottom}px`);
    };
    fit();
    vv?.addEventListener("resize", fit);
    vv?.addEventListener("scroll", fit);
    return () => {
      vv?.removeEventListener("resize", fit);
      vv?.removeEventListener("scroll", fit);
    };
  }, [open, phone]);

  // Escape closes just this panel (capture + stop, so a Sheet around the field does not close with it); Tab leaves it.
  useEffect(() => {
    if (!open) return;
    const k = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [open]);

  const onTriggerKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openIt();
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      openIt(e.key);
    }
  };

  const onInputKey = (e: KeyboardEvent) => {
    const n = visible.length;
    const go = (i: number) => {
      e.preventDefault();
      byKeys.current = true;
      setActive(Math.min(n - 1, Math.max(0, i)));
    };
    if (e.key === "ArrowDown") go(active + 1);
    else if (e.key === "ArrowUp") go(active - 1);
    else if (e.key === "PageDown") go(active + 6);
    else if (e.key === "PageUp") go(active - 6);
    else if (e.key === "Home" && !query) go(0);
    else if (e.key === "End" && !query) go(n - 1);
    else if (e.key === "Enter") {
      e.preventDefault();
      if (visible[active]) choose(visible[active]);
    } else if (e.key === "Tab") setOpen(false);
  };

  const row = (o: SearchOption, i: number) => {
    const on = o.value === value;
    const st: SearchOptionState = { selected: on, active: i === active, inTrigger: false };
    const custom = renderOption?.(o, st);
    return (
      <li
        key={o.value || "__none"}
        id={`${id}-${i}`}
        role="option"
        aria-selected={on}
        aria-disabled={o.disabled || undefined}
        onClick={() => choose(o)}
        onPointerMove={(e) => e.pointerType === "mouse" && i !== active && setActive(i)}
        className={cx("relative flex min-h-14 cursor-pointer items-center gap-3 px-4 py-2 type-body-l select-none", on && "bg-secondary-container/60 text-on-secondary-container", i === active && "after:pointer-events-none after:absolute after:inset-0 after:bg-current after:opacity-[0.08]", o.disabled && "opacity-40", o.value === "" && noneLabel && "text-on-surface-variant")}
      >
        {custom}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{o.label}</span>
          {o.hint && <span className="block truncate type-body-s text-on-surface-variant">{o.hint}</span>}
        </span>
        {on && <Check />}
      </li>
    );
  };

  const body = (
    <>
      <div className={cx("flex-none", phone ? "px-3 pb-2" : "p-2")}>
        <div className="relative">
          <IconSearch aria-hidden className="icon pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-on-surface-variant" />
          <input
            ref={input}
            role="combobox"
            aria-expanded
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={visible[active] ? `${id}-${active}` : undefined}
            aria-label={label ? `Search ${label.toLowerCase()}` : searchPlaceholder}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder={searchPlaceholder}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            enterKeyHint="done"
            className="h-12 w-full rounded-full border border-outline-variant bg-surface-low pr-4 pl-11 type-body-l text-on-surface outline-none placeholder:text-on-surface-variant/60 focus:border-primary"
          />
        </div>
      </div>
      <ul
        ref={list}
        id={`${id}-list`}
        role="listbox"
        aria-label={label}
        className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain pb-2 [-webkit-overflow-scrolling:touch] [scrollbar-gutter:stable]"
      >
        {visible.map(row)}
        {visible.length === 0 && (
          <li role="presentation" className="px-4 py-6 text-center type-body-m text-on-surface-variant">
            {emptyText}
          </li>
        )}
        {more > 0 && (
          <li role="presentation" className="px-4 py-3 text-center type-body-s text-on-surface-variant">
            {more} more. Keep typing to narrow it down.
          </li>
        )}
      </ul>
      {footer && <div className="flex-none border-t border-outline-variant/60 p-2">{footer(close)}</div>}
    </>
  );

  const triggerLabel = selected && hasValue ? selected : null;
  const custom = triggerLabel ? renderOption?.(triggerLabel, { selected: true, active: false, inTrigger: true }) : undefined;

  return (
    <div ref={anchor} className={cx("relative", wrapperClassName)}>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => (open ? close() : openIt())}
        onKeyDown={onTriggerKey}
        className={cx(TRIGGER, className)}
      >
        {custom}
        <span className={cx("min-w-0 flex-1 truncate", !hasValue && "text-on-surface-variant/60")}>{hasValue ? selected!.label : noneLabel && value === "" ? noneLabel : placeholder}</span>
        <Chevron open={open} />
      </button>
      {createPortal(
        <AnimatePresence>
          {open && phone && (
            <div key="sheet" className="fixed inset-0 z-[72] touch-none">
              <motion.div className="absolute inset-0 bg-scrim/40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }} onClick={close} />
              <motion.div
                ref={panel}
                role="dialog"
                aria-label={label ?? "Choose"}
                data-popover-owned
                style={{ bottom: "var(--ss-bottom, 0px)", height: "min(var(--ss-h, 100dvh) - 16px, 34rem)" }}
                className="absolute inset-x-0 flex touch-auto flex-col rounded-t-xl bg-surface-container pb-[env(safe-area-inset-bottom)] shadow-xl"
                initial={{ transform: "translateY(100%)" }}
                animate={{ transform: "translateY(0%)", transition: { duration: 0.26, ease: [0.23, 1, 0.32, 1] } }}
                exit={{ transform: "translateY(100%)", transition: { duration: 0.18, ease: [0.4, 0, 1, 1] } }}
              >
                <div className="flex h-12 flex-none items-center gap-2 pr-1 pl-4">
                  <h3 className="min-w-0 flex-1 truncate type-title-s">{label ?? "Choose"}</h3>
                  <IconButton icon={IconClose} label="Close" onClick={close} className="size-9" />
                </div>
                {body}
              </motion.div>
            </div>
          )}
          {open && !phone && (
            <motion.div
              key="pop"
              ref={panel}
              role="dialog"
              aria-label={label ?? "Choose"}
              data-popover-owned
              initial={{ opacity: 0, transform: "scale(0.97)" }}
              animate={{ opacity: pos ? 1 : 0, transform: "scale(1)", transition: { duration: 0.14, ease: [0.23, 1, 0.32, 1] } }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left ?? -9999, width: pos?.width, height: pos ? pos.height : undefined, maxHeight: pos?.maxHeight, transformOrigin: pos?.origin }}
              className="z-[72] flex max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-md bg-surface-container shadow-xl ring-1 ring-outline-variant/40"
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
