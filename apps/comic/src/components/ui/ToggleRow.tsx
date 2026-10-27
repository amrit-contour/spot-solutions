import type { ReactNode } from "react";
import { Info, Switch, cx } from "@spot/ui";

/** A switch with its label on the left, where a form needs one on/off choice. 48px tall, the switch on the trailing edge. */
export function ToggleRow({ label, hint, info, checked, onChange, className }: { label: string; hint?: ReactNode; info?: ReactNode; checked: boolean; onChange: (v: boolean) => void; className?: string }) {
  return (
    <div className={cx("flex min-w-0 flex-col gap-0.5", className)}>
      <div className="flex min-h-12 min-w-0 items-center gap-3">
        {/* The words toggle too: a 44px+ target, not just the 32px switch. The switch itself stays the keyboard and screen-reader control. */}
        <span className="flex min-h-12 min-w-0 flex-1 cursor-pointer items-center gap-1.5 select-none type-title-s" onClick={() => onChange(!checked)}>
          {label}
          {info && <span onClick={(e) => e.stopPropagation()}><Info>{info}</Info></span>}
        </span>
        <Switch label={label} checked={checked} onChange={onChange} />
      </div>
      {hint && <p className="type-body-s text-on-surface-variant">{hint}</p>}
    </div>
  );
}
