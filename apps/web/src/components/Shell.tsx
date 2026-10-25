import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { useApp } from "../lib/app";
import { cx, type Icon } from "./ui";
import { IconCalendar, IconComics, IconInbox, IconMic, IconPhone, IconSettings } from "./icons";
import { Logo } from "./Logo";
import { isDemoUser } from "../lib/demo";
import { signInWithPopup, signOut } from "firebase/auth";
import { auth, google } from "../lib/firebase";
import { AccountMenu } from "./AccountMenu";

const NAV: { to: string; label: string; icon: Icon }[] = [
  { to: "/", label: "Requests", icon: IconInbox },
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
  const c = { ok: "bg-[#3fb950]", wait: "bg-primary", error: "bg-error", idle: "bg-outline" }[tone];
  return (
    <span className="relative inline-flex size-2.5">
      {tone !== "idle" && tone !== "error" && <span className={cx("pulse-ring absolute inset-0 rounded-full", c)} />}
      <span className={cx("relative size-2.5 rounded-full", c)} />
    </span>
  );
}

function NavItem({ to, label, icon: I, rail }: { to: string; label: string; icon: Icon; rail?: boolean }) {
  return (
    <NavLink to={to} end={to === "/"} className="group flex flex-1 flex-col items-center gap-1 outline-none sm:flex-none">
      {({ isActive }) => (
        <>
          <span className={cx("state-layer relative grid h-8 w-14 place-items-center rounded-full transition-colors duration-200", isActive ? "text-on-secondary-container" : "text-on-surface-variant", rail && "h-8")}>
            {isActive && <motion.span layoutId={rail ? "nav-rail" : "nav-bar"} className="absolute inset-0 rounded-full bg-secondary-container" transition={{ type: "spring", duration: 0.45, bounce: 0.2 }} />}
            <I className="icon relative size-6" />
          </span>
          <span className={cx("type-label-m transition-colors", isActive ? "text-on-surface" : "text-on-surface-variant")}>{label}</span>
        </>
      )}
    </NavLink>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const conn = useConnection();
  return (
    <div className="flex min-h-dvh bg-surface">
      {/* Rail ≥ 600px */}
      <nav aria-label="Main" className="sticky top-0 hidden h-dvh w-24 flex-none flex-col items-center gap-3 bg-surface py-5 sm:flex">
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

      <main className="min-w-0 flex-1 pb-24 sm:pb-0">
        {isDemoUser() && <DemoBanner />}
        {/* CSS keyframes, not AnimatePresence: they always run to the end, so a route can never get stuck invisible. */}
        <div key={loc.pathname} className="page-enter">
          {children}
        </div>
      </main>

      {/* Bottom bar < 600px */}
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 flex h-20 items-center bg-surface-container px-2 pb-[env(safe-area-inset-bottom)] sm:hidden">
        {NAV.map((n) => (
          <NavItem key={n.to} {...n} />
        ))}
      </nav>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  const conn = useConnection();
  return (
    <header className="px-4 pt-3 pb-4 sm:px-8 sm:pt-10">
      {/* Phones: status + account on top. Desktop keeps both in the nav rail. */}
      <div className="mb-3 flex items-center gap-3 sm:hidden">
        <NavLink to="/settings#whatsapp" className="state-layer mr-auto inline-flex min-w-0 items-center gap-2 rounded-full px-2 py-1 type-label-m text-on-surface-variant">
          <StatusDot tone={conn.tone} /> <span className="truncate">{conn.label}</span>
        </NavLink>
        <AccountMenu />
      </div>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <h1 className="type-headline-m text-balance sm:type-display-s">{title}</h1>
          {subtitle && <p className="mt-1.5 type-body-l text-on-surface-variant">{subtitle}</p>}
        </div>
        {actions && <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">{actions}</div>}
      </div>
      {children}
    </header>
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
        onClick={async () => {
          await signOut(auth);
          await signInWithPopup(auth, google);
        }}
        className="state-layer rounded-full bg-on-tertiary-container px-4 py-1.5 type-label-l text-tertiary-container"
      >
        Use my own account
      </button>
    </div>
  );
}
