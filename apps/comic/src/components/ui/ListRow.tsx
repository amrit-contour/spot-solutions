import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cx, type Icon } from "@spot/ui";

/** A rounded square holding an icon (or initials). 40px, the leading slot of every row and card header. */
export function IconTile({ icon: I, tone = "tertiary", className }: { icon: Icon; tone?: "tertiary" | "primary" | "neutral"; className?: string }) {
  const t = { tertiary: "bg-tertiary-container text-on-tertiary-container", primary: "bg-primary-container text-on-primary-container", neutral: "bg-surface-high text-primary" }[tone];
  return (
    <span aria-hidden className={cx("grid size-10 flex-none place-items-center rounded-md", t, className)}>
      <I className="icon size-5" />
    </span>
  );
}

/**
 * Leading slot, title over subtitle, trailing slot. 56px minimum, 16px from the edges, 12px between slots.
 * Use inside <ListGroup>; give it `to` or `onClick` to make the whole row a tap target.
 */
export function ListRow({ leading, title, subtitle, trailing, to, onClick, className, align = "center" }: { leading?: ReactNode; title: ReactNode; subtitle?: ReactNode; trailing?: ReactNode; to?: string; onClick?: () => void; className?: string; align?: "center" | "start" }) {
  const cls = cx("flex min-h-14 w-full min-w-0 gap-3 px-4 py-2.5 text-left", align === "center" ? "items-center" : "items-start", (to || onClick) && "state-layer pressable", className);
  const body = (
    <>
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block truncate type-title-s">{title}</span>
        {subtitle && <span className="block truncate type-body-s text-on-surface-variant">{subtitle}</span>}
      </span>
      {trailing && <span className="flex flex-none items-center gap-2 text-on-surface-variant">{trailing}</span>}
    </>
  );
  if (to) return <Link to={to} className={cls}>{body}</Link>;
  if (onClick) return <button type="button" onClick={onClick} className={cls}>{body}</button>;
  return <div className={cls}>{body}</div>;
}

/** Rows in one rounded container with hairline dividers (inset past the leading slot). */
export function ListGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("min-w-0 overflow-hidden rounded-lg bg-surface-low [&>*+*]:border-t [&>*+*]:border-outline-variant/50", className)}>{children}</div>;
}
