// Signed-out front page: what Spot Solutions is, a live animated demo of the flow, and two ways in.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { signInWithPopup } from "firebase/auth";
import { AnimatePresence, motion, useInView, useScroll, useTransform } from "motion/react";
import { toast } from "sonner";
import { auth, google } from "../lib/firebase";
import { startDemo } from "../lib/demo";
import { Logo } from "../components/Logo";
import { Button, cx } from "../components/ui";
import {
  IconCalendarMark,
  IconChatCheck,
  IconCpu,
  IconGroup,
  IconMic,
  IconPhone,
  IconServer,
  IconShield,
  IconSofa,
  IconSparkle,
} from "../components/icons";

const EASE = [0.23, 1, 0.32, 1] as const;

function useSignIn() {
  const [busy, setBusy] = useState<"demo" | "google" | null>(null);
  const run = async (kind: "demo" | "google") => {
    setBusy(kind);
    try {
      if (kind === "demo") await startDemo();
      else await signInWithPopup(auth, google);
    } catch (e) {
      toast.error((e as Error).message.replace("Firebase: ", ""));
      setBusy(null);
    }
  };
  return { busy, run };
}

/* ---------------- Hero animation: DMs in → Gemma reads → lineup fills ---------------- */

const DMS = [
  { name: "Rohan", text: "bhai monday ka spot milega? naya 5 hai", tag: "Spot · Mon", spot: true, show: 0 },
  { name: "Ishita", text: "lol that crowd last night 😭", tag: "Not a request", spot: false, show: -1 },
  { name: "Karthik", text: "got new bits, any day works", tag: "Spot · Mon · Tue", spot: true, show: 1 },
  { name: "Bank", text: "Your account statement is ready", tag: "Ignored", spot: false, show: -1 },
  { name: "Ananya", text: "can I close tuesday? testing my special", tag: "Spot · Tue", spot: true, show: 1 },
];

function HeroLoop() {
  const [step, setStep] = useState(0);
  const total = DMS.length * 2 + 4;
  useEffect(() => {
    const t = setInterval(() => setStep((s) => (s + 1) % total), 1100);
    return () => clearInterval(t);
  }, [total]);
  const shown = DMS.slice(0, Math.min(DMS.length, Math.ceil(step / 2)));
  const classified = (i: number) => step >= i * 2 + 2;
  const placed = DMS.map((d, i) => ({ ...d, i })).filter((d) => d.spot && classified(d.i) && step >= d.i * 2 + 3);
  return (
    <div className="relative grid w-full gap-4 sm:grid-cols-[1.05fr_1fr]">
      {/* Phone */}
      <div className="relative rounded-[28px] border border-outline-variant/60 bg-surface-container p-4 shadow-2xl shadow-black/20">
        <div className="mb-3 flex items-center gap-2 px-1 type-label-m text-on-surface-variant">
          <IconPhone className="icon size-4 text-primary" /> WhatsApp · your DMs
        </div>
        <div className="flex h-[340px] flex-col justify-end gap-2 overflow-hidden">
          <AnimatePresence initial={false}>
            {shown.map((m, i) => (
              <motion.div key={m.name} initial={{ opacity: 0, y: 14, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, transition: { duration: 0.15 } }} transition={{ duration: 0.4, ease: EASE }}>
                <div className="type-label-s text-on-surface-variant">{m.name}</div>
                <div className="mt-1 w-fit max-w-full rounded-2xl rounded-bl-sm bg-surface-highest px-3 py-1.5 type-body-m">{m.text}</div>
                {/* Tag space is reserved up front so rows never change height mid-animation. */}
                <div className="mt-1 h-5">
                  {classified(i) && (
                    <motion.span
                      initial={{ opacity: 0, x: -6, filter: "blur(4px)" }}
                      animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
                      transition={{ duration: 0.3, ease: EASE }}
                      className={cx("inline-block rounded-sm px-2 py-0.5 type-label-s", m.spot ? "bg-primary text-on-primary" : "bg-surface-high text-on-surface-variant")}
                    >
                      {m.tag}
                    </motion.span>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-full bg-surface-high px-3 py-1.5 type-label-s text-on-surface-variant">
          <motion.span className="size-2 rounded-full bg-primary" animate={{ opacity: [0.3, 1, 0.3] }} transition={{ duration: 1.4, repeat: Infinity }} />
          Gemma 3 · reading on your laptop · nothing leaves it
        </div>
      </div>
      {/* Lineup */}
      <div className="grid gap-3">
        {["Monday Mic · 8 PM", "Tuesday Trial · 8:30 PM"].map((title, s) => (
          <div key={title} className="rounded-[22px] bg-surface-low p-4 ring-1 ring-outline-variant/50">
            <div className="type-label-m text-primary">{title}</div>
            <div className="mt-2 flex min-h-[104px] flex-col gap-1.5">
              <AnimatePresence>
                {placed
                  .filter((p) => p.show === s)
                  .map((p, idx) => (
                    <motion.div
                      key={p.name}
                      layout
                      initial={{ opacity: 0, x: -24, scale: 0.94 }}
                      animate={{ opacity: 1, x: 0, scale: 1 }}
                      transition={{ type: "spring", duration: 0.55, bounce: 0.25 }}
                      className="flex items-center gap-2.5 rounded-md bg-surface-container px-3 py-2"
                    >
                      <span className="w-4 type-label-m text-on-surface-variant tabular">{idx + 1}</span>
                      <span className="grid size-6 place-items-center rounded-full bg-primary-container type-label-s text-on-primary-container">{p.name[0]}</span>
                      <span className="type-title-s">{p.name}</span>
                      <IconChatCheck className="icon ml-auto size-4 text-primary" />
                    </motion.div>
                  ))}
              </AnimatePresence>
              {!placed.some((p) => p.show === s) && <div className="grid h-10 place-items-center rounded-md border border-dashed border-outline-variant type-body-s text-on-surface-variant/70">Waiting for requests…</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Building blocks ---------------- */

function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });
  return (
    <motion.div ref={ref} className={className} initial={{ opacity: 0, y: 24 }} animate={inView ? { opacity: 1, y: 0 } : {}} transition={{ duration: 0.6, delay, ease: EASE }}>
      {children}
    </motion.div>
  );
}

function SectionHead({ kicker, title, children }: { kicker: string; title: ReactNode; children?: ReactNode }) {
  return (
    <Reveal className="max-w-2xl">
      <p className="type-label-l text-primary">{kicker}</p>
      <h2 className="mt-2 type-display-s text-balance">{title}</h2>
      {children && <p className="mt-4 type-body-l text-on-surface-variant">{children}</p>}
    </Reveal>
  );
}

function Counter({ to, suffix = "" }: { to: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!inView) return;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / 1200);
      setN(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, to]);
  return (
    <span ref={ref} className="tabular">
      {n}
      {suffix}
    </span>
  );
}

const FEATURES = [
  { icon: IconSparkle, title: "Reads every way comics ask", body: "“bhai monday ka spot?”, “put me down pls”, “guru tuesday sigutta?”. Gemma reads English, Hinglish and Kannada, and quotes the actual ask, so bank alerts and memes never sneak in." },
  { icon: IconMic, title: "A lineup board, not a spreadsheet", body: "Requests land in Waiting. Drag them into shows, or tap + on your phone. Last week's performers sink to the bottom, and repeats are one click." },
  { icon: IconChatCheck, title: "Messages that write themselves", body: "Acknowledgements, confirmations and polite regrets from your own templates. Set lengths and map links appear only where they apply." },
  { icon: IconGroup, title: "Show groups that tidy themselves", body: "On show day, last week's comics leave the group and tonight's join. Admins and regulars always stay. Failed adds get an invite link." },
  { icon: IconShield, title: "Your rules, enforced", body: "Request windows, skip-last-week, ban and ignore lists. Rule-breakers wait in Held instead of cluttering your inbox." },
  { icon: IconCalendarMark, title: "The boring bits, remembered", body: "Spot history, cancellations, “did the mic happen?”, host availability polls and last-minute spot offers. Everything V1 did in a spreadsheet." },
];

const FAQ = [
  ["Does it reply to people on its own?", "Only if you switch it on. By default nothing leaves your WhatsApp until you tap Send. Auto-acknowledge, when enabled, needs a quoted ask at 85% confidence, a message under 10 minutes old, and a real person (never a business account)."],
  ["Where do my chats go?", "To Gemma, running on your own computer through Ollama. Chats that aren't spot requests are never stored. You can choose Gemini as primary or fallback if you want a bigger model."],
  ["What do I need to run it?", "Any always-on computer: an old laptop on Ubuntu, a Windows PC or a Mac. One installer each. It works from anywhere after that, even on mobile data."],
  ["Can other curators use my server?", "Yes. It's invite-only: they sign in, you approve them, and each links their own WhatsApp. One 8 GB laptop comfortably hosts about six."],
  ["What does it cost?", "Nothing to run. Gemma is open-weight and runs locally; the app runs on Firebase's free tier."],
  ["Is it official WhatsApp?", "It uses whatsapp-web.js, an open-source WhatsApp Web client. It isn't affiliated with WhatsApp, so it spaces out every message and keeps volume human."],
];

/* ---------------- Page ---------------- */

export function Landing() {
  const { busy, run } = useSignIn();
  const { scrollYProgress } = useScroll();
  const glowY = useTransform(scrollYProgress, [0, 1], ["0%", "40%"]);
  const ctas = (center = false) => (
    <div className={cx("flex flex-wrap gap-3", center && "justify-center")}>
      <Button size="lg" icon={IconSofa} onClick={() => run("demo")} loading={busy === "demo"}>
        Try the live demo
      </Button>
      <Button size="lg" variant="outlined" onClick={() => run("google")} loading={busy === "google"} className={cx(center && "border-current text-on-primary-container")}>
        <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
          <path fill="currentColor" d="M21.35 11.1H12v2.98h5.35c-.23 1.4-1.66 4.1-5.35 4.1-3.22 0-5.85-2.67-5.85-5.96S8.78 6.26 12 6.26c1.83 0 3.06.78 3.76 1.45l2.56-2.47C16.68 3.7 14.55 2.75 12 2.75 6.9 2.75 2.75 6.9 2.75 12S6.9 21.25 12 21.25c6.92 0 9.2-4.86 9.2-7.36 0-.5-.05-.88-.12-1.27z" />
        </svg>
        Sign in with Google
      </Button>
    </div>
  );

  return (
    <div className="relative min-h-dvh overflow-x-clip bg-surface">
      {/* Spotlight glow */}
      <motion.div aria-hidden style={{ y: glowY }} className="pointer-events-none absolute -top-40 left-1/2 h-[720px] w-[1100px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--md-sys-color-primary)_22%,transparent),transparent)] blur-2xl" />

      <header className="relative z-10 mx-auto flex max-w-6xl items-center gap-3 px-5 py-5 sm:px-8">
        <Logo className="size-10" />
        <span className="flex flex-col leading-tight">
          <span className="type-title-m">Spot Solutions</span>
          <span className="type-label-s text-on-surface-variant">by Amrit Dash</span>
        </span>
        <div className="flex-1" />
        <a href="#how" className="hidden type-label-l text-on-surface-variant hover:text-on-surface sm:inline">How it works</a>
        <a href="#open" className="hidden px-3 type-label-l text-on-surface-variant hover:text-on-surface sm:inline">Why open</a>
        <a href="https://github.com/amrit-contour/spot-solutions" target="_blank" rel="noreferrer" className="hidden type-label-l text-on-surface-variant hover:text-on-surface sm:inline">GitHub</a>
        <Button size="sm" variant="tonal" onClick={() => run("google")} loading={busy === "google"} className="ml-2">
          Sign in
        </Button>
      </header>

      {/* Hero */}
      <section className="relative z-10 mx-auto grid max-w-6xl items-center gap-12 px-5 pt-8 pb-20 sm:px-8 lg:grid-cols-[1fr_1.1fr] lg:pt-14">
        <div>
          <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE }} className="inline-flex items-center gap-2 rounded-full bg-surface-container px-3 py-1.5 type-label-l text-primary">
            <IconMic className="icon size-4" /> For open-mic curators who'd rather be writing
          </motion.p>
          <h1 className="mt-6 type-display-m text-balance">
            {"Your lineup, sorted while you sleep.".split(" ").map((w, i) => (
              <motion.span key={i} className="inline-block" initial={{ opacity: 0, y: 18, filter: "blur(6px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} transition={{ duration: 0.55, delay: 0.08 + i * 0.06, ease: EASE }}>
                {w}&nbsp;
              </motion.span>
            ))}
          </h1>
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.55, duration: 0.6 }} className="mt-5 max-w-lg type-body-l text-on-surface-variant">
            Comics ask for spots in your WhatsApp DMs, however they like. A Gemma model running on your own laptop picks out the real requests. You drag names into shows, hit send, and the confirmations, regrets and show groups take care of themselves.
          </motion.p>
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.7, duration: 0.5, ease: EASE }} className="mt-8">
            {ctas()}
            <p className="mt-4 type-body-s text-on-surface-variant">The demo is your own sandbox of a curator's week. No sign-up, nothing to install.</p>
          </motion.div>
        </div>
        <motion.div initial={{ opacity: 0, y: 30, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ delay: 0.3, duration: 0.8, ease: EASE }}>
          <HeroLoop />
        </motion.div>
      </section>

      {/* Problem / payoff */}
      <section className="relative z-10 border-y border-outline-variant/50 bg-surface-low">
        <div className="mx-auto grid max-w-6xl gap-10 px-5 py-20 sm:px-8 lg:grid-cols-[1.1fr_1fr]">
          <SectionHead kicker="The chore" title="Every week, the same three hours.">
            Comics DM over the weekend. You scroll back through chats, check who performed last week, decide whether last week's cancelled mic repeats, weigh day preferences, message everyone, then add and remove people from show groups by hand. Spot Solutions came out of doing exactly that for a Bangalore club's Monday and Tuesday mics.
          </SectionHead>
          <div className="grid grid-cols-2 gap-3 self-center">
            {[
              { n: 3, s: " hrs", l: "a week, curating by hand", tone: "bg-surface-container" },
              { n: 15, s: " min", l: "a week, with Spot Solutions", tone: "bg-primary-container text-on-primary-container" },
              { n: 0, s: "", l: "messages sent without your OK", tone: "bg-surface-container" },
              { n: 0, s: " ₹", l: "to run, on an old laptop", tone: "bg-surface-container" },
            ].map((c, i) => (
              <Reveal key={c.l} delay={i * 0.08} className={cx("rounded-xl p-5", c.tone)}>
                <div className="type-display-s">
                  <Counter to={c.n} suffix={c.s} />
                </div>
                <div className="mt-1 type-body-m opacity-80">{c.l}</div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="relative z-10 mx-auto max-w-6xl scroll-mt-10 px-5 py-24 sm:px-8">
        <SectionHead kicker="How it works" title="Three steps, two of them yours." />
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {[
            { icon: IconPhone, t: "Comics just DM you", b: "Nothing changes for them. Every burst of messages is read together, so “hey” … “monday?” … “got a new 5” counts as one request." },
            { icon: IconCpu, t: "Gemma triages on your laptop", b: "Spot request, cancellation, “am I up?”, or noise. It drafts replies and holds anything that breaks your rules." },
            { icon: IconMic, t: "You drag, then send", b: "Place comics on the board and confirm. Confirmations, regrets to everyone else, and show groups follow." },
          ].map((s, i) => (
            <Reveal key={s.t} delay={i * 0.12} className="relative rounded-xl bg-surface-low p-6">
              <span className="absolute top-5 right-6 type-display-s text-outline-variant">{i + 1}</span>
              <span className="grid size-12 place-items-center rounded-lg bg-primary-container text-on-primary-container">
                <s.icon className="icon size-6" />
              </span>
              <h3 className="mt-5 type-title-l">{s.t}</h3>
              <p className="mt-2 type-body-m text-on-surface-variant">{s.b}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* Features bento */}
      <section className="relative z-10 mx-auto max-w-6xl px-5 pb-24 sm:px-8">
        <SectionHead kicker="Built from seven months of doing it by hand" title="Everything a curator actually does.">
          The first version ran a real club for seven months on Google Sheets and Twilio: 2,200+ requests, 150+ comics. Every rule it learned is in here.
        </SectionHead>
        <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <Reveal key={f.title} delay={(i % 3) * 0.08}>
              <motion.div whileHover={{ y: -4 }} transition={{ type: "spring", duration: 0.4, bounce: 0.3 }} className="h-full rounded-xl bg-surface-low p-6 ring-1 ring-outline-variant/40">
                <f.icon className="icon size-7 text-primary" />
                <h3 className="mt-4 type-title-m">{f.title}</h3>
                <p className="mt-2 type-body-m text-on-surface-variant">{f.body}</p>
              </motion.div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* Why open */}
      <section id="open" className="relative z-10 scroll-mt-10 bg-inverse-surface text-inverse-on-surface">
        <div className="mx-auto grid max-w-6xl gap-12 px-5 py-24 sm:px-8 lg:grid-cols-2">
          <Reveal>
            <p className="type-label-l text-inverse-primary">Why open-weight</p>
            <h2 className="mt-2 type-display-s text-balance">Comics' DMs are private. So the model lives with you.</h2>
            <p className="mt-4 type-body-l opacity-80">
              A cloud API would mean sending every message from every comic to someone else's server, paying per message, and hoping the price holds. Gemma runs on the laptop that's already on your desk, costs nothing, and can be swapped for a bigger model the day you want one.
            </p>
          </Reveal>
          <div className="grid gap-3 self-center sm:grid-cols-2">
            {[
              ["Private", "Chats never leave your machine. Non-requests are never stored."],
              ["Free", "No per-message bill. Your old laptop is the GPU."],
              ["Swappable", "Gemma 3 1B to 12B, or Gemini when you want it. Primary and fallback."],
              ["Yours", "MIT licensed. Run your own server, for your own scene."],
            ].map(([t, b], i) => (
              <Reveal key={t} delay={i * 0.08} className="rounded-xl bg-white/5 p-5 ring-1 ring-white/10">
                <div className="type-title-m">{t}</div>
                <div className="mt-1 type-body-m opacity-75">{b}</div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Server */}
      <section className="relative z-10 mx-auto max-w-6xl px-5 py-24 sm:px-8">
        <div className="grid items-center gap-10 lg:grid-cols-[1fr_1fr]">
          <SectionHead kicker="Your server" title="Any old laptop becomes the brain.">
            One installer for Ubuntu (even from a USB stick), Windows or Mac. It stays awake with the lid closed, restarts itself, backs up WhatsApp logins and catches up after downtime. Manage it from your phone, anywhere.
          </SectionHead>
          <Reveal className="grid grid-cols-3 gap-3">
            {[
              ["Ubuntu", "curl … | sudo bash"],
              ["Windows", "Double-click install"],
              ["macOS", "Spot Server app"],
            ].map(([os, how]) => (
              <div key={os} className="rounded-xl bg-surface-low p-5 text-center ring-1 ring-outline-variant/40">
                <IconServer className="icon mx-auto size-8 text-primary" />
                <div className="mt-3 type-title-m">{os}</div>
                <div className="mt-1 type-body-s text-on-surface-variant">{how}</div>
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      {/* FAQ */}
      <section className="relative z-10 mx-auto max-w-3xl px-5 pb-24 sm:px-8">
        <SectionHead kicker="Questions" title="Fair questions." />
        <div className="mt-8 divide-y divide-outline-variant/60 rounded-xl bg-surface-low">
          {FAQ.map(([q, a]) => (
            <details key={q} className="group px-5 py-4">
              <summary className="flex cursor-pointer list-none items-center gap-3 type-title-m [&::-webkit-details-marker]:hidden">
                <span className="flex-1">{q}</span>
                <span className="grid size-7 place-items-center rounded-full bg-surface-high transition-transform duration-200 group-open:rotate-45">+</span>
              </summary>
              <p className="mt-3 type-body-m text-on-surface-variant">{a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* Final CTA */}
      <section className="relative z-10 mx-auto max-w-6xl px-5 pb-24 sm:px-8">
        <Reveal className="relative overflow-hidden rounded-[32px] bg-primary-container px-6 py-16 text-center text-on-primary-container sm:px-12">
          <Logo className="mx-auto size-14" />
          <h2 className="mx-auto mt-6 max-w-2xl type-display-s text-balance">Spend Monday on your set, not your spreadsheet.</h2>
          <div className="mt-8">{ctas(true)}</div>
        </Reveal>
      </section>

      <footer className="relative z-10 border-t border-outline-variant/50">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-5 py-8 type-body-s text-on-surface-variant sm:px-8">
          <span>Spot Solutions by Amrit Dash · open source (MIT) · built for Hacktoberfest 2026 with Gemma</span>
          <div className="flex-1" />
          <a className="hover:text-on-surface" href="/privacy">Privacy</a>
          <a className="hover:text-on-surface" href="/terms">Terms</a>
          <a className="hover:text-on-surface" href="https://github.com/amrit-contour/spot-solutions" target="_blank" rel="noreferrer">GitHub</a>
        </div>
      </footer>
    </div>
  );
}
