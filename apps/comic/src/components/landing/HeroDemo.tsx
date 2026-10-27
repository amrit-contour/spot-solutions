// The hero mock: an ask goes out from your WhatsApp, the reply is read, the spot lands on your calendar. Demo data only.
import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Chip, IconCalendarMark, IconCheck, IconChatCheck, IconPhone, IconSparkle, cx } from "@spot/ui";
import { EASE } from "./bits";

const SCENES = [
  { room: "Comedy Square", who: "Varun", day: "Tue", time: "9:00 PM", ask: "Hi Varun, any spot at Comedy Square tomorrow? Happy with 9 or later. Amrit", reply: "yes bro, 9 pm works", read: "Got it · Tue 9 PM" },
  { room: "Bloom", who: "Meera", day: "Thu", time: "8:30 PM", ask: "Hey Meera, can I get a spot at Bloom on Thursday? Amrit", reply: "sorry, thursday's full 🙏", read: "Declined · try next week" },
  { room: "Banter", who: "Dhruv", day: "Sat", time: "7:00 PM", ask: "Hi Dhruv, any spot at Banter this Saturday? Amrit", reply: "7 pm, new 5 is fine", read: "Got it · Sat 7 PM" },
];
const STEPS_PER = 4; // ask, reply, read, placed
const HOLD = 3;

export function HeroDemo() {
  const reduce = useReducedMotion();
  const total = SCENES.length * STEPS_PER + HOLD;
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (reduce) return;
    const t = setInterval(() => setStep((s) => (s + 1) % total), 1300);
    return () => clearInterval(t);
  }, [total, reduce]);
  // Reduced motion: hold the finished picture instead of looping.
  const at = reduce ? total - 1 : step;
  const scene = Math.min(SCENES.length - 1, Math.floor(at / STEPS_PER));
  const inScene = at >= SCENES.length * STEPS_PER ? STEPS_PER : at % STEPS_PER;
  const s = SCENES[scene]!;
  const finished = at >= SCENES.length * STEPS_PER;
  // A scene's spot is placed once its 4th step has shown.
  const placed = (i: number) => finished || i < scene || (i === scene && inScene >= 3);
  const showAsk = inScene >= 0;
  const showReply = inScene >= 1 || finished;
  const showRead = inScene >= 2 || finished;

  return (
    <div className="grid w-full gap-4 sm:grid-cols-[1.05fr_1fr]">
      {/* Phone: your WhatsApp */}
      <div className="rounded-[28px] border border-outline-variant/60 bg-surface-container p-4 shadow-2xl shadow-black/20">
        <div className="mb-3 flex items-center gap-2 px-1 type-label-m text-on-surface-variant">
          <IconPhone className="icon size-4 text-primary" /> <span className="truncate">WhatsApp · {s.who}, {s.room}</span>
        </div>
        <div className="flex h-[250px] flex-col justify-end gap-2 overflow-hidden" key={scene}>
          <AnimatePresence initial={false}>
            {showAsk && (
              <motion.div key="ask" initial={{ opacity: 0, y: 14, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.4, ease: EASE }} className="ml-auto max-w-[88%]">
                <div className="rounded-2xl rounded-br-sm bg-primary-container px-3 py-2 type-body-m text-on-primary-container">{s.ask}</div>
                <div className="mt-1 text-right type-label-s text-on-surface-variant">Sent 9:00 AM, on time, from your number</div>
              </motion.div>
            )}
            {showReply && (
              <motion.div key="reply" initial={{ opacity: 0, y: 14, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.4, ease: EASE }} className="max-w-[80%]">
                <div className="w-fit rounded-2xl rounded-bl-sm bg-surface-highest px-3 py-2 type-body-m">{s.reply}</div>
                <div className="mt-1.5 h-6">
                  {showRead && (
                    <motion.span initial={{ opacity: 0, x: -6, filter: "blur(4px)" }} animate={{ opacity: 1, x: 0, filter: "blur(0px)" }} transition={{ duration: 0.3, ease: EASE }} className={cx("inline-flex items-center gap-1 rounded-sm px-2 py-0.5 type-label-s", s.read.startsWith("Got") ? "bg-primary text-on-primary" : "bg-surface-high text-on-surface-variant")}>
                      <IconSparkle className="icon size-3" /> {s.read}
                    </motion.span>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-full bg-surface-high px-3 py-1.5 type-label-s text-on-surface-variant">
          <motion.span className="size-2 flex-none rounded-full bg-primary" animate={reduce ? {} : { opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.4, repeat: Infinity }} />
          <span className="truncate">Reply read on your laptop · nothing leaves it</span>
        </div>
      </div>

      {/* My spots */}
      <div className="rounded-[22px] bg-surface-low p-4 ring-1 ring-outline-variant/50">
        <div className="flex items-center gap-2 type-label-m text-primary">
          <IconCalendarMark className="icon size-4" /> My spots · this week
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {SCENES.map((sc, i) => {
            const on = placed(i);
            const ok = sc.read.startsWith("Got");
            return (
              <div key={sc.room} className="min-h-[58px]">
                <AnimatePresence mode="wait" initial={false}>
                  {on && ok ? (
                    <motion.div key="spot" initial={{ opacity: 0, x: -24, scale: 0.94 }} animate={{ opacity: 1, x: 0, scale: 1 }} transition={{ type: "spring", duration: 0.55, bounce: 0.25 }} className="flex items-center gap-3 rounded-md bg-surface-container px-3 py-2.5">
                      <span className="grid w-10 flex-none place-items-center rounded-sm bg-primary-container py-1 type-label-m text-on-primary-container">{sc.day}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate type-title-s">{sc.room}</span>
                        <span className="block type-body-s text-on-surface-variant">{sc.time}</span>
                      </span>
                      <IconChatCheck className="icon size-4 flex-none text-primary" />
                    </motion.div>
                  ) : (
                    <motion.div key="slot" exit={{ opacity: 0 }} className="flex min-h-[58px] items-center justify-center rounded-md border border-dashed border-outline-variant px-3 text-center type-body-s text-on-surface-variant/70">
                      {on ? <span className="inline-flex items-center gap-1.5"><IconCheck className="icon size-4" /> {sc.room}: full, ask again next week</span> : `${sc.room}: waiting for a reply…`}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Chip tone="primary">{SCENES.filter((sc, i) => placed(i) && sc.read.startsWith("Got")).length} booked</Chip>
          <Chip>{SCENES.filter((sc, i) => placed(i) && !sc.read.startsWith("Got")).length} declined</Chip>
        </div>
      </div>
    </div>
  );
}
