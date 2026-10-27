// Compact connection status for the WhatsApp and Agent cards. Replaces the big empty hero box: the status is one small pill
// beside the heading; the large box now only exists while there is a QR code to show.
import type { LinkView as SharedLinkView } from "@spot/shared";
import { cx } from "@spot/ui";
import { IconCheck, IconPhone, IconRefresh, IconServer, IconWarn } from "@spot/ui";

export type LinkView = "offline" | "restarting" | "ready" | "qr" | "starting" | "idle" | "unknown";

export function LinkStatusPill({ view, label, warn }: { view: LinkView; label: string; warn?: boolean }) {
  const Ico = warn ? IconWarn : view === "ready" ? IconCheck : view === "offline" ? IconServer : view === "restarting" || view === "unknown" ? IconRefresh : IconPhone;
  const tone = warn || view === "offline" ? "bg-error-container text-on-error-container" : view === "restarting" ? "bg-tertiary-container text-on-tertiary-container" : view === "ready" ? "bg-secondary-container text-on-secondary-container" : view === "idle" || view === "unknown" ? "border border-outline-variant text-on-surface-variant" : "bg-surface-high text-primary";
  return (
    <span className={cx("relative inline-flex h-7 max-w-full min-w-0 flex-none items-center gap-1.5 rounded-full px-2.5 type-label-m", tone)}>
      {(view === "starting" || view === "restarting") && <span className="pulse-ring absolute inset-0 rounded-full bg-primary/20" />}
      <Ico className="icon relative size-4 flex-none" />
      <span className="relative truncate">{label}</span>
    </span>
  );
}

/** The card's view from the shared derivation (deriveLink): one rule for "is the server alive" everywhere. `busy` shows "starting" while a link command runs. */
export function cardView(link: SharedLinkView, busy: boolean): LinkView {
  switch (link) {
    case "unknown":
    case "offline":
    case "restarting":
    case "qr":
    case "starting":
      return link;
    case "connected":
    case "unresponsive":
      return "ready";
    default:
      return busy ? "starting" : "idle";
  }
}

/** Pill label for the two states that aren't about WhatsApp itself. */
export const phoneLabel = (phone: "ok" | "offline" | "reconnecting") => (phone === "offline" ? "You're offline" : "Reconnecting…");
