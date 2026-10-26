import { useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cx } from "@spot/ui";

/** A number that rolls when it changes. */
export function Count({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cx("relative inline-grid overflow-hidden tabular", className)}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          className="[grid-area:1/1]"
          initial={{ opacity: 0, transform: "translateY(60%)" }}
          animate={{ opacity: 1, transform: "translateY(0%)" }}
          exit={{ opacity: 0, transform: "translateY(-60%)" }}
          transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** One card in the Updates list. Animates in, and out once it has been acted on (the height collapses so the rest slide up). */
/** Swipe this far (or flick) sideways to clear a card. */
const SWIPE_PX = 96;

export function UpdateItem({ children, className, onDismiss }: { children: ReactNode; className?: string; /** Swipe left or right to call it. */ onDismiss?: () => void }) {
  const reduce = useReducedMotion();
  const [dx, setDx] = useState(0);
  return (
    <motion.li
      data-update-card
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0, transition: { duration: 0.2, ease: [0.4, 0, 1, 1] } }}
      transition={{ duration: 0.28, ease: [0.23, 1, 0.32, 1] }}
      className="relative overflow-hidden"
    >
      {onDismiss && dx !== 0 && (
        // Revealed behind the card while it slides.
        <div aria-hidden className={cx("absolute inset-0 mb-3 flex items-center rounded-lg bg-surface-highest px-5 type-label-l text-on-surface-variant", dx > 0 ? "justify-start" : "justify-end")}>
          {Math.abs(dx) > SWIPE_PX ? "Release to clear" : "Clear"}
        </div>
      )}
      <motion.div
        drag={onDismiss && !reduce ? "x" : false}
        dragDirectionLock
        dragSnapToOrigin
        dragElastic={0.5}
        onDrag={(_, i) => setDx(i.offset.x)}
        onDragEnd={(_, i) => {
          setDx(0);
          if (Math.abs(i.offset.x) > SWIPE_PX || Math.abs(i.velocity.x) > 600) onDismiss?.();
        }}
        style={{ touchAction: onDismiss ? "pan-y" : undefined }}
        className={cx("relative mb-3 overflow-hidden rounded-lg", className ?? "bg-surface-low")}
      >
        {children}
      </motion.div>
    </motion.li>
  );
}
