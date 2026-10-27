import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, type ReactNode } from "react";

export interface PagerHandle {
  go(delta: -1 | 1): void;
}

/**
 * Three pages (previous, current, next) in a native scroll-snap row: the browser does the finger tracking, momentum and snapping.
 * When a swipe settles on a neighbour, `onShift` fires and the row is re-centred on the new current page, so it never ends.
 */
export const SwipePager = forwardRef<PagerHandle, { onShift: (delta: -1 | 1) => void; resetKey: string; label: string; children: (offset: -1 | 0 | 1) => ReactNode }>(function SwipePager({ onShift, resetKey, label, children }, handle) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const shift = useRef(onShift);
  shift.current = onShift;
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollLeft = el.clientWidth;
  }, [resetKey]);
  const settle = useCallback(() => {
    const el = ref.current;
    if (!el || !el.clientWidth) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i !== 1) shift.current(i === 0 ? -1 : 1);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useImperativeHandle(handle, () => ({
    go(d) {
      const el = ref.current;
      if (!el) return;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduce) shift.current(d);
      else el.scrollTo({ left: el.clientWidth * (1 + d), behavior: "smooth" });
    },
  }));
  return (
    <div
      ref={ref}
      aria-label={label}
      onScroll={() => {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(settle, 110);
      }}
      className="flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {([-1, 0, 1] as const).map((o) => (
        <div key={o} aria-hidden={o !== 0} inert={o !== 0} className="w-full flex-none snap-start snap-always">
          {children(o)}
        </div>
      ))}
    </div>
  );
});
