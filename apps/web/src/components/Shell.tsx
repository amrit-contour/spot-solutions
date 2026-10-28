import { clock, deriveLink, phoneHeadline, restartLabel } from "@spot/shared";
import { type ReactNode } from "react";
import { signInWithPopup } from "firebase/auth";
import { toast } from "sonner";
import { AppShell, IconCalendar, IconCalendarMark, IconChat, IconComics, IconInbox, IconMic, IconSettings, type NavEntry } from "@spot/ui";
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

/** "+91 ••••• 16962": enough to recognise the number, never the whole thing. */
function maskPhone(p?: string | null) {
  const d = (p ?? "").replace(/\D/g, "");
  return d.length >= 8 ? `+${d.slice(0, d.length - 10 > 0 ? d.length - 10 : 2)} ••••• ${d.slice(-5)}` : "";
}

export function useConnection(): { tone: "ok" | "wait" | "error" | "idle"; label: string; detail?: string; short: string; syncing?: boolean } {
  const { session, server } = useApp();
  // Cold open or resume, no live snapshot yet: the tone stays the last known one, the ring shows the sync.
  return { ...connectionNow(session, server), syncing: server.checking };
}

function connectionNow(session: ReturnType<typeof useApp>["session"], server: ReturnType<typeof useApp>["server"]): { tone: "ok" | "wait" | "error" | "idle"; label: string; detail?: string; short: string } {
  if (isDemoUser()) return { tone: "wait" as const, label: "Demo mode", detail: "your own sandbox", short: "Demo" };
  // Same derivation as every other page (shared deriveServer/deriveLink). A phone that can't tell is neutral, never "Server offline".
  const link = deriveLink(session, server);
  if (link === "unknown") return { tone: "idle" as const, label: phoneHeadline(server), detail: `last known status${server.asOf ? `, as of ${clock(server.asOf)}` : ""}`, short: server.phone === "offline" ? "Offline" : server.checking ? "Checking" : "Syncing" };
  if (link === "restarting") return { tone: "wait" as const, label: restartLabel(server.restarting?.reason), detail: "WhatsApp reconnects by itself", short: "Updating" };
  if (link === "offline") return { tone: "error" as const, label: "Server offline", detail: server.lastSeen ? `not reachable since ${clock(server.lastSeen)}` : undefined, short: "Offline" };
  if (link === "unresponsive") return { tone: "wait" as const, label: "WhatsApp not responding", detail: "the server is restarting it", short: "Stuck" };
  if (link === "connected") return { tone: "ok" as const, label: "WhatsApp connected", detail: maskPhone(session?.phone), short: "Live" };
  if (link === "qr" || link === "starting") return { tone: "wait" as const, label: "Linking WhatsApp…", short: "Linking" };
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
      accountMenu={(align) => <AccountMenu align={align} status={{ tone: conn.tone, label: conn.label, detail: conn.detail, to: "/settings#whatsapp", linkLabel: "Settings", ...{ syncing: conn.syncing } }} />}
      // No status tile in the desktop rail: the coloured ring on the account avatar already shows it.
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
