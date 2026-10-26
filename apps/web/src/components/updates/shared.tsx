import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cx } from "../ui";

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
export function UpdateItem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.li
      data-update-card
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0, transition: { duration: 0.2, ease: [0.4, 0, 1, 1] } }}
      transition={{ duration: 0.28, ease: [0.23, 1, 0.32, 1] }}
      className="overflow-hidden"
    >
      <div className={cx("mb-3 overflow-hidden rounded-lg", className ?? "bg-surface-low")}>{children}</div>
    </motion.li>
  );
}
