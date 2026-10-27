import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useSignIn } from "./Landing";
import { CuratingLogo } from "../components/CuratingLogo";
import { Bubble, Button, Chip } from "@spot/ui";
import { IconCpu, IconMic, IconShield, IconSofa } from "@spot/ui";

// A tiny looping story: DMs arrive, Gemma tags the one that matters.
const SCRIPT = [
  { from: "Rohan", text: "bhai monday ka spot milega?", spot: "Mon" },
  { from: "Ishita", text: "lol that crowd last night 😭", spot: null },
  { from: "Karthik", text: "got a new 5, any day works", spot: "Mon · Tue" },
];

function Demo() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep((s) => (s + 1) % (SCRIPT.length * 2 + 2)), 1300);
    return () => clearInterval(t);
  }, []);
  const visible = SCRIPT.slice(0, Math.min(SCRIPT.length, Math.ceil(step / 2)));
  return (
    <div className="relative w-full max-w-sm rounded-xl-plus bg-surface-container p-5" aria-hidden>
      <div className="mb-4 flex items-center gap-2 type-label-m text-on-surface-variant">
        <IconCpu className="icon size-4 text-primary" /> Gemma, on your laptop
      </div>
      <div className="flex min-h-64 flex-col gap-3">
        <AnimatePresence>
          {visible.map((m, i) => (
            <motion.div
              key={m.from}
              layout
              initial={{ opacity: 0, transform: "translateY(10px) scale(0.98)" }}
              animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
              exit={{ opacity: 0, transition: { duration: 0.2 } }}
              transition={{ duration: 0.35, ease: [0.23, 1, 0.32, 1] }}
              className="flex flex-col gap-1.5"
            >
              <span className="type-label-s text-on-surface-variant">{m.from}</span>
              <Bubble>{m.text}</Bubble>
              <AnimatePresence>
                {step >= i * 2 + 2 && (
                  <motion.div initial={{ opacity: 0, transform: "translateX(-6px)" }} animate={{ opacity: 1, transform: "translateX(0px)" }} transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}>
                    {m.spot ? (
                      <Chip tone="primary" icon={IconMic}>
                        Spot request · {m.spot}
                      </Chip>
                    ) : (
                      <span className="type-label-s text-on-surface-variant/70">Not a request · ignored</span>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

export function SignIn() {
  const { busy, run } = useSignIn();
  return (
    // Installed app: the page runs edge to edge, so every side pads past the notch, status bar and home indicator.
    <div className="grid min-h-dvh bg-surface pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] lg:grid-cols-[1.1fr_1fr]">
      <section className="flex flex-col justify-between px-6 pt-[max(2rem,calc(env(safe-area-inset-top)+1rem))] pb-[max(2rem,calc(env(safe-area-inset-bottom)+1rem))] sm:px-12 sm:pt-[max(3rem,calc(env(safe-area-inset-top)+1rem))] sm:pb-[max(3rem,calc(env(safe-area-inset-bottom)+1rem))]">
        <div className="flex items-center gap-3">
          <CuratingLogo className="size-10" />
          <span className="flex flex-col leading-tight">
            <span className="type-title-m">Nothing BOT Curating</span>
          </span>
        </div>
        <div className="my-12 max-w-xl">
          <p className="mb-4 inline-flex items-center gap-2 type-label-l text-primary">
            <IconSofa className="icon size-5" /> For open-mic curators who'd rather be writing
          </p>
          <h1 className="type-display-m text-balance">Your lineup, sorted while you sleep.</h1>
          <p className="mt-5 max-w-md type-body-l text-on-surface-variant">
            Link your WhatsApp. A local Gemma model reads the DMs, picks out who's asking for a spot, and replies for you. You drag names into shows and hit send.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <Button size="lg" onClick={() => run("google")} loading={busy === "google"}>
              <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
                <path fill="currentColor" d="M21.35 11.1H12v2.98h5.35c-.23 1.4-1.66 4.1-5.35 4.1-3.22 0-5.85-2.67-5.85-5.96S8.78 6.26 12 6.26c1.83 0 3.06.78 3.76 1.45l2.56-2.47C16.68 3.7 14.55 2.75 12 2.75 6.9 2.75 2.75 6.9 2.75 12S6.9 21.25 12 21.25c6.92 0 9.2-4.86 9.2-7.36 0-.5-.05-.88-.12-1.27z" />
              </svg>
              Continue with Google
            </Button>
            <Button size="lg" variant="outlined" icon={IconSofa} onClick={() => run("demo")} loading={busy === "demo"}>
              Try the live demo
            </Button>
          </div>
          <p className="mt-4 type-body-s text-on-surface-variant">The demo is your own sandbox of a curator's week. No sign-up.</p>
          <p className="mt-2 type-body-s text-on-surface-variant">
            <a className="underline underline-offset-4" href="/privacy">Privacy</a> · <a className="underline underline-offset-4" href="/terms">Terms</a>
          </p>
        </div>
        <ul className="grid gap-4 type-body-m text-on-surface-variant sm:grid-cols-2">
          <li className="flex gap-3">
            <IconShield className="icon size-5 flex-none text-primary" />
            Chats are read by an open model on your own machine. They never reach a cloud AI.
          </li>
          <li className="flex gap-3">
            <IconCpu className="icon size-5 flex-none text-primary" />
            Runs on an old laptop. Costs nothing to run, and it's open source.
          </li>
        </ul>
      </section>
      <section className="hidden items-center justify-center bg-surface-low p-12 lg:flex">
        <Demo />
      </section>
    </div>
  );
}
