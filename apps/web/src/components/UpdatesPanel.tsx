// Everything that needs a different action than a spot request, in four sections.
// Desktop: a sticky right-hand column. Phones and tablets: the "Updates" view of the Requests page.
import { useCallback, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Lineup } from "@spot/shared";
import { useApp } from "../lib/app";
import { dismissNotices, useUpdates } from "../lib/updates";
import { Button, cx, type Icon } from "./ui";
import { IconArrowDown, IconChat, IconChatCheck, IconCheck, IconMic, IconServer, IconUserCheck, IconUserPlus } from "./icons";
import { Count } from "./updates/shared";
import { ReplyCard } from "./updates/ReplyCard";
import { FollowUpCard } from "./updates/FollowUpCard";
import { IntroCard, OnboardCard } from "./updates/FaceCard";
import { MicCard } from "./updates/MicCard";
import { ServerCard } from "./updates/ServerCard";

export function UpdatesPanel({ lineups }: { lineups: Lineup[] }) {
  const { uid, shows } = useApp();
  const u = useUpdates();
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const lastIndex = useRef(0);
  const faces = u.onboarding.length + u.introductions.length;

  const cards = () => Array.from(root.current?.querySelectorAll<HTMLElement>("[data-update-card]") ?? []);

  // Remember which card the curator was working in, so focus can move on when it leaves.
  const track = (e: React.FocusEvent) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-update-card]");
    if (card) lastIndex.current = cards().indexOf(card);
  };

  // After a card has animated out its focused button is gone: land on the next card's main action, or the heading.
  const restoreFocus = useCallback(() => {
    const a = document.activeElement;
    if (a && a !== document.body) return; // focus is still somewhere sensible
    const list = cards();
    const next = list[Math.min(lastIndex.current, list.length - 1)];
    const target = next?.querySelector<HTMLElement>("[data-primary]") ?? next?.querySelector<HTMLElement>("button, a, textarea");
    (target ?? heading.current)?.focus({ preventScroll: false });
  }, []);

  return (
    <div ref={root} onFocusCapture={track} className="pb-2">
      <div className="mb-1 hidden items-center gap-2 pt-1 pb-2 lg:flex">
        <h2 ref={heading} tabIndex={-1} className="type-title-l outline-none">
          Updates
        </h2>
        <Count value={u.total} className={cx("rounded-full px-2 type-label-m", u.total ? "bg-primary text-on-primary" : "bg-surface-high text-on-surface-variant")} />
      </div>

      <AnimatePresence initial={false} onExitComplete={restoreFocus}>
        {u.replies.length > 0 && (
          <Section key="reply" icon={IconChat} title="Needs a reply" count={u.replies.length} onExitComplete={restoreFocus}>
            {u.replies.map((a) => (
              <ReplyCard key={a.id} a={a} lineups={lineups} />
            ))}
          </Section>
        )}
        {u.followUps.length > 0 && (
          <Section key="follow" icon={IconUserCheck} title="You already replied" count={u.followUps.length} onExitComplete={restoreFocus}>
            {u.followUps.map((a) => (
              <FollowUpCard key={a.id} a={a} />
            ))}
          </Section>
        )}
        {faces > 0 && (
          <Section key="faces" icon={IconUserPlus} title="New faces" count={faces} onExitComplete={restoreFocus}>
            {u.onboarding.map((a) => (
              <OnboardCard key={a.id} a={a} />
            ))}
            {u.introductions.map((i) => (
              <IntroCard key={i.notice.id} intro={i} />
            ))}
          </Section>
        )}
        {u.micChecks.length > 0 && (
          <Section key="mic" icon={IconMic} title="Did the mic happen?" count={u.micChecks.length} onExitComplete={restoreFocus}>
            {u.micChecks.map((l) => {
              const show = shows.find((s) => s.id === l.showId);
              return show ? <MicCard key={l.id} lineup={l} show={show} /> : null;
            })}
          </Section>
        )}
        {u.server.length > 0 && (
          <Section
            key="server"
            icon={IconServer}
            title="From your server"
            count={u.server.length}
            onExitComplete={restoreFocus}
            action={
              u.server.length > 1 && (
                <Button size="sm" variant="text" onClick={() => dismissNotices(uid, u.server)}>
                  Dismiss all
                </Button>
              )
            }
          >
            {u.server.map((n) => (
              <ServerCard key={n.id} n={n} />
            ))}
          </Section>
        )}
      </AnimatePresence>

      {!u.loading && u.total === 0 && <CaughtUp />}
    </div>
  );
}

function Section({ icon: I, title, count, action, children, onExitComplete }: { icon: Icon; title: string; count: number; action?: ReactNode; children: ReactNode; onExitComplete: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <motion.section
      layout="position"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
      className="mb-4"
      aria-label={title}
    >
      {/* Sticky inside the column; the solid background keeps cards from showing through. */}
      <div className="sticky top-0 z-10 -mx-1 flex items-center gap-1 bg-surface px-1 py-1.5">
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="state-layer flex min-w-0 flex-1 items-center gap-2 rounded-full py-1.5 pr-2 pl-2 text-left">
          <I className="icon size-5 flex-none text-primary" />
          <h3 className="min-w-0 truncate type-title-s">{title}</h3>
          <Count value={count} className="rounded-full bg-surface-high px-1.5 type-label-s text-on-surface-variant" />
          <IconArrowDown className={cx("icon ml-auto size-5 flex-none text-on-surface-variant transition-transform duration-200", !open && "-rotate-90")} />
        </button>
        {action}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }}
            className="-mx-1 overflow-hidden px-1"
          >
            <ul className="pt-1">
              <AnimatePresence initial={false} onExitComplete={onExitComplete}>
                {children}
              </AnimatePresence>
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}

function CaughtUp() {
  return (
    <motion.div initial={{ opacity: 0, transform: "translateY(8px)" }} animate={{ opacity: 1, transform: "translateY(0px)" }} transition={{ duration: 0.35, ease: [0.23, 1, 0.32, 1] }} className="flex flex-col items-center px-6 py-14 text-center">
      <div className="relative mb-6 grid size-24 place-items-center">
        <span className="absolute inset-0 rounded-full bg-surface-high" />
        <span className="relative grid size-16 place-items-center rounded-full bg-primary-container text-on-primary-container">
          <IconCheck className="icon size-9" />
        </span>
        <span className="absolute -top-1 -left-1 grid size-9 place-items-center rounded-full bg-secondary-container text-on-secondary-container">
          <IconChatCheck className="icon size-5" />
        </span>
        <span className="absolute -right-1 top-3 grid size-8 place-items-center rounded-full bg-tertiary-container text-on-tertiary-container">
          <IconUserCheck className="icon size-4" />
        </span>
        <span className="absolute -bottom-1 left-2 grid size-8 place-items-center rounded-full bg-surface-highest text-on-surface-variant">
          <IconMic className="icon size-4" />
        </span>
      </div>
      <h3 className="type-title-l">You're all caught up</h3>
      <p className="mt-2 max-w-64 type-body-m text-on-surface-variant">Replies, new faces and server notices show up here when they need you.</p>
    </motion.div>
  );
}
