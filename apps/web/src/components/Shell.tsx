import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { useApp } from "../lib/app";
import { cx, type Icon } from "./ui";
import { IconCalendar, IconCalendarMark, IconChat, IconComics, IconInbox, IconMic, IconPhone, IconSettings } from "./icons";
import { Logo } from "./Logo";
import { isDemoUser } from "../lib/demo";
import { signInWithPopup } from "firebase/auth";
import { toast } from "sonner";
import { auth, google } from "../lib/firebase";
import { AccountMenu } from "./AccountMenu";
import { UpdatesProvider, useUpdates } from "../lib/updates";
import { Count } from "./updates/shared";

const NAV: { to: string; label: string; short?: string; icon: Icon }[] = [
  { to: "/", label: "Calendar", short: "Home", icon: IconCalendarMark },
  { to: "/requests", label: "Requests", icon: IconInbox },
  { to: "/messages", label: "Messages", short: "Chats", icon: IconChat },
  { to: "/lineup", label: "Lineup", icon: IconMic },
  { to: "/comics", label: "Comics", icon: IconComics },
  { to: "/shows", label: "Shows", icon: IconCalendar },
  { to: "/settings", label: "Settings", icon: IconSettings },
];

export function useConnection() {
  const { session, workerOnline } = useApp();
  if (isDemoUser()) return { tone: "wait" as const, label: "Demo mode · your own sandbox", short: "Demo" };
  if (!workerOnline) return { tone: "error" as const, label: "Server offline", short: "Offline" };
  if (session?.status === "ready") return { tone: "ok" as const, label: `WhatsApp · +${session.phone ?? ""}`, short: "Live" };
  if (session?.status === "qr" || session?.status === "starting" || session?.status === "authenticated") return { tone: "wait" as const, label: "Linking WhatsApp…", short: "Linking" };
  return { tone: "idle" as const, label: "WhatsApp not linked", short: "Unlinked" };
}

function StatusDot({ tone }: { tone: "ok" | "wait" | "error" | "idle" }) {
  const c = { ok: "bg-ok", wait: "bg-primary", error: "bg-error", idle: "bg-outline" }[tone];
  return (
    <span className="relative inline-flex size-2.5">
      {tone !== "idle" && tone !== "error" && <span className={cx("pulse-ring absolute inset-0 rounded-full", c)} />}
      <span className={cx("relative size-2.5 rounded-full", c)} />
    </span>
  );
}

function NavItem({ to, label, short, icon: I, rail }: { to: string; label: string; short?: string; icon: Icon; rail?: boolean }) {
  const { needsYou } = useUpdates();
  const badge = to === "/requests" ? needsYou : 0;
  return (
    <NavLink to={to} end={to === "/"} className="group flex min-w-0 flex-1 flex-col items-center gap-1 outline-none sm:flex-none">
      {({ isActive }) => (
        <>
          <span className={cx("state-layer relative grid h-8 w-12 place-items-center sm:w-14 rounded-full transition-colors duration-200", isActive ? "text-on-nav-active" : "text-on-surface-variant", rail && "h-8")}>
            {isActive && <motion.span layoutId={rail ? "nav-rail" : "nav-bar"} className="absolute inset-0 rounded-full bg-nav-active" transition={{ type: "spring", duration: 0.45, bounce: 0.2 }} />}
            <I className="icon relative size-6" />
            {badge > 0 && (
              <span className="absolute top-0 right-2.5 grid min-w-4 place-items-center rounded-full bg-error px-1 type-label-s leading-4 text-on-error ring-2 ring-surface sm:right-2.5">
                <Count value={badge} />
                <span className="sr-only"> updates need you</span>
              </span>
            )}
          </span>
          <span className={cx("type-label-m max-sm:text-[11px]! max-sm:tracking-normal! transition-colors", isActive ? "text-on-surface" : "text-on-surface-variant")}>{short && !rail ? short : label}</span>
        </>
      )}
    </NavLink>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <UpdatesProvider>
      <ShellFrame>{children}</ShellFrame>
    </UpdatesProvider>
  );
}

function ShellFrame({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const conn = useConnection();
  return (
    <div className="flex min-h-dvh bg-surface">
      {/* Installed app: the status bar / notch area is painted with the page colour, so scrolled content never shows through it. */}
      <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-50 h-[env(safe-area-inset-top)] bg-surface" />
      {/* Rail ≥ 600px */}
      <nav aria-label="Main" className="sticky top-0 hidden h-dvh w-24 flex-none flex-col items-center gap-3 bg-surface pt-[calc(1.25rem+env(safe-area-inset-top))] pb-5 sm:flex">
        <NavLink to="/" aria-label="Spot Solutions home" className="mb-5">
          <Logo className="size-11" />
        </NavLink>
        {NAV.map((n) => (
          <NavItem key={n.to} {...n} rail />
        ))}
        <div className="flex-1" />
        <AccountMenu align="left" />
        <NavLink to="/settings#whatsapp" title={conn.label} className="state-layer flex flex-col items-center gap-1.5 rounded-lg px-2 py-2 text-on-surface-variant">
          <span className="relative">
            <IconPhone className="icon size-6" />
            <span className="absolute -right-1 -bottom-0.5">
              <StatusDot tone={conn.tone} />
            </span>
          </span>
          <span className="type-label-s">{conn.short}</span>
        </NavLink>
      </nav>

      <main className="min-w-0 flex-1 pt-[env(safe-area-inset-top)] pb-[calc(var(--nav-h)+1rem)] sm:pb-0">
        {isDemoUser() && <DemoBanner />}
        {/* CSS keyframes, not AnimatePresence: they always run to the end, so a route can never get stuck invisible. */}
        <div key={loc.pathname} className="page-enter">
          {children}
        </div>
      </main>

      {/* Bottom bar < 600px */}
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 flex h-[var(--nav-h)] items-center bg-surface-container px-1 pb-[var(--nav-pad)] sm:hidden">
        {/* Settings lives in the account menu (top right) on phones, so the bar keeps six roomy items. */}
        {NAV.filter((n) => n.to !== "/settings").map((n) => (
          <NavItem key={n.to} {...n} />
        ))}
      </nav>
    </div>
  );
}

/**
 * Every page's title bar. It stays pinned at the top while the page scrolls, shrinking to a compact bar,
 * and publishes its height as --page-header-h so bars below it (StickyBar, Requests tabs) pin just under it.
 */
/** The header currently publishing --page-header-h (one page at a time). */
let headerOwner: HTMLElement | null = null;

export function PageHeader({ title, subtitle, actions, trailing, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; /** Small control kept on the title's line at every width (e.g. a help link). */ trailing?: ReactNode; children?: ReactNode }) {
  const conn = useConnection();
  const ref = useRef<HTMLElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const publish = () => {
      headerOwner = el;
      root.style.setProperty("--page-header-h", `${el.getBoundingClientRect().height}px`);
    };
    const ro = new ResizeObserver(() => headerOwner === el || !headerOwner?.isConnected ? publish() : undefined);
    publish();
    ro.observe(el);
    // Also after the shrink/grow transition settles, in case the last resize frame was mid-animation.
    el.addEventListener("transitionend", publish);
    return () => {
      ro.disconnect();
      el.removeEventListener("transitionend", publish);
      // Only the header that set the value clears it: a page re-rendering its header must not wipe the new one's.
      if (headerOwner === el) {
        headerOwner = null;
        root.style.removeProperty("--page-header-h");
      }
    };
  }, []);
  // Compact once you've scrolled a bit; expand only back near the top. The gap between the two thresholds stops
  // the loop where shrinking the header scrolls the page back above the line and it grows again (flicker).
  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      const y = window.scrollY;
      setStuck((was) => (was ? y > 4 : y > 56));
    };
    const onScroll = () => (frame ||= requestAnimationFrame(read));
    read();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <>
    <header
      ref={ref}
      data-stuck={stuck || undefined}
      className={cx(
        // Frosted when pinned (90% + blur). One easing for every part.
        "sticky top-[env(safe-area-inset-top)] isolate z-30 border-b border-transparent px-4 transition-[padding,border-color] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none sm:px-8",
        stuck ? "border-outline-variant pt-3 pb-2 sm:pt-3 sm:pb-3" : "pt-4 pb-4 sm:pt-10",
      )}
    >
      {/* The frosted glass is its own layer behind everything in the bar (and runs up under the notch strip), so the
          avatar, status and title always sit on top of it at full strength. */}
      <div aria-hidden className={cx("pointer-events-none absolute inset-x-0 bottom-0 -top-[env(safe-area-inset-top)] -z-10 transition-colors duration-300 motion-reduce:transition-none", stuck ? "bg-surface/90 backdrop-blur-md" : "bg-surface")} />
      {/* Phones: status + account on top. Desktop keeps both in the nav rail. */}
      <div className="mb-3 flex items-center gap-3 sm:hidden">
        <NavLink to="/settings#whatsapp" className="state-layer mr-auto inline-flex min-w-0 items-center gap-2 rounded-full px-2 py-1 type-label-m text-on-surface-variant">
          <StatusDot tone={conn.tone} /> <span className="truncate">{conn.label}</span>
        </NavLink>
        <AccountMenu />
      </div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
          {/* The size animates (font-size/line-height) instead of jumping between two classes. */}
          <h1 className={cx("min-w-0 flex-1 truncate transition-[font-size,line-height,letter-spacing] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none", stuck ? "type-title-l" : "type-headline-m sm:type-display-s")}>{title}</h1>
          {trailing && <div className="flex flex-none items-center">{trailing}</div>}
          {/* Page actions live on the title's line at every width; the title truncates to make room. */}
          {actions && <div className="flex flex-none items-center gap-1.5 sm:gap-2">{actions}</div>}
          </div>
          {subtitle && (
            // Collapses smoothly (grid rows 1fr -> 0fr) rather than popping out of the layout.
            <div className={cx("grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none", stuck ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100")} aria-hidden={stuck || undefined}>
              <div className="overflow-hidden">
                <p className="pt-1.5 type-body-l text-on-surface-variant">{subtitle}</p>
              </div>
            </div>
          )}
        </div>
      </div>
      {children}
    </header>
    </>
  );
}

export { StatusDot };

function DemoBanner() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 bg-tertiary-container px-4 py-2.5 text-on-tertiary-container sm:px-8">
      <span className="type-label-l">Demo</span>
      <span className="min-w-0 flex-1 basis-56 type-body-s">
        <span className="sm:hidden">Your own copy of a curator's week. Changes stay here.</span>
        <span className="hidden sm:inline">You're in your own copy of a demo curator's week. Drag comics, edit messages, explore everything. Changes stay in your sandbox, and WhatsApp features need a real account.</span>
      </span>
      <button
        // Open the popup straight from the click (Safari blocks it after an await). Signing in as the real
        // account replaces the anonymous one; the sandbox is simply left behind.
        onClick={() => void signInWithPopup(auth, google).catch((e: { code?: string }) => {
          if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") toast.error("Couldn't sign in. Allow popups and try again.");
        })}
        className="state-layer rounded-full bg-on-tertiary-container px-4 py-1.5 type-label-l text-tertiary-container"
      >
        Use my own account
      </button>
    </div>
  );
}
