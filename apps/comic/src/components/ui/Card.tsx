import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cx } from "@spot/ui";

const TONE = { low: "bg-surface-low", high: "bg-surface-high", outlined: "border border-outline-variant", secondary: "bg-secondary-container text-on-secondary-container" } as const;

/** The one card: 16px radius, 16px padding. Static, or pressable (a link or a button) with the same shape. */
export function Card({ children, className, tone = "low", pad = true, highlight, id, dim }: { children: ReactNode; className?: string; tone?: keyof typeof TONE; pad?: boolean; highlight?: boolean; id?: string; dim?: boolean }) {
  return (
    <div id={id} className={cx("min-w-0 rounded-lg", TONE[tone], pad && "p-4", highlight && "ring-2 ring-primary", dim && "opacity-70", className)}>
      {children}
    </div>
  );
}

/** A whole card that is tappable. Renders a link when `to` is given, otherwise a button. */
export function CardButton({ children, className, onClick, to, tone = "low", dim, label }: { children: ReactNode; className?: string; onClick?: () => void; to?: string; tone?: keyof typeof TONE; dim?: boolean; label?: string }) {
  const cls = cx("state-layer pressable block w-full min-w-0 rounded-lg p-4 text-left", TONE[tone], dim && "opacity-70", className);
  return to ? (
    <Link to={to} className={cls} aria-label={label}>
      {children}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={cls} aria-label={label}>
      {children}
    </button>
  );
}

/** Button row at the foot of a card: secondary on the left of the primary, 8px apart, wraps instead of squeezing. */
export function CardActions({ children, className, spread }: { children: ReactNode; className?: string; /** Push the first action to the left edge, the rest to the right. */ spread?: boolean }) {
  return <div className={cx("flex flex-wrap items-center gap-2", spread ? "justify-between" : "justify-end", className)}>{children}</div>;
}

/** Metadata chips under a title: same gap whatever the count. */
export function Chips({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("flex min-w-0 flex-wrap items-center gap-1.5", className)}>{children}</div>;
}
