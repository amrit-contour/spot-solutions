// Compact connection status for the WhatsApp and Agent cards. Replaces the big empty hero box: the status is one small pill
// beside the heading; the large box now only exists while there is a QR code to show.
import { cx } from "@spot/ui";
import { IconCheck, IconPhone, IconServer, IconWarn } from "@spot/ui";

export type LinkView = "offline" | "ready" | "qr" | "starting" | "idle";

export function LinkStatusPill({ view, label, warn }: { view: LinkView; label: string; warn?: boolean }) {
  const Ico = warn ? IconWarn : view === "ready" ? IconCheck : view === "offline" ? IconServer : IconPhone;
  const tone = warn || view === "offline" ? "bg-error-container text-on-error-container" : view === "ready" ? "bg-secondary-container text-on-secondary-container" : view === "idle" ? "border border-outline-variant text-on-surface-variant" : "bg-surface-high text-primary";
  return (
    <span className={cx("relative inline-flex h-7 max-w-full min-w-0 flex-none items-center gap-1.5 rounded-full px-2.5 type-label-m", tone)}>
      {view === "starting" && <span className="pulse-ring absolute inset-0 rounded-full bg-primary/20" />}
      <Ico className="icon relative size-4 flex-none" />
      <span className="relative truncate">{label}</span>
    </span>
  );
}
