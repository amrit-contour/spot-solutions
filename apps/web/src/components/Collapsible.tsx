// Server page sections: one header (icon, title, summary chip, chevron) and a body that animates open and shut.
// The open state is remembered per section in localStorage; the page works fine when storage is blocked.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Card, Chip, cx, type Icon } from "./ui";
import { IconArrowDown } from "./icons";

const KEY = "spot.section.";

function readOpen(id: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(KEY + id);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

export function useSectionOpen(id: string, defaultOpen: boolean, persist = true) {
  const [open, setOpen] = useState(() => (persist ? readOpen(id, defaultOpen) : defaultOpen));
  const set = (next: boolean) => {
    setOpen(next);
    if (!persist) return;
    try {
      localStorage.setItem(KEY + id, next ? "1" : "0");
    } catch {
      /* private mode or blocked storage: the section just won't be remembered */
    }
  };
  return [open, set] as const;
}

type Tone = "neutral" | "primary" | "tertiary" | "error" | "success";

export function Collapsible({
  id,
  title,
  subtitle,
  icon: I,
  summary,
  summaryTone = "neutral",
  defaultOpen = true,
  persist = true,
  plain,
  onOpenChange,
  className,
  children,
}: {
  /** Stable key for the remembered open state. */
  id: string;
  title: string;
  subtitle?: string;
  icon?: Icon;
  /** Short chip on the right of the header: "3 online", "2 pending". */
  summary?: ReactNode;
  summaryTone?: Tone;
  defaultOpen?: boolean;
  /** false: always starts at `defaultOpen` (the log section, so nothing asks the server for logs until you open it). */
  persist?: boolean;
  /** No card around it (a server's own section). */
  plain?: boolean;
  /** Called with the initial state on mount, then on every change. */
  onOpenChange?: (open: boolean) => void;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useSectionOpen(id, defaultOpen, persist);
  const reduce = useReducedMotion();
  const panel = useId();
  const cb = useRef(onOpenChange);
  cb.current = onOpenChange;
  useEffect(() => cb.current?.(open), [open]);

  const header = (
    <button type="button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)} className={cx("state-layer flex w-full items-center gap-3 text-left", plain ? "-mx-3 rounded-lg px-3 py-2" : "px-4 py-3")}>
      {I && <I className={cx("icon flex-none text-primary", plain ? "size-6" : "size-5")} />}
      <span className="min-w-0 flex-1">
        <span className={cx("block truncate", plain ? "type-title-l" : "type-title-s")}>{title}</span>
        {subtitle && <span className="block truncate type-body-s text-on-surface-variant">{subtitle}</span>}
      </span>
      {summary != null && summary !== "" && <Chip tone={summaryTone}>{summary}</Chip>}
      <IconArrowDown className={cx("icon size-5 flex-none text-on-surface-variant transition-transform duration-200", open && "rotate-180")} aria-hidden />
    </button>
  );

  const body = (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          id={panel}
          key="body"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.25, ease: [0.23, 1, 0.32, 1] }}
          style={{ overflow: "hidden" }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );

  return plain ? (
    <section className={cx("flex flex-col gap-4", className)}>
      {header}
      {body}
    </section>
  ) : (
    <Card className={cx("overflow-hidden", className)}>
      {header}
      {body}
    </Card>
  );
}

/** A sub-list inside a Collapsible card: the grey band ("Accounts (4)") is the toggle, the rows animate open and shut. */
export function CollapsibleBand({ id, label, count, defaultOpen = true, children }: { id: string; label: string; count?: number; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useSectionOpen(id, defaultOpen);
  const reduce = useReducedMotion();
  const panel = useId();
  return (
    <div>
      <button type="button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)} className="state-layer flex w-full items-center gap-2 bg-surface-container px-4 py-2 text-left type-label-m text-on-surface-variant">
        <span className="min-w-0 flex-1 truncate">
          {label}
          {count != null && ` (${count})`}
        </span>
        <IconArrowDown className={cx("icon size-4 flex-none transition-transform duration-200", open && "rotate-180")} aria-hidden />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div id={panel} key="body" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: reduce ? 0 : 0.25, ease: [0.23, 1, 0.32, 1] }} style={{ overflow: "hidden" }}>
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
