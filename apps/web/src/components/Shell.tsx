import { type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { signInWithPopup } from "firebase/auth";
import { toast } from "sonner";
import { AppShell, StatusDot, IconCalendar, IconCalendarMark, IconChat, IconComics, IconInbox, IconMic, IconPhone, IconSettings, type NavEntry } from "@spot/ui";
import { CuratingLogo } from "./CuratingLogo";
import { auth, google } from "@spot/ui/firebase";
import { useApp } from "../lib/app";
import { isDemoUser } from "../lib/demo";
import { UpdatesProvider, useUpdates } from "../lib/updates";
import { Count } from "./updates/shared";
import { AccountMenu } from "./AccountMenu";

// The curator app's shell: the shared @spot/ui frame plus this app's nav, connection status and demo banner.
const NAV: NavEntry[] = [
  { to: "/", label: "Calendar", short: "Home", icon: IconCalendarMark },
  { to: "/requests", label: "Requests", icon: IconInbox },
  { to: "/messages", label: "Messages", short: "Chats", icon: IconChat },
  { to: "/lineup", label: "Lineup", icon: IconMic },
  { to: "/comics", label: "Comics", icon: IconComics },
  { to: "/shows", label: "Shows", icon: IconCalendar },
  // Settings lives in the account menu (top right) on phones, so the bar keeps six roomy items.
  { to: "/settings", label: "Settings", icon: IconSettings, phoneHidden: true },
];

export function useConnection() {
  const { session, workerOnline } = useApp();
  if (isDemoUser()) return { tone: "wait" as const, label: "Demo mode · your own sandbox", short: "Demo" };
  if (!workerOnline) return { tone: "error" as const, label: "Server offline", short: "Offline" };
  if (session?.status === "ready") return { tone: "ok" as const, label: `WhatsApp · +${session.phone ?? ""}`, short: "Live" };
  if (session?.status === "qr" || session?.status === "starting" || session?.status === "authenticated") return { tone: "wait" as const, label: "Linking WhatsApp…", short: "Linking" };
  return { tone: "idle" as const, label: "WhatsApp not linked", short: "Unlinked" };
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <UpdatesProvider>
      <ShellFrame>{children}</ShellFrame>
    </UpdatesProvider>
  );
}

function ShellFrame({ children }: { children: ReactNode }) {
  const conn = useConnection();
  const { needsYou } = useUpdates();
  const nav = NAV.map((n) => (n.to === "/requests" && needsYou > 0 ? { ...n, badge: <Count value={needsYou} />, badgeLabel: "updates need you" } : n));
  return (
    <AppShell
      nav={nav}
      appName="Nothing BOT Curate"
      logo={<CuratingLogo className="size-11" />}
      accountMenu={(align) => <AccountMenu align={align} />}
      phoneStatus={
        <NavLink to="/settings#whatsapp" className="state-layer inline-flex min-w-0 items-center gap-2 rounded-full px-2 py-1 type-label-m text-on-surface-variant">
          <StatusDot tone={conn.tone} /> <span className="truncate">{conn.label}</span>
        </NavLink>
      }
      railFooter={
        <NavLink to="/settings#whatsapp" title={conn.label} className="state-layer flex flex-col items-center gap-1.5 rounded-lg px-2 py-2 text-on-surface-variant">
          <span className="relative">
            <IconPhone className="icon size-6" />
            <span className="absolute -right-1 -bottom-0.5">
              <StatusDot tone={conn.tone} />
            </span>
          </span>
          <span className="type-label-s">{conn.short}</span>
        </NavLink>
      }
      banner={isDemoUser() ? <DemoBanner /> : undefined}
    >
      {children}
    </AppShell>
  );
}

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
