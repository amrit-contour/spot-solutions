import type { ReactNode } from "react";
import { cx } from "@spot/ui";

/** A pick-many row: the whole row is the tap target (56px tall), a 20px checkbox on the left, title over detail. Use inside <ListGroup>. */
export function CheckRow({ checked, onChange, title, detail, lead, className }: { checked: boolean; onChange: (on: boolean) => void; title: ReactNode; detail?: ReactNode; /** Shown before the title (a chip). */ lead?: ReactNode; className?: string }) {
  return (
    <label className={cx("state-layer flex min-h-14 min-w-0 cursor-pointer items-start gap-3 px-4 py-3 select-none", className)}>
      <input type="checkbox" className="mt-0.5 size-5 flex-none accent-[var(--md-sys-color-primary)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          {lead}
          <span className="min-w-0 truncate type-title-s">{title}</span>
        </span>
        {detail && <span className="mt-0.5 block break-words type-body-s text-on-surface-variant">{detail}</span>}
      </span>
    </label>
  );
}
