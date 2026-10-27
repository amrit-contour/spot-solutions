// Signed-out front page: what Nothing BOT Comedy is, an animated demo of the flow, and the ways in.
import { motion, MotionConfig, useScroll, useTransform } from "motion/react";
import {
  IconBuilding,
  IconCalendarMark,
  IconChatCheck,
  IconCpu,
  IconGroup,
  IconMic,
  IconPhone,
  IconSend,
  IconServer,
  IconShield,
  IconSparkle,
  IconStar,
} from "@spot/ui";
import { ComicLogo } from "../components/ComicLogo";
import { Ctas, EASE, Reveal, SectionHead, useSignIn } from "../components/landing/bits";
import { HeroDemo } from "../components/landing/HeroDemo";
import { AlertDemo } from "../components/landing/AlertDemo";
import { Button, cx } from "@spot/ui";

const CURATING = "https://nothingbotcurating.web.app";

const FEATURES = [
  { icon: IconBuilding, title: "Every open mic, in one roster", body: "Rooms, shows, who curates which day, and when to ask: the morning of, the day before, “ping Mondays”, or “they'll reach out”. Instagram-only and walk-in rooms are notes, not tasks." },
  { icon: IconSend, title: "Asks that go out on time", body: "Each room has its own ask rule. The message goes from your own WhatsApp, in your words, at the right hour. Review it first or let it fly, per room." },
  { icon: IconChatCheck, title: "Replies, read for you", body: "“Yes bro, 9 pm” becomes Got it. “Thursday's full” becomes Declined. No reply stays No reply, so you know who to chase. Every status quotes the message it came from." },
  { icon: IconCalendarMark, title: "Spots on your calendar", body: "Every booked spot lands in My spots with the room, time and curator. Add notes after: the crowd, a rating, what worked, the set list. Stats by week, month and room." },
  { icon: IconGroup, title: "Instant alerts from groups", body: "Someone posts “spots at 7 and 9 tonight, DM me” in a group. You get a push in seconds with an Ask for it button that DMs the right person. Clashes with a spot you already have are flagged." },
  { icon: IconStar, title: "Rosters your city shares", body: "Follow Bangalore Scene and get its rooms and curators as a starting point. When the roster changes, you see what's new and pick what to take. Nothing overwrites your own notes." },
];

const FAQ = [
  ["Will it message curators without asking me?", "Only the way you set it. Each room is either “review first” (you tap Send) or “send on time”. Replies are never sent for you. Asks go out slowly, one at a time, so it reads like a person."],
  ["Where do my chats go?", "They stay on the laptop running your Nothing BOT Server. A model on that machine reads the replies and group messages. The app in your pocket only gets the results: Got it, Declined, a spot offer. Nothing is stored for chats you didn't watch."],
  ["Do I need my own server?", "Yes, any computer that stays on: an old laptop, a Mac, a Windows PC or Ubuntu. One installer each, and it links your own WhatsApp. If you already run one for Nothing BOT Curating, it's the same server."],
  ["I'm a curator too. Is this the same app?", "No, the sister app. Nothing BOT Curating is for the person receiving the requests. Nothing BOT Comedy is for the person sending them. Same Google account and same server, two apps."],
  ["What does it cost?", "Nothing. The app runs on Firebase's free tier, the model is open-weight and runs on your own computer, and there's no per-message bill."],
  ["Is it official WhatsApp?", "No. It uses whatsapp-web.js, an open-source WhatsApp Web client, and isn't affiliated with WhatsApp. That's why it keeps volume human and spaces messages out."],
  ["What's a community roster?", "A list of a city's rooms, shows and curators that one trusted person keeps up to date. You follow it, import it, and get a heads-up when it changes. It only shows to signed-in users, never on the open web."],
  ["Can I use it on my phone?", "Yes. It installs like an app, on Android, iPhone and desktop, and sends push alerts. Add it to your home screen from your browser's menu."],
];

export function Landing() {
  const { busy, run } = useSignIn();
  const { scrollYProgress } = useScroll();
  const glowY = useTransform(scrollYProgress, [0, 1], ["0%", "40%"]);

  return (
    <MotionConfig reducedMotion="user">
      <div id="top" className="relative min-h-dvh overflow-x-clip bg-surface">
        <motion.div aria-hidden style={{ y: glowY }} className="pointer-events-none absolute -top-40 left-1/2 h-[720px] w-[1100px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_srgb,var(--md-sys-color-primary)_22%,transparent),transparent)] blur-2xl" />

        {/* Stays put while the page scrolls. The top padding is the status bar / notch when installed. */}
        <header className="sticky top-0 z-30 border-b border-outline-variant/40 bg-surface/80 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] backdrop-blur-md">
          <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-5 sm:px-8">
            <a href="#top" aria-label="Nothing BOT Comedy, back to top" className="flex min-w-0 items-center gap-3 rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-primary">
              <ComicLogo className="size-10 flex-none" />
              <span className="truncate type-title-m">Nothing BOT Comedy</span>
            </a>
            <div className="flex-1" />
            <nav aria-label="Page" className="hidden items-center gap-1 md:flex">
              {[
                ["#how", "How it works"],
                ["#alerts", "Alerts"],
                ["#private", "Privacy"],
                ["#faq", "FAQ"],
              ].map(([href, label]) => (
                <a key={href} href={href} className="state-layer rounded-full px-3 py-2 type-label-l text-on-surface-variant">{label}</a>
              ))}
              <a href="https://github.com/amrit-contour/spot-solutions" target="_blank" rel="noreferrer" className="state-layer rounded-full px-3 py-2 type-label-l text-on-surface-variant">GitHub</a>
            </nav>
            <Button size="sm" variant="tonal" onClick={() => void run()} loading={busy}>
              Sign in
            </Button>
          </div>
        </header>

        {/* Hero */}
        <section className="relative z-10 mx-auto grid max-w-6xl items-center gap-12 px-5 pt-10 pb-20 sm:px-8 lg:grid-cols-[1fr_1.1fr] lg:pt-14">
          <div className="min-w-0">
            <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE }} className="inline-flex items-center gap-2 rounded-full bg-surface-container px-3 py-1.5 type-label-l text-primary">
              <IconMic className="icon size-4" /> For comics who'd rather be on stage
            </motion.p>
            <h1 className="mt-6 type-display-m text-balance">
              {"Ask for every open mic. Don't chase any.".split(" ").map((w, i) => (
                <motion.span key={i} className="inline-block" initial={{ opacity: 0, y: 18, filter: "blur(6px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} transition={{ duration: 0.55, delay: 0.08 + i * 0.06, ease: EASE }}>
                  {w}&nbsp;
                </motion.span>
              ))}
            </h1>
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6, duration: 0.6 }} className="mt-5 max-w-lg type-body-l text-on-surface-variant">
              Your rooms in one roster, with who curates what and when to ask. The ask goes out on time from your own WhatsApp, the reply is read for you, and the spot lands on your calendar. When a group posts a spot, your phone buzzes with a button to ask for it.
            </motion.p>
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.75, duration: 0.5, ease: EASE }} className="mt-8">
              <Ctas />
              <p className="mt-4 type-body-s text-on-surface-variant">Free. Uses the same Google account as Nothing BOT Curating, if you have one.</p>
            </motion.div>
          </div>
          <motion.div className="min-w-0" initial={{ opacity: 0, y: 30, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ delay: 0.3, duration: 0.8, ease: EASE }}>
            <HeroDemo />
          </motion.div>
        </section>

        {/* The chore */}
        <section className="relative z-10 border-y border-outline-variant/50 bg-surface-low">
          <div className="mx-auto grid max-w-6xl gap-10 px-5 py-20 sm:px-8 lg:grid-cols-[1.1fr_1fr]">
            <SectionHead kicker="The chore" title="Your open-mic life is a notes app and a lot of scrolling.">
              Which room takes asks on Monday morning, which one wants a DM the day before, who curates Wednesday this month, and did you already do two spots at that place this week. Then a group chat drops a spot at 6 PM and by the time you've scrolled to find the number, it's gone. Nothing BOT Comedy holds all of that so you don't.
            </SectionHead>
            <div className="grid grid-cols-2 gap-3 self-center">
              {[
                { t: "Rooms", l: "with shows, days and curators", tone: "bg-surface-container" },
                { t: "Asks", l: "sent when the room expects them", tone: "bg-primary-container text-on-primary-container" },
                { t: "Alerts", l: "from the groups you pick", tone: "bg-surface-container" },
                { t: "Notes", l: "after every set, ready to reread", tone: "bg-surface-container" },
              ].map((c, i) => (
                <Reveal key={c.t} delay={i * 0.08} className={cx("rounded-xl p-5", c.tone)}>
                  <div className="type-display-s">{c.t}</div>
                  <div className="mt-1 type-body-m opacity-80">{c.l}</div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="relative z-10 mx-auto max-w-6xl scroll-mt-[calc(5rem+env(safe-area-inset-top))] px-5 py-24 sm:px-8">
          <SectionHead kicker="How it works" title="Three steps, and the middle one isn't yours." />
          <div className="mt-12 grid gap-4 md:grid-cols-3">
            {[
              { icon: IconBuilding, t: "Build your roster", b: "Add your rooms, or follow your city's roster and take what you want. Set each room's ask rule once: morning of, day before, a weekday, or they reach out." },
              { icon: IconCpu, t: "Asks go out, replies get read", b: "On the day, the ask goes from your WhatsApp. A model on your laptop reads what comes back and marks it Got it, Declined or No reply." },
              { icon: IconCalendarMark, t: "Show up, then write it down", b: "Spots sit in My spots. After the set, add a few lines: the crowd, what worked, what didn't. Your stats build themselves." },
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

        {/* Features */}
        <section className="relative z-10 mx-auto max-w-6xl px-5 pb-24 sm:px-8">
          <SectionHead kicker="What's inside" title="Everything between “any spot?” and “great set”.">
            Built from a real Bangalore open-mic list: dozens of rooms, a different rule for almost every one.
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

        {/* Alerts */}
        <section id="alerts" className="relative z-10 scroll-mt-[calc(5rem+env(safe-area-inset-top))] bg-inverse-surface text-inverse-on-surface">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-24 sm:px-8 lg:grid-cols-2">
            <Reveal>
              <p className="type-label-l text-inverse-primary">Group alerts</p>
              <h2 className="mt-2 type-display-s text-balance">The spot is posted at 6:10. You ask at 6:11.</h2>
              <p className="mt-4 type-body-l opacity-80">
                Pick the groups to watch. Only those are read. When someone offers a spot, you get a push with Ask for it, and one tap sends the DM to whoever the message says to DM. If it clashes with a spot you already have, it says so. When a group says a mic is full, that room stops showing up in your asks.
              </p>
            </Reveal>
            <Reveal delay={0.1}>
              <AlertDemo />
            </Reveal>
          </div>
        </section>

        {/* Privacy and server */}
        <section id="private" className="relative z-10 mx-auto max-w-6xl scroll-mt-[calc(5rem+env(safe-area-inset-top))] px-5 py-24 sm:px-8">
          <div className="grid items-center gap-10 lg:grid-cols-2">
            <SectionHead kicker="Privacy" title="Your chats stay on your laptop.">
              A small model runs on a computer you own, reads the replies and the groups you pick, and sends only the result to your phone. No per-message bill and nobody else's server reading your DMs. It's the same server Nothing BOT Curating uses, so if you curate too, there's nothing more to set up.
            </SectionHead>
            <Reveal className="grid gap-3 sm:grid-cols-2">
              {[
                { icon: IconShield, t: "Private", b: "Chats never leave your machine. Groups you don't pick are never read." },
                { icon: IconPhone, t: "Your number", b: "Asks come from your own WhatsApp, in your voice, not a bot account." },
                { icon: IconServer, t: "Any old laptop", b: "One installer for Mac, Windows or Ubuntu. It restarts itself and catches up after downtime." },
                { icon: IconSparkle, t: "Open source", b: "MIT licensed. Read the code, run your own server, change what you don't like." },
              ].map((c) => (
                <div key={c.t} className="rounded-xl bg-surface-low p-5 ring-1 ring-outline-variant/40">
                  <c.icon className="icon size-7 text-primary" />
                  <div className="mt-3 type-title-m">{c.t}</div>
                  <div className="mt-1 type-body-m text-on-surface-variant">{c.b}</div>
                </div>
              ))}
            </Reveal>
          </div>
          <p className="mt-8 type-body-m text-on-surface-variant">
            Need the server? <a className="text-primary underline underline-offset-4" href={`${CURATING}/install`}>Install Nothing BOT Server</a> in a few minutes.
          </p>
        </section>

        {/* Sister app */}
        <section className="relative z-10 mx-auto max-w-6xl px-5 pb-24 sm:px-8">
          <Reveal className="flex flex-col gap-4 rounded-xl bg-surface-low p-6 ring-1 ring-outline-variant/40 sm:flex-row sm:items-center sm:gap-6 sm:p-8">
            <span className="grid size-12 flex-none place-items-center rounded-lg bg-primary-container text-on-primary-container">
              <IconMic className="icon size-6" />
            </span>
            <div className="flex-1">
              <h3 className="type-title-l">Run a mic too?</h3>
              <p className="mt-1 type-body-m text-on-surface-variant">Nothing BOT Curating is the other side of the table: it reads the spot requests in your DMs and builds your lineup.</p>
            </div>
            <a href={CURATING} className="state-layer pressable inline-flex h-10 items-center justify-center rounded-full bg-secondary-container px-5 type-label-l whitespace-nowrap text-on-secondary-container">
              Nothing BOT Curating
            </a>
          </Reveal>
        </section>

        {/* FAQ */}
        <section id="faq" className="relative z-10 mx-auto max-w-3xl scroll-mt-[calc(5rem+env(safe-area-inset-top))] px-5 pb-24 sm:px-8">
          <SectionHead kicker="Questions" title="Fair questions." />
          <div className="mt-8 divide-y divide-outline-variant/60 rounded-xl bg-surface-low">
            {FAQ.map(([q, a]) => (
              <details key={q} className="group px-5 py-4">
                <summary className="flex cursor-pointer list-none items-center gap-3 type-title-m [&::-webkit-details-marker]:hidden">
                  <span className="flex-1">{q}</span>
                  <span className="grid size-7 flex-none place-items-center rounded-full bg-surface-high transition-transform duration-200 group-open:rotate-45">+</span>
                </summary>
                <p className="mt-3 type-body-m text-on-surface-variant">{a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* Final CTA */}
        <section className="relative z-10 mx-auto max-w-6xl px-5 pb-24 sm:px-8">
          <Reveal className="relative overflow-hidden rounded-[32px] bg-primary-container px-6 py-16 text-center text-on-primary-container sm:px-12">
            <ComicLogo className="mx-auto size-14" />
            <h2 className="mx-auto mt-6 max-w-2xl type-display-s text-balance">Write the set. Let the asking happen.</h2>
            <div className="mt-8">
              <Ctas center onDark />
            </div>
          </Reveal>
        </section>

        <footer className="relative z-10 border-t border-outline-variant/50 pb-[env(safe-area-inset-bottom)]">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-5 py-8 type-body-s text-on-surface-variant sm:px-8">
            <span>Nothing BOT Comedy · Made by Amrit Dash · open source (MIT)</span>
            <div className="flex-1" />
            <a className="hover:text-on-surface" href={CURATING}>Nothing BOT Curating</a>
            <a className="hover:text-on-surface" href="/privacy">Privacy</a>
            <a className="hover:text-on-surface" href="/terms">Terms</a>
            <a className="hover:text-on-surface" href="https://github.com/amrit-contour/spot-solutions" target="_blank" rel="noreferrer">GitHub</a>
          </div>
        </footer>
      </div>
    </MotionConfig>
  );
}
