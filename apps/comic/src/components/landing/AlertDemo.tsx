// A group spot offer arrives, one tap asks for it. Demo data only.
import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { IconChatCheck, IconGroup, IconSend, cx } from "@spot/ui";
import { EASE } from "./bits";

export function AlertDemo() {
  const reduce = useReducedMotion();
  const [step, setStep] = useState(0); // 0 empty, 1 alert, 2 pressed, 3 sent
  useEffect(() => {
    if (reduce) return;
    const t = setInterval(() => setStep((s) => (s + 1) % 5), 1500);
    return () => clearInterval(t);
  }, [reduce]);
  const at = reduce ? 3 : step;
  return (
    <div className="mx-auto w-full max-w-sm rounded-[28px] bg-inverse-on-surface/10 p-4 ring-1 ring-inverse-on-surface/15">
      <div className="px-1 pb-3 type-label-m opacity-70">Locked screen · 6:12 PM</div>
      <div className="flex min-h-[210px] flex-col justify-start">
        <AnimatePresence mode="wait">
          {at >= 1 && (
            <motion.div key="card" initial={{ opacity: 0, y: -16, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.45, ease: EASE }} className="rounded-2xl bg-inverse-surface p-4 shadow-lg ring-1 ring-inverse-on-surface/20">
              <div className="flex items-center gap-2 type-label-s opacity-75">
                <IconGroup className="icon size-4" /> Bangalore Comics · now
              </div>
              <div className="mt-2 type-title-m">Spot offer at Banter, 9 PM today</div>
              <div className="mt-1 type-body-m opacity-80">Rahul: “spots at 7 and 9 tonight at Banter, DM me”</div>
              <div className="mt-3 flex items-center gap-2">
                <span className={cx("inline-flex h-9 items-center gap-1.5 rounded-full px-4 type-label-l transition-colors duration-300", at >= 3 ? "bg-inverse-on-surface/15 text-inherit" : "bg-primary text-on-primary", at === 2 && "scale-95")}>
                  {at >= 3 ? <><IconChatCheck className="icon size-4" /> Asked Rahul</> : <><IconSend className="icon size-4" /> Ask for it</>}
                </span>
                {at >= 3 && <span className="type-label-s opacity-75">from your WhatsApp</span>}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {at === 0 && <div className="grid flex-1 place-items-center type-body-s opacity-60">Watching your groups…</div>}
      </div>
    </div>
  );
}
