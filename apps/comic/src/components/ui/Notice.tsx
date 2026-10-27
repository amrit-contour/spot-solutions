import type { ReactNode } from "react";
import { cx, IconLightbulb, IconShield, IconWarn, type Icon } from "@spot/ui";

const TONE = {
  info: { box: "bg-surface-container text-on-surface", icon: IconLightbulb, iconCls: "text-primary" },
  warn: { box: "bg-tertiary-container text-on-tertiary-container", icon: IconWarn, iconCls: "" },
  error: { box: "bg-error-container text-on-error-container", icon: IconWarn, iconCls: "" },
  privacy: { box: "bg-tertiary-container text-on-tertiary-container", icon: IconShield, iconCls: "" },
} as const;

/** A message inside a screen or sheet: a heads-up, a warning, an error. 16px padding, a 20px icon, the words wrap. Errors are announced. */
export function Notice({ tone = "info", icon, title, children, className }: { tone?: keyof typeof TONE; icon?: Icon; title?: ReactNode; children?: ReactNode; className?: string }) {
  const t = TONE[tone];
  const I = icon ?? t.icon;
  return (
    <div role={tone === "error" ? "alert" : undefined} className={cx("flex min-w-0 items-start gap-3 rounded-md p-4", t.box, className)}>
      <I aria-hidden className={cx("icon mt-0.5 size-5 flex-none", t.iconCls)} />
      <div className="min-w-0 flex-1">
        {title && <p className="type-title-s">{title}</p>}
        {children && <div className={cx("break-words type-body-m whitespace-pre-line", title ? "mt-1" : "")}>{children}</div>}
      </div>
    </div>
  );
}
