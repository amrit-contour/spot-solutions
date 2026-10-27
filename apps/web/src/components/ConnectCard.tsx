import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { useApp } from "../lib/app";
import { runCommand } from "../lib/data";
import { Button, cx } from "@spot/ui";
import { IconLogout, IconPhone, IconQr, IconWarn } from "@spot/ui";
import { LinkStatusPill, type LinkView } from "./LinkStatusPill";

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

  const stuck = status === "ready" && Boolean(session?.health && session.health !== "ok");
  const view: LinkView = !workerOnline && status !== "ready" ? "offline" : status === "ready" ? "ready" : status === "qr" ? "qr" : status === "starting" || status === "authenticated" || busy ? "starting" : "idle";

  const showQr = view === "qr" && Boolean(session?.qr);
  const pillLabel = view === "ready" ? (stuck ? "Not responding" : "Connected") : view === "offline" ? "Server offline" : view === "starting" ? "Starting WhatsApp…" : view === "qr" ? "Waiting for scan" : "Not linked";

  return (
    <section id="whatsapp" className={cx("overflow-hidden rounded-xl bg-surface-low", compact ? "p-5 sm:p-8" : "p-4 sm:p-6")}>
      <div className={cx("grid items-center gap-6", showQr && "md:grid-cols-[1fr_auto] md:gap-8")}>
        <div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {!compact && (
              <span className="grid size-10 flex-none place-items-center rounded-md bg-secondary-container text-on-secondary-container">
                <IconPhone className="icon size-5" />
              </span>
            )}
            <h2 className="type-headline-s">{view === "ready" ? "WhatsApp is linked" : "Link your WhatsApp"}</h2>
            <LinkStatusPill view={view} label={pillLabel} warn={stuck} />
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={view} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              {view === "ready" && stuck && (
                <p className="mt-2 type-body-l text-error">
                  WhatsApp stopped responding on your server. {session?.error ?? "It is restarting it."} This card updates by itself once it answers again.
                </p>
              )}
              {view === "ready" && !stuck && (
                <p className="mt-2 type-body-l text-on-surface-variant">
                  Listening as <span className="text-on-surface tabular">+{session?.phone}</span>
                  {session?.pushName ? ` (${session.pushName})` : ""}. New DMs are checked for spot requests as they arrive.
                </p>
              )}
              {view === "offline" && (
                <p className="mt-2 type-body-l text-on-surface-variant">
                  Your Nothing BOT Server isn't reachable. Make sure the laptop running it is on and connected to the internet; this card updates by itself once it's back.
                </p>
              )}
              {(view === "idle" || view === "starting" || view === "qr") && (
                <p className="mt-3 rounded-md bg-surface-container px-3 py-2 type-body-s text-on-surface-variant md:hidden">
                  Linking needs a second screen. Open nothingbotcurate.web.app on a laptop and scan the code there with this phone.
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
            Uses WhatsApp Web through whatsapp-web.js, an unofficial client. Keep message volume human: Nothing BOT Curate spaces out every send.
          </p>
        </div>

        {showQr && (
          <div className="relative order-first mx-auto grid aspect-square w-full max-w-[256px] place-items-center rounded-xl-plus bg-surface-lowest md:order-none md:w-[256px]">
            <AnimatePresence mode="wait">
              <motion.div key={session!.qr} className="relative" style={{ ["--qr" as string]: `${QR_SIZE}px` }} initial={{ opacity: 0, filter: "blur(6px)" }} animate={{ opacity: 1, filter: "blur(0px)" }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
                <QRCodeSVG value={session!.qr!} size={QR_SIZE} bgColor="transparent" fgColor="var(--md-sys-color-on-surface)" level="M" />
                <span className="scanline pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded-full bg-primary/70 shadow-[0_0_12px_var(--md-sys-color-primary)]" />
              </motion.div>
            </AnimatePresence>
          </div>
        )}
      </div>
    </section>
  );
}
