// A bar that stays pinned under the top of the screen while a long page scrolls beneath it.
// It looks like part of the page at rest, and gains a blurred surface and a hairline once it actually sticks.
// An optional compact title slides in above its content when stuck, so the page still says where you are
// after the big header has scrolled away.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "./ui";

/** Height of the status bar / notch when the app is installed (0 in a normal tab). */
function safeTop() {
  if (typeof document === "undefined") return 0;
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px)";
  document.body.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return px;
}

export function StickyBar({
  children,
  title,
  className,
  bleed = true,
}: {
  children: ReactNode;
  title?: ReactNode;
  className?: string;
  /** Full-bleed inside a page that pads its content px-4 / sm:px-8. */
  bleed?: boolean;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting && e.boundingClientRect.top < (e.rootBounds?.top ?? 0)), {
      rootMargin: `-${Math.ceil(safeTop() + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--page-header-h")) || 0))}px 0px 0px 0px`,
      threshold: 0,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      data-stuck={stuck || undefined}
      className={cx(
        // z-20: above page content and the Requests sticky aside, below the bottom nav (z-40), menus and sheets (z-[60]).
        "sticky top-[calc(env(safe-area-inset-top)+var(--page-header-h,0px))] z-20 border-b border-transparent bg-surface transition-[border-color] duration-200",
        bleed && "-mx-4 px-4 sm:-mx-8 sm:px-8",
        "data-[stuck]:border-outline-variant",
        className,
      )}
    >
      {title && (
        // Grid rows 0fr -> 1fr animates the height without measuring.
        <div className={cx("grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none", stuck ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")} aria-hidden={!stuck}>
          <div className="overflow-hidden">
            <div className="truncate pt-3 type-title-m">{title}</div>
          </div>
        </div>
      )}
      {/* Rides with the bar, just above it: it only leaves the viewport's top edge once the bar is pinned there. */}
      <div ref={sentinel} aria-hidden className="pointer-events-none absolute inset-x-0 -top-[2px] h-px" />
      {children}
    </div>
  );
}
