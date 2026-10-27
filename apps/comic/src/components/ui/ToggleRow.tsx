import type { ReactNode } from "react";
import { Info, Switch, cx } from "@spot/ui";

/** A switch with its label on the left, where a form needs one on/off choice. 48px tall, the switch on the trailing edge. */
export function ToggleRow({ label, hint, info, checked, onChange, className }: { label: string; hint?: ReactNode; info?: ReactNode; checked: boolean; onChange: (v: boolean) => void; className?: string }) {
  return (
    <div className={cx("flex min-w-0 flex-col gap-0.5", className)}>
      <div className="flex min-h-12 min-w-0 items-center gap-3">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 type-title-s">
          {label}
          {info && <Info>{info}</Info>}
        </span>
        <Switch label={label} checked={checked} onChange={onChange} />
      </div>
      {hint && <p className="type-body-s text-on-surface-variant">{hint}</p>}
    </div>
  );
}
