import type { ReactNode } from "react";
import { cx } from "@spot/ui";

/** A number over its label. Tiles in a row share the width equally and align on one baseline. */
export function StatTile({ value, label, className }: { value: ReactNode; label: string; className?: string }) {
  return (
    <div className={cx("flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg bg-surface-low px-4 py-3", className)}>
      <span className="type-headline-s tabular">{value}</span>
      <span className="truncate type-body-s text-on-surface-variant">{label}</span>
    </div>
  );
}

export function StatRow({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 gap-2">{children}</div>;
}
