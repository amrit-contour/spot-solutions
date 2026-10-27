import type { ReactNode } from "react";
import { cx } from "@spot/ui";

/**
 * The body of every comic page, under its PageHeader. One column, one gutter (16px phone, 32px desktop),
 * sections 24px apart, and room at the bottom for the phone tab bar. Pair with <PageHeader width="narrow" />
 * so the title and the content share the same left edge.
 */
export function Page({ children, className, gap = 6, wide }: { children: ReactNode; className?: string; gap?: 4 | 6 | 8; /** Room for two columns on a laptop (still one column below lg). */ wide?: boolean }) {
  return (
    <div
      className={cx(
        "mx-auto flex w-full min-w-0 flex-col px-4 pt-4 pb-[calc(var(--nav-h)+2rem)] sm:px-8 sm:pb-16",
        wide ? "max-w-3xl lg:max-w-6xl" : "max-w-3xl",
        gap === 4 ? "gap-4" : gap === 8 ? "gap-8" : "gap-6",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A group of things under one heading: heading, then content 8px below it. */
export function Section({ title, count, action, children, className, label }: { title?: ReactNode; count?: number; action?: ReactNode; children: ReactNode; className?: string; label?: string }) {
  return (
    <section aria-label={label ?? (typeof title === "string" ? title : undefined)} className={cx("flex min-w-0 flex-col gap-2", className)}>
      {(title || action) && <SectionHeader title={title} count={count} action={action} />}
      {children}
    </section>
  );
}

/** Heading row for a section: title on the left edge of the cards below, count and action on the right. */
export function SectionHeader({ title, count, action }: { title?: ReactNode; count?: number; action?: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3 px-1">
      <h2 className="flex min-w-0 items-baseline gap-2 type-title-s text-on-surface">
        <span className="truncate">{title}</span>
        {count != null && <span className="type-label-m text-on-surface-variant tabular">{count}</span>}
      </h2>
      {action && <div className="flex flex-none items-center gap-1">{action}</div>}
    </div>
  );
}
