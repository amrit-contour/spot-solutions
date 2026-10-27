// A chat-list row you can swipe on a phone: one way shows a single action (Needs reply), the other way another (Clear).
// The row follows your finger one to one up to the action's width, then resists (rubber band), the coloured action surface
// grows with the row and has its own rounded edges (it never shows a clipped corner), the icon scales and fades in as you
// pass the threshold, release settles on a spring that keeps your speed, and a long swipe runs the action with a short
// confirmation (the icon turns into a tick) before the row slides back.
// Mouse users get hover buttons and everyone gets the ⋯ menu instead (see the list row), so nothing here is gesture-only.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform, type MotionValue } from "motion/react";
import { cx, IconCheck, type Icon } from "@spot/ui";

export interface SwipeAction {
  key: string;
  label: string;
  icon: Icon;
  tone: "primary" | "error" | "secondary";
  run: () => void;
}

const W = 88; // the action's resting width
const FULL = W * 1.4; // pulled this far (or flicked towards it) the action runs
const TONE = { primary: "bg-primary text-on-primary", error: "bg-error text-on-error", secondary: "bg-secondary text-on-secondary" } as const;
const SLOP = 10;

/** Only one row stays open at a time. */
let closeOther: (() => void) | null = null;

/** The further past the limit, the less the row follows: it slows before it stops. */
const rubber = (over: number, dim: number) => (over * dim * 0.55) / (dim + 0.55 * Math.abs(over));

type Side = "left" | "right";

export function SwipeRow({ children, left, right, disabled }: { children: ReactNode; left: SwipeAction[]; right: SwipeAction[]; disabled?: boolean }) {
  const x = useMotionValue(0);
  const reduce = useReducedMotion();
  const [open, setOpen] = useState<Side | null>(null);
  const [lit, setLit] = useState<Side | null>(null);
  const [done, setDone] = useState<Side | null>(null);
  const drag = useRef<{ id: number; x0: number; y0: number; from: number; mode: "idle" | "h" | "v"; samples: { t: number; x: number }[]; moved: boolean } | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const a = { left: left[0], right: right[0] };
  // x > 0 reveals the left action, x < 0 the right one.
  const lo = a.right ? -W : 0;
  const hi = a.left ? W : 0;

  const settle = (to: number, velocity = 0) => {
    animate(x, to, reduce ? { duration: 0.12, ease: "easeOut" } : { type: "spring", stiffness: 480, damping: 38, mass: 1, velocity });
    const side: Side | null = to > 0 ? "left" : to < 0 ? "right" : null;
    setOpen(side);
    if (side) {
      closeOther?.();
      closeOther = () => settle(0);
    } else if (closeOther) closeOther = null;
  };
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      closeOther = null;
    },
    [],
  );

  const commit = (side: Side, v: number) => {
    const act = a[side];
    if (!act) return settle(0, v);
    // A short confirmation: the row stays a beat on the action, which shows a tick, then slides back.
    setDone(side);
    animate(x, side === "left" ? W : -W, reduce ? { duration: 0.1 } : { type: "spring", stiffness: 420, damping: 34, velocity: v });
    timers.current.push(
      setTimeout(() => act.run(), 260),
      setTimeout(() => {
        settle(0);
        setDone(null);
      }, 520),
    );
  };

  const onDown = (e: React.PointerEvent) => {
    if (disabled || done || e.pointerType === "mouse" || (!a.left && !a.right)) return;
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
    // 1:1 up to the action's width, then resistance; with no action on a side, only a little give.
    let next = d.from + dx - Math.sign(dx) * SLOP;
    if (next > hi) next = hi + rubber(next - hi, 160) * (hi ? 1 : 0.35);
    if (next < lo) next = lo - rubber(lo - next, 160) * (lo ? 1 : 0.35);
    x.set(next);
    const side: Side | null = next >= FULL ? "left" : next <= -FULL ? "right" : null;
    setLit((l) => {
      if (l !== side && side) navigator.vibrate?.(8);
      return side;
    });
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || e.pointerId !== d.id || d.mode !== "h") return;
    setLit(null);
    const s = d.samples;
    const v = s.length > 1 ? ((s[s.length - 1].x - s[0].x) / Math.max(1, s[s.length - 1].t - s[0].t)) * 1000 : 0; // px/s
    const cur = x.get();
    const projected = cur + v * 0.1;
    if (a.right && projected <= -FULL) commit("right", v);
    else if (a.left && projected >= FULL) commit("left", v);
    else if (a.right && projected < -W * 0.5) settle(-W, v);
    else if (a.left && projected > W * 0.5) settle(W, v);
    else settle(0, v);
  };
  const onCancel = () => {
    drag.current = null;
    setLit(null);
    if (!done) settle(open === "left" ? W : open === "right" ? -W : 0);
  };

  const run = (side: Side) => {
    const act = a[side];
    settle(0);
    act?.run();
  };

  return (
    <div className="relative overflow-hidden rounded-lg">
      {a.left && <Reveal side="left" a={a.left} x={x} lit={lit === "left"} done={done === "left"} open={open === "left"} onRun={() => run("left")} />}
      {a.right && <Reveal side="right" a={a.right} x={x} lit={lit === "right"} done={done === "right"} open={open === "right"} onRun={() => run("right")} />}
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
            if (open && !done) settle(0);
          }
        }}
        className="relative rounded-lg bg-surface"
      >
        {children}
      </motion.div>
    </div>
  );
}

/** The coloured surface behind the row: as wide as the gap the row has opened (plus a little tucked under it, so the row's own
 *  rounded corners show colour, not a notch), with rounded edges, and the action's icon scaling and fading in as you pull. */
function Reveal({ side, a, x, lit, done, open, onRun }: { side: Side; a: SwipeAction; x: MotionValue<number>; lit: boolean; done: boolean; open: boolean; onRun: () => void }) {
  const pulled = useTransform(x, (v) => (side === "left" ? Math.max(0, v) : Math.max(0, -v)));
  const width = useTransform(pulled, (v) => (v < 0.5 ? 0 : v + 24));
  const scale = useTransform(pulled, [0, W * 0.4, W, FULL], [0.5, 0.72, 1, 1.12]);
  const opacity = useTransform(pulled, [W * 0.15, W * 0.62], [0, 1]);
  const I = done ? IconCheck : a.icon;
  return (
    <motion.div style={{ width }} className={cx("absolute inset-y-0 overflow-hidden rounded-lg", side === "left" ? "left-0" : "right-0", TONE[a.tone])}>
      <button
        type="button"
        tabIndex={open ? 0 : -1}
        aria-hidden={!open}
        onClick={onRun}
        style={{ width: W }}
        className={cx("pressable absolute inset-y-0 flex items-center justify-center type-label-m", side === "left" ? "left-0" : "right-0")}
      >
        <motion.span style={{ scale, opacity }} className="flex flex-col items-center gap-1">
          <motion.span key={done ? "tick" : "icon"} initial={done ? { scale: 0.5 } : false} animate={{ scale: lit || done ? 1.2 : 1 }} transition={{ type: "spring", stiffness: 520, damping: 22 }}>
            <I className="icon size-6" />
          </motion.span>
          {a.label}
        </motion.span>
      </button>
    </motion.div>
  );
}
