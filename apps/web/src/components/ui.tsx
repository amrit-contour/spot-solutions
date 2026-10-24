import {
  forwardRef,
  useEffect,
  useId,
  type ButtonHTMLAttributes,
  type ComponentType,
  type InputHTMLAttributes,
  type ReactNode,
  type SVGProps,
  type TextareaHTMLAttributes,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { initials } from "../lib/data";
import { IconClose } from "./icons";

export type Icon = ComponentType<SVGProps<SVGSVGElement>>;

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

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "filled", icon: I, size = "md", loading, className, children, disabled, ...rest },
  ref,
) {
  const h = size === "sm" ? "h-8 px-3 gap-1.5 type-label-m" : size === "lg" ? "h-14 px-6 gap-2.5 type-title-m" : "h-10 px-5 gap-2 type-label-l";
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        "state-layer pressable inline-flex items-center justify-center rounded-full whitespace-nowrap select-none disabled:opacity-40",
        h,
        I && size !== "lg" && "pl-4",
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner className={size === "sm" ? "size-4" : "size-5"} /> : I && <I className={cx("icon", size === "sm" ? "size-4" : size === "lg" ? "size-6" : "size-5")} />}
      {children}
    </button>
  );
});

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
}: {
  children: ReactNode;
  icon?: Icon;
  selected?: boolean;
  onClick?: () => void;
  tone?: "neutral" | "primary" | "tertiary" | "error" | "success";
  className?: string;
}) {
  const tones = {
    neutral: "border border-outline-variant text-on-surface-variant",
    primary: "bg-primary-container text-on-primary-container",
    tertiary: "bg-tertiary-container text-on-tertiary-container",
    error: "bg-error-container text-on-error-container",
    success: "bg-secondary-container text-on-secondary-container",
  };
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      onClick={onClick}
      aria-pressed={onClick ? Boolean(selected) : undefined}
      className={cx(
        "inline-flex h-7 items-center gap-1 rounded-sm px-2.5 type-label-m whitespace-nowrap",
        onClick && "state-layer pressable",
        selected ? "bg-secondary-container text-on-secondary-container" : tones[tone],
        className,
      )}
    >
      {I && <I className="icon -ml-0.5 size-4" />}
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

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <label className="flex flex-col gap-1.5" htmlFor={htmlFor}>
      <span className="type-label-l text-on-surface-variant">{label}</span>
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

export function Select({ value, onChange, options, className, placeholder }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string; placeholder?: string }) {
  return (
    <div className="relative">
      <select value={value} onChange={(e) => onChange(e.target.value)} className={cx(fieldBase, "h-12 appearance-none pr-10", className)}>
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg className="pointer-events-none absolute top-1/2 right-3 size-5 -translate-y-1/2 text-on-surface-variant" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M7 10l5 5 5-5z" />
      </svg>
    </div>
  );
}

/** M3 segmented button with a sliding selection pill. */
export function Segmented<T extends string | number>({ value, onChange, options, size = "md" }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; icon?: Icon }[]; size?: "sm" | "md" }) {
  const id = useId();
  return (
    <div className={cx("inline-flex rounded-full border border-outline-variant p-0.5", size === "sm" ? "h-9" : "h-10")} role="radiogroup">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cx("relative flex flex-1 items-center justify-center gap-1.5 rounded-full px-3.5 type-label-l transition-colors duration-150", active ? "text-on-secondary-container" : "text-on-surface-variant")}
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
    <div className="inline-flex h-10 items-center rounded-full border border-outline-variant">
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

/** Side sheet on wide screens, bottom sheet on phones. */
export function Sheet({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50">
          <motion.div className="absolute inset-0 bg-scrim/40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.15 } }} onClick={onClose} />
          <motion.aside
            role="dialog"
            aria-modal
            className={cx(
              "absolute flex flex-col bg-surface-low shadow-2xl",
              "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-xl",
              "sm:inset-y-2 sm:right-2 sm:left-auto sm:max-h-none sm:rounded-xl",
              wide ? "sm:w-[560px]" : "sm:w-[440px]",
            )}
            initial={{ transform: "translateY(24px)", opacity: 0 }}
            animate={{ transform: "translateY(0px)", opacity: 1, transition: { duration: 0.32, ease: [0.05, 0.7, 0.1, 1] } }}
            exit={{ transform: "translateY(16px)", opacity: 0, transition: { duration: 0.16, ease: [0.3, 0, 0.8, 0.15] } }}
          >
            <div className="mx-auto mt-3 h-1 w-8 rounded-full bg-outline-variant sm:hidden" />
            <header className="flex items-center gap-2 px-6 pt-4 pb-2 sm:pt-6">
              <h2 className="flex-1 type-headline-s">{title}</h2>
              <IconButton icon={IconClose} label="Close" onClick={onClose} />
            </header>
            <div className="flex-1 overflow-y-auto px-6 pb-6">{children}</div>
            {footer && <footer className="flex justify-end gap-2 border-t border-outline-variant px-6 py-4">{footer}</footer>}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
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
