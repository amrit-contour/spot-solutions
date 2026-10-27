import type { ReactNode } from "react";
import { cx, type Icon } from "@spot/ui";

/** Nothing here yet: what it is, what to do. Compact enough to sit inside a section, not a whole screen. */
export function EmptyState({ icon: I, title, children, action, className }: { icon: Icon; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex flex-col items-center rounded-lg border border-dashed border-outline-variant px-6 py-10 text-center", className)}>
      <span aria-hidden className="mb-4 grid size-12 place-items-center rounded-md bg-surface-high text-primary">
        <I className="icon size-6" />
      </span>
      <h3 className="type-title-m">{title}</h3>
      {children && <p className="mt-1 max-w-xs type-body-m text-on-surface-variant">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

