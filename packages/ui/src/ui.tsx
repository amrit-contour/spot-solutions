import {
  forwardRef,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentType,
  type InputHTMLAttributes,
  type ReactNode,
  type SVGProps,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { IconClose } from "./icons";

export type Icon = ComponentType<SVGProps<SVGSVGElement>>;

export const initials = (name: string) =>
  name
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("") || "?";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/* ---------- Buttons ---------- */

type Variant = "filled" | "tonal" | "outlined" | "text" | "danger";
const VARIANT: Record<Variant, string> = {
  filled: "bg-primary text-on-primary",
  tonal: "bg-secondary-container text-on-secondary-container",
  outlined: "border border-outline-variant text-on-surface-variant",
  text: "text-primary",
  danger: "bg-error-container text-on-error-container",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  icon?: Icon;
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}

/** Button classes for things that must be a link but look like a button. */
export function buttonClass({ variant = "filled", size = "md", icon, className }: { variant?: Variant; size?: "sm" | "md" | "lg"; icon?: boolean; className?: string } = {}) {
  const h = size === "sm" ? "h-8 px-3 gap-1.5 type-label-m" : size === "lg" ? "h-14 px-6 gap-2.5 type-title-m" : "h-10 px-5 gap-2 type-label-l";
  return cx("state-layer pressable inline-flex items-center justify-center rounded-full whitespace-nowrap select-none disabled:opacity-40", h, icon && size !== "lg" && "pl-4", VARIANT[variant], className);
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "filled", icon: I, size = "md", loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button ref={ref} disabled={disabled || loading} className={buttonClass({ variant, size, icon: Boolean(I), className })} {...rest}>
      {loading ? <Spinner className={size === "sm" ? "size-4" : "size-5"} /> : I && <I className={cx("icon", size === "sm" ? "size-4" : size === "lg" ? "size-6" : "size-5")} />}
      {children}
    </button>
  );
});

/** A labelled button from `sm` up; below that, just its icon (still named for screen readers, with a tooltip). */
export function CompactButton({ icon: I, label, variant = "tonal", size = "sm", loading, className, ...rest }: Omit<ButtonProps, "icon" | "children"> & { icon: Icon; label: string }) {
  return (
    <>
      <Button variant={variant} size={size} icon={I} loading={loading} className={cx("max-sm:hidden", className)} {...rest}>
        {label}
      </Button>
      <button
        type="button"
        aria-label={label}
        title={rest.title ?? label}
        disabled={rest.disabled || loading}
        onClick={rest.onClick}
        className={buttonClass({ variant, size: "md", className: cx("size-9 flex-none px-0! sm:hidden", className) })}
      >
        {loading ? <Spinner className="size-5" /> : <I className="icon size-5" />}
      </button>
    </>
  );
}

export function IconButton({ icon: I, label, className, tone = "plain", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: Icon; label: string; tone?: "plain" | "tonal" | "filled" }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx(
        "state-layer pressable grid size-10 place-items-center rounded-full disabled:opacity-40",
        tone === "plain" && "text-on-surface-variant",
        tone === "tonal" && "bg-secondary-container text-on-secondary-container",
        tone === "filled" && "bg-primary text-on-primary",
        className,
      )}
      {...rest}
    >
      <I className="icon size-5" />
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cx("spin", className ?? "size-5")} fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* ---------- Chips & badges ---------- */

export function Chip({
  children,
  icon: I,
  selected,
  onClick,
  tone = "neutral",
  className,
  title,
}: {
  children: ReactNode;
  title?: string;
  icon?: Icon;
  selected?: boolean;
  onClick?: () => void;
  tone?: "neutral" | "primary" | "tertiary" | "error" | "success" | "fact" | "reading";
  className?: string;
}) {
  const tones = {
    neutral: "border border-outline-variant text-on-surface-variant",
    primary: "bg-primary-container text-on-primary-container",
    tertiary: "bg-tertiary-container text-on-tertiary-container",
    error: "bg-error-container text-on-error-container",
    success: "bg-secondary-container text-on-secondary-container",
    // Something the app knows for sure, versus something Gemma read from the message (dashed, quieter).
    fact: "bg-surface-high text-on-surface",
    reading: "border border-dashed border-outline-variant text-on-surface-variant",
  };
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      onClick={onClick}
      title={title}
      aria-pressed={onClick ? Boolean(selected) : undefined}
      className={cx(
        "inline-flex h-7 items-center gap-1 rounded-sm px-2.5 type-label-m whitespace-nowrap",
        onClick && "state-layer pressable",
        selected ? "bg-secondary-container text-on-secondary-container" : tones[tone],
        className,
      )}
    >
      {I && <I className="icon -ml-0.5 size-4 flex-none" />}
      {children}
    </Tag>
  );
}

export function Avatar({ name, size = 40, tone = "primary" }: { name: string; size?: number; tone?: "primary" | "tertiary" | "secondary" }) {
  const t = { primary: "bg-primary-container text-on-primary-container", tertiary: "bg-tertiary-container text-on-tertiary-container", secondary: "bg-secondary-container text-on-secondary-container" }[tone];
  return (
    <span className={cx("grid flex-none place-items-center rounded-full type-label-l", t)} style={{ width: size, height: size, fontSize: size * 0.36 }} aria-hidden>
      {initials(name)}
    </span>
  );
}

/* ---------- Inputs ---------- */

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative h-8 w-13 flex-none rounded-full border-2 transition-colors duration-200 disabled:opacity-40",
        checked ? "border-primary bg-primary" : "border-outline bg-surface-highest",
      )}
    >
      <motion.span
        layout
        transition={{ type: "spring", duration: 0.35, bounce: 0.25 }}
        className={cx("absolute top-1/2 -translate-y-1/2 rounded-full", checked ? "right-1 size-6 bg-on-primary" : "left-1.5 size-4 bg-outline")}
      />
    </button>
  );
}

const fieldBase =
  "w-full rounded-sm border border-outline bg-transparent px-4 type-body-l text-on-surface placeholder:text-on-surface-variant/60 outline-none transition-[border-color,box-shadow] duration-150 focus:border-primary focus:shadow-[inset_0_0_0_1px_var(--md-sys-color-primary)]";

export function Field({ label, hint, info, children, htmlFor }: { label: string; hint?: ReactNode; info?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <label className="flex flex-col gap-1.5" htmlFor={htmlFor}>
      <span className="flex items-center gap-1 type-label-l text-on-surface-variant">
        {label}
        {info && <Info>{info}</Info>}
      </span>
      {children}
      {hint && <span className="type-body-s text-on-surface-variant">{hint}</span>}
    </label>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, ...p }, ref) {
  return <input ref={ref} className={cx(fieldBase, "h-12", className)} {...p} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...p }, ref) {
  return <textarea ref={ref} className={cx(fieldBase, "min-h-28 resize-y py-3 leading-6", className)} {...p} />;
});

export { Select, TimePicker } from "./Pickers";

/** M3 segmented button with a sliding selection pill. */
export function Segmented<T extends string | number>({ value, onChange, options, size = "md", full, compact }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; icon?: Icon }[]; size?: "sm" | "md"; full?: boolean; compact?: boolean }) {
  const id = useId();
  return (
    <div className={cx("rounded-full border border-outline-variant p-0.5", full ? "flex w-full" : "inline-flex", size === "sm" ? "h-9" : "h-10")} role="radiogroup">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cx("relative flex flex-1 items-center justify-center gap-1.5 rounded-full type-label-l whitespace-nowrap transition-colors duration-150", compact ? "px-2.5" : "px-3.5", active ? "text-on-secondary-container" : "text-on-surface-variant")}
          >
            {active && <motion.span layoutId={id} className="absolute inset-0 rounded-full bg-secondary-container" transition={{ type: "spring", duration: 0.4, bounce: 0.15 }} />}
            {o.icon && <o.icon className="icon relative size-4" />}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Stepper({ value, onChange, min = 0, max = 99, suffix }: { value: number; onChange: (v: number) => void; min?: number; max?: number; suffix?: string }) {
  return (
    <div className="inline-flex h-10 w-fit self-start items-center rounded-full border border-outline-variant">
      <button className="state-layer grid size-10 place-items-center rounded-full text-on-surface-variant disabled:opacity-30" disabled={value <= min} onClick={() => onChange(value - 1)} aria-label="Decrease">
        −
      </button>
      <span className="min-w-12 text-center type-label-l tabular">
        {value}
        {suffix && <span className="text-on-surface-variant"> {suffix}</span>}
      </span>
      <button className="state-layer grid size-10 place-items-center rounded-full text-on-surface-variant disabled:opacity-30" disabled={value >= max} onClick={() => onChange(value + 1)} aria-label="Increase">
        +
      </button>
    </div>
  );
}

/* ---------- Surfaces ---------- */

export function Card({ children, className, tone = "low" }: { children: ReactNode; className?: string; tone?: "low" | "container" | "high" | "outlined" }) {
  const t = { low: "bg-surface-low", container: "bg-surface-container", high: "bg-surface-high", outlined: "border border-outline-variant bg-surface" }[tone];
  return <div className={cx("rounded-lg", t, className)}>{children}</div>;
}

export function Empty({ icon: I, title, children, action }: { icon: Icon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center px-6 py-16 text-center">
      <span className="mb-5 grid size-16 place-items-center rounded-xl-plus bg-surface-high text-primary">
        <I className="icon size-8" />
      </span>
      <h3 className="type-title-l">{title}</h3>
      {children && <p className="mt-2 type-body-m text-on-surface-variant">{children}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

/**
 * Full-screen editor panel (M3 full-screen dialog). Covers the content area (the nav rail
 * stays visible on desktop), uses the whole height, and keeps actions in reach:
 * in the top bar on desktop, in a bottom bar on phones.
 */
export function Sheet({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", k);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);
  // Portal: an ancestor's transform (the page-enter animation) would otherwise trap `fixed`.
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          role="dialog"
          aria-modal
          className="fixed inset-0 z-50 flex flex-col bg-surface sm:left-24"
          initial={{ opacity: 0, transform: "translateY(12px)" }}
          animate={{ opacity: 1, transform: "translateY(0px)", transition: { duration: 0.24, ease: [0.05, 0.7, 0.1, 1] } }}
          exit={{ opacity: 0, transform: "translateY(8px)", transition: { duration: 0.14, ease: [0.3, 0, 0.8, 0.15] } }}
        >
          {/* Height = the bar plus the notch, so the title never sits under the status bar. */}
          <header className="flex h-[calc(4rem+env(safe-area-inset-top))] flex-none items-center gap-2 border-b border-outline-variant/60 bg-surface pt-[env(safe-area-inset-top)] pr-[max(0.5rem,env(safe-area-inset-right))] pl-[max(0.5rem,env(safe-area-inset-left))] sm:h-[calc(72px+env(safe-area-inset-top))] sm:px-6">
            <IconButton icon={IconClose} label="Close" tone="tonal" onClick={onClose} />
            <h2 className="ml-2 min-w-0 flex-1 truncate type-title-l sm:type-headline-s">{title}</h2>
            {footer && <div className="hidden items-center gap-2 sm:flex">{footer}</div>}
          </header>
          <div className="flex-1 overflow-y-auto overscroll-contain">
            <div className={cx("mx-auto w-full px-4 py-6 sm:px-8 sm:py-8", wide ? "max-w-4xl" : "max-w-2xl")}>{children}</div>
          </div>
          {footer && <footer className="flex flex-none items-center justify-end gap-2 border-t border-outline-variant/60 bg-surface-low px-4 py-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:hidden">{footer}</footer>}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="type-title-m text-on-surface">{children}</h2>
      {action}
    </div>
  );
}

/** WhatsApp-ish bubble used for message previews. */
export function Bubble({ children, outgoing, meta }: { children: ReactNode; outgoing?: boolean; meta?: string }) {
  return (
    <div className={cx("max-w-[85%] rounded-lg px-3.5 py-2 type-body-m whitespace-pre-wrap", outgoing ? "ml-auto rounded-br-xs bg-primary-container text-on-primary-container" : "rounded-bl-xs bg-surface-highest text-on-surface")}>
      {children}
      {meta && <span className="ml-2 align-bottom type-label-s opacity-60">{meta}</span>}
    </div>
  );
}

/**
 * Small ⓘ that reveals help text on hover, focus or tap. Keeps long explanations off the page.
 * Rendered in a portal and clamped to the viewport.
 */
export function Info({ children, label = "More info" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 24);
    setPos({ top: r.bottom + 8, left: Math.min(Math.max(12, r.left + r.width / 2 - w / 2), window.innerWidth - w - 12) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => !btn.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", close);
    window.addEventListener("scroll", () => setOpen(false), { once: true, capture: true });
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={label}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => (e.preventDefault(), setOpen((o) => !o))}
        className="inline-grid size-6 flex-none place-items-center rounded-full text-on-surface-variant/70 transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
      >
        <svg viewBox="0 0 20 20" className="size-[18px]" fill="currentColor" aria-hidden>
          <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-11.5a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM9.25 9a.75.75 0 0 1 1.5 0v4.5a.75.75 0 0 1-1.5 0V9Z" clipRule="evenodd" />
        </svg>
      </button>
      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              role="tooltip"
              initial={{ opacity: 0, transform: "translateY(-4px)" }}
              animate={{ opacity: 1, transform: "translateY(0px)", transition: { duration: 0.14, ease: [0.23, 1, 0.32, 1] } }}
              exit={{ opacity: 0, transition: { duration: 0.08 } }}
              style={{ position: "fixed", top: pos.top, left: pos.left, width: Math.min(320, window.innerWidth - 24) }}
              className="pointer-events-none z-[70] rounded-sm bg-inverse-surface px-3 py-2 type-body-s text-inverse-on-surface shadow-lg"
            >
              {children}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}

/** One setting on one line: label (with ⓘ) on the left, control on the right. */
export function SettingRow({ label, info, children, className }: { label: ReactNode; info?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx("flex min-h-12 items-center gap-4", className)}>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="type-title-s">{label}</span>
        {info && <Info>{info}</Info>}
      </div>
      <div className="flex flex-none items-center gap-2">{children}</div>
    </div>
  );
}
