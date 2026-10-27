import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { useApp } from "../lib/app";
import { runCommand } from "../lib/data";
import { Button, ConfirmDialog, cx } from "@spot/ui";
import { deriveLink, netNotice, phoneNotice, restartLabel, unreachableNotice } from "@spot/shared";
import { IconLogout, IconPhone, IconQr, IconWarn } from "@spot/ui";
import { LinkStatusPill, cardView, phoneLabel } from "./LinkStatusPill";
import { LinkCardHeader, MenuItem, OverflowMenu } from "./LinkCardHeader";

const QR_SIZE = 216;

export function ConnectCard({ compact }: { compact?: boolean }) {
  const { uid, session, workerOnline, server } = useApp();
  const serverRestarting = server.restarting;
  const [busy, setBusy] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
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
  // Throws so the ConfirmDialog shows the error; it closes itself on success.
  const logout = async () => {
    setBusy(true);
    try {
      await runCommand(uid, "logout", {}, 60_000);
      toast("WhatsApp unlinked");
    } finally {
      setBusy(false);
    }
  };

  const stuck = status === "ready" && Boolean(session?.health && session.health !== "ok");
  // Same derivation as every page: a silent server is never "connected" (restarting is amber, offline red), and a phone that can't tell says so.
  const view = cardView(deriveLink(session, server), busy);

  const showQr = view === "qr" && Boolean(session?.qr);
  const unlinkShown = view === "ready" || ((view === "offline" || view === "restarting" || view === "unknown") && status === "ready");
  const pillLabel = view === "ready" ? (stuck ? "Not responding" : "Connected") : view === "restarting" ? (serverRestarting?.reason === "update" ? "Updating server…" : "Restarting server…") : view === "offline" ? "Server offline" : view === "unknown" ? phoneLabel(server.phone) : view === "starting" ? "Starting WhatsApp…" : view === "qr" ? "Waiting for scan" : "Not linked";

  return (
    <section id="whatsapp" className={cx("overflow-hidden rounded-xl bg-surface-low", compact ? "p-5 sm:p-8" : "p-4 sm:p-6")}>
      <div className={cx("grid items-center gap-6", showQr && "md:grid-cols-[1fr_auto] md:gap-8")}>
        <div>
          <LinkCardHeader
            icon={compact ? undefined : IconPhone}
            title={view === "ready" || (view === "unknown" && status === "ready") ? "WhatsApp is linked" : "Link your WhatsApp"}
            pill={<LinkStatusPill view={view} label={pillLabel} warn={stuck} />}
            actions={
              unlinkShown && (
                <>
                  <Button variant="outlined" size="sm" icon={IconLogout} onClick={() => setConfirmUnlink(true)} loading={busy} disabled={view !== "ready"} className="max-sm:hidden">
                    Unlink
                  </Button>
                  <OverflowMenu label="More actions">
                    {(close) => (
                      <MenuItem disabled={view !== "ready" || busy} onClick={() => { close(); setConfirmUnlink(true); }}>
                        Unlink
                      </MenuItem>
                    )}
                  </OverflowMenu>
                </>
              )
            }
          />
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
              {view === "restarting" && (
                <p className="mt-2 type-body-l text-on-surface-variant">
                  {restartLabel(serverRestarting?.reason)}. WhatsApp reconnects by itself, there's nothing to do. {status === "ready" ? `It stays linked${session?.phone ? ` as +${session.phone}` : ""}.` : ""}
                </p>
              )}
              {view === "offline" && (
                <p className="mt-2 type-body-l text-on-surface-variant">
                  {unreachableNotice(server)}. Make sure the laptop running it is on and connected to the internet; this card updates by itself once it's back.
                  {netNotice(session?.net, Date.now()) ? ` ${netNotice(session?.net, Date.now())} earlier.` : ""}
                </p>
              )}
              {view === "unknown" && <p className="mt-2 type-body-l text-on-surface-variant">{phoneNotice(server)}. Nothing is wrong with your server that we can see from here.</p>}
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
          {unlinkShown && view !== "ready" && (
            <p className="mt-3 type-body-s text-on-surface-variant">
              {view === "restarting" ? "Unlink is off while the server restarts. It comes back by itself in a minute or two." : view === "unknown" ? "Unlink is off until your phone is back online." : "Unlink is off while the server is offline, so a missed connection can't sign you out."}
            </p>
          )}
          {view === "idle" && (
            <div className="mt-6 flex flex-wrap gap-2">
              <Button icon={IconQr} onClick={connect} loading={busy}>
                Show QR code
              </Button>
            </div>
          )}
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
      <ConfirmDialog open={confirmUnlink} onClose={() => setConfirmUnlink(false)} title="Unlink this WhatsApp?" confirmLabel="Unlink" onConfirm={logout} disabled={!workerOnline}>
        <p>This signs this WhatsApp out of Nothing BOT. You'll have to scan a QR code again to link it.</p>
      </ConfirmDialog>
    </section>
  );
}
