// Shared header for the WhatsApp and Agent number cards. One row from sm up: [icon title (i) status pill ........ actions].
// On a phone the title row keeps the actions on its right and the status pill drops under the title, so nothing is a lonely row of wide buttons.
import type { ReactNode } from "react";
import { IconButton, IconMenuDots, Menu, MenuItem, cx } from "@spot/ui";
import type { Icon } from "@spot/ui";

export function LinkCardHeader({ icon: I, title, info, pill, primary, actions }: { icon?: Icon; title: ReactNode; info?: ReactNode; pill: ReactNode; primary?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex min-w-0 flex-1 items-center gap-3 sm:flex-none">
        {I && (
          <span className="grid size-10 flex-none place-items-center rounded-md bg-secondary-container text-on-secondary-container">
            <I className="icon size-5" />
          </span>
        )}
        <h2 className="type-headline-s">{title}</h2>
        {info}
      </div>
      {/* Phone: the status pill and the main action share the second row. sm+: they join the single header row (pill beside the title, actions right). */}
      <div className="order-last flex basis-full items-center justify-between gap-2 sm:contents">
        <div className="flex min-w-0">{pill}</div>
        {primary && <div className="flex-none sm:ml-auto">{primary}</div>}
      </div>
      {actions && <div className={cx("flex flex-none items-center gap-2", !primary && "sm:ml-auto")}>{actions}</div>}
    </div>
  );
}

/** Phone-only overflow menu: the secondary action (Unlink) lives here so the header stays one compact row. */
export function OverflowMenu({ label, className, children }: { label: string; className?: string; children: (close: () => void) => ReactNode }) {
  return (
    <div className={cx("sm:hidden", className)}>
      <Menu align="right" trigger={(toggle) => <IconButton icon={IconMenuDots} label={label} onClick={toggle} aria-haspopup="menu" />}>
        {children}
      </Menu>
    </div>
  );
}
export { MenuItem };
