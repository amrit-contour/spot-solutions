// Settings → WhatsApp & app: the agent number. A second WhatsApp, linked by QR like the first, that talks only to you:
// it tells you things, answers questions and does things you ask (after your yes). See docs/agent.md.
import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { DEFAULT_SETTINGS, type AgentSettings, type SessionState } from "@spot/shared";
import { useApp } from "../lib/app";
import { runCommand, useDocument } from "../lib/data";
import { isDemoUser } from "../lib/demo";
import { Button, Info, SettingRow, Switch, TimePicker, cx } from "./ui";
import { IconChatCheck, IconCheck, IconLogout, IconPhone, IconQr, IconSend, IconServer, IconShield } from "./icons";

const QR_SIZE = 216;
const DEFAULTS = DEFAULT_SETTINGS.agent as AgentSettings;

export function AgentCard() {
  const { uid, session, workerOnline, settings, saveSettings } = useApp();
  const agent = useDocument<SessionState>(["users", uid, "session", "agent"]).data;
  const [busy, setBusy] = useState<"link" | "unlink" | "test" | null>(null);
  const demo = isDemoUser();
  const A: AgentSettings = { ...DEFAULTS, ...settings.agent };
  const set = (patch: Partial<AgentSettings>) => saveSettings({ agent: { ...A, ...patch } });

  const mainReady = session?.status === "ready";
  const status = agent?.status ?? "idle";
  const view = !workerOnline && status !== "ready" ? "offline" : status === "ready" ? "ready" : status === "qr" ? "qr" : status === "starting" || status === "authenticated" || busy === "link" ? "starting" : "idle";

  const run = async (kind: "link" | "unlink" | "test", type: "connect_agent" | "logout_agent" | "test_agent", done?: string) => {
    setBusy(kind);
    try {
      await runCommand(uid, type, {}, 60_000);
      if (done) toast(done);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section id="agent" className="overflow-hidden rounded-xl bg-surface-low p-4 sm:p-6">
      <div className="grid items-center gap-6 md:grid-cols-[1fr_auto] md:gap-8">
        <div>
          <div className="flex items-center gap-3">
            <span className="grid size-10 flex-none place-items-center rounded-md bg-secondary-container text-on-secondary-container">
              <IconChatCheck className="icon size-5" />
            </span>
            <h2 className="type-headline-s">{view === "ready" ? "Agent number is linked" : "Agent number"}</h2>
            <Info label="About the agent number">
              A second WhatsApp number for Spot Solutions to talk to you from. It only ever messages your own number, and only reads messages you send it. It never messages comics, groups or anyone else: anything that goes to comics still goes out from your own WhatsApp, and only after you say yes.
            </Info>
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={view} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              {view === "ready" && (
                <p className="mt-3 type-body-l text-on-surface-variant">
                  Talking to you as <span className="text-on-surface tabular">+{agent?.phone}</span>
                  {agent?.pushName ? ` (${agent.pushName})` : ""}. Save it in your contacts, then message it from <span className="text-on-surface tabular">+{session?.phone}</span>. Try “Monday lineup?”.
                </p>
              )}
              {view === "offline" && <p className="mt-3 type-body-l text-on-surface-variant">Your Spot Solutions server isn't reachable, so the agent is paused. This card updates by itself once it's back.</p>}
              {(view === "idle" || view === "starting" || view === "qr") && (
                <>
                  <p className="mt-3 type-body-l text-on-surface-variant">
                    Get your mic checks, new requests and a morning summary on WhatsApp, ask it "who's waiting?", and tell it "add Rohan to Tuesday". It repeats what it understood and waits for your yes.
                  </p>
                  {!mainReady && !demo && <p className="mt-3 rounded-md bg-surface-container px-3 py-2 type-body-s text-on-surface-variant">Link your own WhatsApp above first: the agent talks to that number.</p>}
                  {view !== "idle" && (
                    <ol className="mt-4 flex flex-col gap-3 type-body-l text-on-surface-variant">
                      {["On the phone with the agent's number, open WhatsApp", "Tap Settings → Linked devices → Link a device", "Point it at the code"].map((t, i) => (
                        <li key={t} className="flex items-center gap-3">
                          <span className={cx("grid size-7 flex-none place-items-center rounded-full type-label-m tabular", view === "qr" && i === 2 ? "bg-primary text-on-primary" : "bg-surface-high text-on-surface")}>{i + 1}</span>
                          {t}
                        </li>
                      ))}
                    </ol>
                  )}
                  <p className="mt-3 rounded-md bg-surface-container px-3 py-2 type-body-s text-on-surface-variant md:hidden">Linking needs a second screen. Open spot-solutions.web.app on a laptop and scan the code there.</p>
                </>
              )}
            </motion.div>
          </AnimatePresence>

          <div className="mt-5 flex flex-wrap gap-2">
            {view === "ready" ? (
              <>
                <Button variant="tonal" icon={IconSend} onClick={() => run("test", "test_agent", "Hello sent. Check your WhatsApp.")} loading={busy === "test"}>
                  Send me a hello
                </Button>
                <Button variant="outlined" icon={IconLogout} onClick={() => run("unlink", "logout_agent", "Agent number unlinked")} loading={busy === "unlink"}>
                  Unlink
                </Button>
              </>
            ) : view === "idle" ? (
              <Button icon={IconQr} onClick={() => run("link", "connect_agent")} loading={busy === "link"} disabled={demo || !mainReady || !workerOnline}>
                Link agent number
              </Button>
            ) : null}
          </div>
          {demo && <p className="mt-3 type-body-s text-on-surface-variant">The agent needs a linked WhatsApp, so it's off in the demo.</p>}

        </div>

        <div className={cx("relative order-first mx-auto grid w-full place-items-center rounded-xl-plus bg-surface-lowest md:order-none md:w-[256px]", view === "qr" ? "aspect-square max-w-[256px]" : "h-36 md:h-[256px]")}>
          <AnimatePresence mode="wait">
            {view === "qr" && agent?.qr ? (
              <motion.div key={agent.qr} className="relative" initial={{ opacity: 0, filter: "blur(6px)" }} animate={{ opacity: 1, filter: "blur(0px)" }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
                <QRCodeSVG value={agent.qr} size={QR_SIZE} bgColor="transparent" fgColor="var(--md-sys-color-on-surface)" level="M" />
                <span className="scanline pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded-full bg-primary/70 shadow-[0_0_12px_var(--md-sys-color-primary)]" />
              </motion.div>
            ) : (
              <motion.div key={view} initial={{ opacity: 0, transform: "scale(0.94)" }} animate={{ opacity: 1, transform: "scale(1)" }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }} className="flex flex-col items-center gap-3 text-center">
                <span className={cx("relative grid size-14 place-items-center rounded-full md:size-20", view === "ready" ? "bg-secondary-container text-on-secondary-container" : view === "offline" ? "bg-error-container text-on-error-container" : "bg-surface-high text-primary")}>
                  {view === "starting" && <span className="pulse-ring absolute inset-0 rounded-full bg-primary/30" />}
                  {view === "ready" ? <IconCheck className="icon size-7 md:size-10" /> : view === "offline" ? <IconServer className="icon size-7 md:size-10" /> : <IconPhone className="icon size-7 md:size-10" />}
                </span>
                <span className="type-label-l text-on-surface-variant">{view === "ready" ? "Connected" : view === "offline" ? "Server offline" : view === "starting" ? "Starting the agent…" : "Not linked"}</span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
      {agent?.phone && (
        <div className="mt-6 grid gap-x-8 gap-y-2 rounded-lg bg-surface-container px-4 py-2 md:grid-cols-2">
          <SettingRow label="Agent is on" info="Off: it stays linked but says nothing and ignores your messages.">
            <Switch checked={A.enabled} onChange={(v) => set({ enabled: v })} label="Agent is on" />
          </SettingRow>
          <SettingRow label="Tell me things" info="Mic checks (answer yes or no right there), new spot requests (batched, not one per message), follow-ups to review, offer outcomes and server warnings. Push notifications on your devices keep working as before.">
            <Switch checked={A.notify} onChange={(v) => set({ notify: v })} label="Tell me things" disabled={!A.enabled} />
          </SettingRow>
          <SettingRow label="Answer my questions" info="“Monday lineup?”, “who's waiting?”, “what's left to confirm?”, “who asked for Tuesday?”, “when did Rohan last perform?”. Answers come from your live data.">
            <Switch checked={A.answer} onChange={(v) => set({ answer: v })} label="Answer my questions" disabled={!A.enabled} />
          </SettingRow>
          <SettingRow label="Do things I ask" info="Add or remove someone, confirm a show, mark it happened, change a start time. It repeats what it understood and only acts after you reply yes within 10 minutes. It never messages comics itself.">
            <Switch checked={A.actions} onChange={(v) => set({ actions: v })} label="Do things I ask" disabled={!A.enabled} />
          </SettingRow>
          <SettingRow label="Morning summary" info="Today's show and who's on, who's waiting, what needs you, tomorrow's show. Skipped when there's nothing to say.">
            <Switch checked={A.digest} onChange={(v) => set({ digest: v })} label="Morning summary" disabled={!A.enabled} />
          </SettingRow>
          {A.digest && A.enabled && (
            <SettingRow label="Send at" info={`In your timezone (${settings.timezone}).`}>
              <TimePicker value={A.digestTime} onChange={(v) => set({ digestTime: v })} className="h-10" wrapperClassName="w-36" label="Send at" />
            </SettingRow>
          )}
          <SettingRow label="Reply to strangers" info="If someone else messages the agent number: off means silence (nothing they send is read or kept); on means one polite line, once, telling them to message you directly.">
            <Switch checked={A.politeNote} onChange={(v) => set({ politeNote: v })} label="Reply to strangers" disabled={!A.enabled} />
          </SettingRow>
        </div>
      )}
      <p className="mt-5 flex items-start gap-2 type-body-s text-on-surface-variant">
        <IconShield className="icon mt-px size-4 flex-none" />
        Obeys only messages from your own number, in a one-to-one chat. Groups and everyone else are ignored.
      </p>
    </section>
  );
}
