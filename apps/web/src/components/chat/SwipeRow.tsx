// A chat-list row you can swipe on a phone: left shows Done and Never read, right shows Needs reply. It follows your finger one to
// one, rubber-bands past the buttons, settles on a spring that keeps your release speed, and a long swipe runs the first button.
// Mouse users get hover buttons and everyone gets the ⋯ menu instead (see the list row), so nothing here is gesture-only.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { cx, type Icon } from "@spot/ui";

export interface SwipeAction {
  key: string;
  label: string;
  icon: Icon;
  tone: "primary" | "error" | "secondary";
  run: () => void;
}

const W = 78; // one button's width
const TONE = { primary: "bg-primary text-on-primary", error: "bg-error text-on-error", secondary: "bg-secondary text-on-secondary" } as const;
const SLOP = 10;

/** Only one row stays open at a time. */
let closeOther: (() => void) | null = null;

const rubber = (over: number, dim: number) => (over * dim * 0.55) / (dim + 0.55 * Math.abs(over));

export function SwipeRow({ children, left, right, disabled }: { children: ReactNode; left: SwipeAction[]; right: SwipeAction[]; disabled?: boolean }) {
  const x = useMotionValue(0);
  // The buttons only exist while the row is off centre (otherwise their corners bleed through the rounded clip).
  const shown = useTransform(x, (v) => (Math.abs(v) < 0.5 ? "hidden" : "visible"));
  const wrap = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const [open, setOpen] = useState<"left" | "right" | null>(null);
  const [armed, setArmed] = useState<"left" | "right" | null>(null);
  const drag = useRef<{ id: number; x0: number; y0: number; from: number; mode: "idle" | "h" | "v"; samples: { t: number; x: number }[]; moved: boolean } | null>(null);
  const maxLeft = left.length * W; // x > 0 reveals the left buttons
  const maxRight = right.length * W; // x < 0 reveals the right buttons

  const settle = (to: number, velocity = 0) => {
    animate(x, to, reduce ? { duration: 0.12, ease: "easeOut" } : { type: "spring", stiffness: 520, damping: 42, mass: 1, velocity });
    const side = to > 0 ? "left" : to < 0 ? "right" : null;
    setOpen(side);
    if (side) {
      closeOther?.();
      closeOther = () => settle(0);
    } else if (closeOther) closeOther = null;
  };
  useEffect(() => () => void (closeOther = null), []);

  const rowWidth = () => wrap.current?.offsetWidth ?? 360;

  const onDown = (e: React.PointerEvent) => {
    if (disabled || e.pointerType === "mouse" || (!left.length && !right.length)) return;
    x.stop();
    drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, from: x.get(), mode: "idle", samples: [{ t: e.timeStamp, x: e.clientX }], moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (d.mode === "idle") {
      if (Math.abs(dy) > SLOP && Math.abs(dy) > Math.abs(dx)) return void (d.mode = "v");
      if (Math.abs(dx) > SLOP && Math.abs(dx) > Math.abs(dy) * 1.2) {
        d.mode = "h";
        d.moved = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } else return;
    }
    if (d.mode !== "h") return;
    d.samples.push({ t: e.timeStamp, x: e.clientX });
    if (d.samples.length > 6) d.samples.shift();
    // Past the buttons the row resists, and stops following soon after.
    let next = d.from + dx - Math.sign(dx) * SLOP;
    if (next > maxLeft) next = maxLeft + rubber(next - maxLeft, rowWidth());
    if (next < -maxRight) next = -maxRight - rubber(-maxRight - next, rowWidth());
    if (!left.length && next > 0) next = rubber(next, rowWidth()) * 0.4;
    if (!right.length && next < 0) next = -rubber(-next, rowWidth()) * 0.4;
    x.set(next);
    const side = next > maxLeft * 0.55 ? "left" : next < -maxRight * 0.55 ? "right" : null;
    setArmed((a) => {
      if (a !== side && side) navigator.vibrate?.(6);
      return side;
    });
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || e.pointerId !== d.id || d.mode !== "h") return;
    setArmed(null);
    const s = d.samples;
    const v = s.length > 1 ? ((s[s.length - 1].x - s[0].x) / Math.max(1, s[s.length - 1].t - s[0].t)) * 1000 : 0; // px/s
    const cur = x.get();
    const projected = cur + v * 0.18;
    const full = rowWidth() * 0.62;
    if (projected < -full && right.length) {
      settle(0, v);
      right[0].run();
    } else if (projected > full && left.length) {
      settle(0, v);
      left[0].run();
    } else if (projected < -maxRight * 0.45 && right.length) settle(-maxRight, v);
    else if (projected > maxLeft * 0.45 && left.length) settle(maxLeft, v);
    else settle(0, v);
  };
  const onCancel = () => {
    drag.current = null;
    setArmed(null);
    settle(open === "left" ? maxLeft : open === "right" ? -maxRight : 0);
  };

  const run = (a: SwipeAction) => {
    settle(0);
    a.run();
  };

  return (
    <div ref={wrap} className="relative overflow-hidden rounded-lg">
      <motion.div style={{ visibility: shown }} aria-hidden={open !== "left"} className="absolute inset-y-0 left-0 flex">
        {left.map((a) => (
          <ActionButton key={a.key} a={a} lit={armed === "left"} hidden={open !== "left"} onRun={run} />
        ))}
      </motion.div>
      <motion.div style={{ visibility: shown }} aria-hidden={open !== "right"} className="absolute inset-y-0 right-0 flex">
        {right.map((a) => (
          <ActionButton key={a.key} a={a} lit={armed === "right" && a === right[0]} hidden={open !== "right"} onRun={run} />
        ))}
      </motion.div>
      <motion.div
        style={{ x, touchAction: "pan-y" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onCancel}
        onClickCapture={(e) => {
          // A swipe isn't a tap, and a tap on an open row only closes it.
          if (drag.current?.moved || open) {
            e.preventDefault();
            e.stopPropagation();
            if (open) settle(0);
          }
        }}
        className="relative bg-surface"
      >
        {children}
      </motion.div>
    </div>
  );
}

function ActionButton({ a, lit, hidden, onRun }: { a: SwipeAction; lit: boolean; hidden: boolean; onRun: (a: SwipeAction) => void }) {
  const I = a.icon;
  return (
    <button type="button" tabIndex={hidden ? -1 : 0} onClick={() => onRun(a)} style={{ width: W }} className={cx("pressable flex flex-col items-center justify-center gap-1 type-label-m", TONE[a.tone])}>
      <I className={cx("icon size-6 transition-transform duration-150 ease-out", lit && "scale-125")} />
      {a.label}
    </button>
  );
}
