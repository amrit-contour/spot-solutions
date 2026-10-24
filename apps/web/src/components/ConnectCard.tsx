import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { useApp } from "../lib/app";
import { runCommand } from "../lib/data";
import { Button, cx } from "./ui";
import { IconCheck, IconLogout, IconPhone, IconQr, IconServer, IconWarn } from "./icons";

const QR_SIZE = 216;

export function ConnectCard({ compact }: { compact?: boolean }) {
  const { uid, session, workerOnline } = useApp();
  const [busy, setBusy] = useState(false);
  const status = session?.status ?? "idle";

  const connect = async () => {
    setBusy(true);
    try {
      await runCommand(uid, "connect", {}, 60_000);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    setBusy(true);
    try {
      await runCommand(uid, "logout", {}, 60_000);
      toast("WhatsApp unlinked");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const view = !workerOnline && status !== "ready" ? "offline" : status === "ready" ? "ready" : status === "qr" ? "qr" : status === "starting" || status === "authenticated" || busy ? "starting" : "idle";

  return (
    <section id="whatsapp" className={cx("overflow-hidden rounded-xl bg-surface-low", compact ? "p-5 sm:p-8" : "p-4 sm:p-6")}>
      <div className="grid items-center gap-6 md:grid-cols-[1fr_auto] md:gap-8">
        <div>
          <h2 className="type-headline-s">{view === "ready" ? "WhatsApp is linked" : "Link your WhatsApp"}</h2>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={view} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              {view === "ready" && (
                <p className="mt-2 type-body-l text-on-surface-variant">
                  Listening as <span className="text-on-surface tabular">+{session?.phone}</span>
                  {session?.pushName ? ` (${session.pushName})` : ""}. New DMs are checked for spot requests as they arrive.
                </p>
              )}
              {view === "offline" && (
                <p className="mt-2 type-body-l text-on-surface-variant">
                  Your Spot Solutions server isn't reachable. Start the worker on your laptop (<code className="rounded-xs bg-surface-high px-1.5 py-0.5 font-mono text-[0.85em]">pnpm dev:worker</code> or <code className="rounded-xs bg-surface-high px-1.5 py-0.5 font-mono text-[0.85em]">docker compose up -d</code>), then come back.
                </p>
              )}
              {(view === "idle" || view === "starting" || view === "qr") && (
                <p className="mt-3 rounded-md bg-surface-container px-3 py-2 type-body-s text-on-surface-variant md:hidden">
                  Linking needs a second screen. Open spot-solutions.web.app on a laptop and scan the code there with this phone.
                </p>
              )}
              {(view === "idle" || view === "starting" || view === "qr") && (
                <ol className="mt-4 flex flex-col gap-3 type-body-l text-on-surface-variant">
                  {["Open WhatsApp on your phone", "Tap Settings → Linked devices → Link a device", "Point your phone at the code"].map((t, i) => (
                    <li key={t} className="flex items-center gap-3">
                      <span className={cx("grid size-7 flex-none place-items-center rounded-full type-label-m tabular", view === "qr" && i === 2 ? "bg-primary text-on-primary" : "bg-surface-high text-on-surface")}>{i + 1}</span>
                      {t}
                    </li>
                  ))}
                </ol>
              )}
            </motion.div>
          </AnimatePresence>
          <div className="mt-6 flex flex-wrap gap-2">
            {view === "ready" ? (
              <Button variant="outlined" icon={IconLogout} onClick={logout} loading={busy}>
                Unlink
              </Button>
            ) : view === "idle" ? (
              <Button icon={IconQr} onClick={connect} loading={busy}>
                Show QR code
              </Button>
            ) : null}
          </div>
          <p className="mt-5 flex items-start gap-2 type-body-s text-on-surface-variant">
            <IconWarn className="icon mt-px size-4 flex-none" />
            Uses WhatsApp Web through whatsapp-web.js, an unofficial client. Keep message volume human: Spot Solutions spaces out every send.
          </p>
        </div>

        <div
          className={cx(
            "relative order-first mx-auto grid w-full place-items-center rounded-xl-plus bg-surface-lowest md:order-none md:w-[256px]",
            view === "qr" ? "aspect-square max-w-[256px]" : "h-36 md:h-[256px]",
          )}
        >
          <AnimatePresence mode="wait">
            {view === "qr" && session?.qr ? (
              <motion.div key={session.qr} className="relative" style={{ ["--qr" as string]: `${QR_SIZE}px` }} initial={{ opacity: 0, filter: "blur(6px)" }} animate={{ opacity: 1, filter: "blur(0px)" }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
                <QRCodeSVG value={session.qr} size={QR_SIZE} bgColor="transparent" fgColor="var(--md-sys-color-on-surface)" level="M" />
                <span className="scanline pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded-full bg-primary/70 shadow-[0_0_12px_var(--md-sys-color-primary)]" />
              </motion.div>
            ) : (
              <motion.div key={view} initial={{ opacity: 0, transform: "scale(0.94)" }} animate={{ opacity: 1, transform: "scale(1)" }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }} className="flex flex-col items-center gap-3 text-center">
                <span className={cx("relative grid size-14 place-items-center rounded-full md:size-20", view === "ready" ? "bg-secondary-container text-on-secondary-container" : view === "offline" ? "bg-error-container text-on-error-container" : "bg-surface-high text-primary")}>
                  {view === "starting" && <span className="pulse-ring absolute inset-0 rounded-full bg-primary/30" />}
                  {view === "ready" ? <IconCheck className="icon size-7 md:size-10" /> : view === "offline" ? <IconServer className="icon size-7 md:size-10" /> : <IconPhone className="icon size-7 md:size-10" />}
                </span>
                <span className="type-label-l text-on-surface-variant">{view === "ready" ? "Connected" : view === "offline" ? "Server offline" : view === "starting" ? "Starting WhatsApp…" : "Not linked"}</span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}
