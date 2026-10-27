// Pull the chat list down from the top to sync (phones). It listens on the page's scroller, ignores sideways swipes (the rows'
// own gesture) and only starts when the list is already at the top.
import { useEffect, useRef, useState } from "react";
import { appScroller, Spinner, cx } from "@spot/ui";

const TRIGGER = 64;
const MAX = 96;

export function usePullToRefresh(enabled: boolean, onRefresh: () => Promise<unknown> | void) {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  useEffect(() => {
    const el = appScroller();
    if (!enabled || !el) return;
    let y0 = 0;
    let x0 = 0;
    let mode: "off" | "idle" | "pull" = "off";
    let value = 0;
    const set = (v: number) => {
      value = v;
      setPull(v);
    };
    const start = (e: TouchEvent) => {
      mode = e.touches.length === 1 && el.scrollTop <= 0 ? "idle" : "off";
      y0 = e.touches[0].clientY;
      x0 = e.touches[0].clientX;
    };
    const move = (e: TouchEvent) => {
      if (mode === "off") return;
      const dy = e.touches[0].clientY - y0;
      const dx = e.touches[0].clientX - x0;
      if (mode === "idle") {
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) return void (mode = "off");
        if (dy < -6) return void (mode = "off");
        if (dy > 10 && el.scrollTop <= 0) mode = "pull";
        else return;
      }
      set(Math.min(MAX, Math.max(0, (dy - 10) * 0.5)));
    };
    const end = () => {
      if (mode === "pull" && value >= TRIGGER) {
        setBusy(true);
        set(0); // the header's own sync icon takes over
        void Promise.resolve(refresh.current()).finally(() => {
          setBusy(false);
          set(0);
        });
      } else set(0);
      mode = "off";
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: true });
    el.addEventListener("touchend", end, { passive: true });
    el.addEventListener("touchcancel", end, { passive: true });
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
  }, [enabled]);
  return { pull, busy };
}

/** The little spinner that grows as you pull. Takes no room when idle. */
export function PullIndicator({ pull, busy }: { pull: number; busy: boolean }) {
  if (pull <= 0) return null;
  return (
    <div style={{ height: pull }} className={cx("grid place-items-center overflow-hidden text-primary", !busy && pull === 0 && "transition-[height]")} aria-hidden>
      <span style={{ opacity: Math.min(1, pull / TRIGGER), transform: `rotate(${pull * 4}deg)` }}>
        <Spinner className="size-6" />
      </span>
    </div>
  );
}
