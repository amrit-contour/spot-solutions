import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { maskPhoneTail } from "@spot/shared";
import { Chip, IconArrowRight, IconChatCheck, IconCheck, IconPhone, IconQr, IconServer, IconWarn, Spinner, cx } from "@spot/ui";
import { CURATING_AGENT, CURATING_SERVER, CURATING_WHATSAPP, useConnection, type Connection } from "../lib/connection";
import { useClock } from "../lib/alerts";
import { ago } from "../lib/time";

const CURATING = "Nothing BOT Curating";

function Out({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="state-layer pressable inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 type-label-l text-primary">
      {children}
      <IconArrowRight aria-hidden className="icon size-4" />
    </a>
  );
}

/** Settings: the WhatsApp link, the server and the agent number, shared with Nothing BOT Curating. Read only. */
export function ConnectionCard({ uid }: { uid: string }) {
  const c = useConnection(uid);
  const now = useClock(15_000);
  if (c.loading) {
    return (
      <div className="grid place-items-center rounded-lg bg-surface-low py-8 text-primary">
        <Spinner className="size-6" />
      </div>
    );
  }
  const bad = !c.serverUp;
  const ok = c.whatsapp === "connected" && !bad;
  const seen = c.lastSeen ? ago(c.lastSeen, now) : null;
  const title = ok ? "WhatsApp is connected" : bad ? "Server offline" : c.whatsapp === "qr" ? "WhatsApp needs a scan" : c.whatsapp === "starting" ? "Starting WhatsApp…" : "WhatsApp isn't linked";
  const detail = ok
    ? `Listening as ${maskPhoneTail(c.phone)}${c.pushName ? ` (${c.pushName})` : ""}.`
    : bad
      ? `${c.phone ? `Linked as ${maskPhoneTail(c.phone)}, but your` : "Your"} server isn't reachable. Check that the machine running it is on and online. This updates by itself once it's back.`
      : c.whatsapp === "qr"
        ? `Open ${CURATING} on a laptop and scan the code with your phone.`
        : c.whatsapp === "starting"
          ? "Hang on, it will be ready in a moment."
          : `Link your WhatsApp in ${CURATING}. Once, for both apps.`;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="min-w-0 rounded-lg bg-surface-low p-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className={cx("grid size-10 flex-none place-items-center rounded-md", ok ? "bg-secondary-container text-on-secondary-container" : bad ? "bg-error-container text-on-error-container" : "bg-surface-high text-primary")}>
            {ok ? <IconCheck aria-hidden className="icon size-5" /> : bad ? <IconServer aria-hidden className="icon size-5" /> : c.whatsapp === "qr" ? <IconQr aria-hidden className="icon size-5" /> : <IconPhone aria-hidden className="icon size-5" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="type-title-m">{title}</h3>
              <Chip tone={ok ? "success" : bad ? "error" : "neutral"} className="flex-none">{ok ? "Connected" : bad ? "Offline" : c.whatsapp === "qr" ? "Needs QR" : c.whatsapp === "starting" ? "Starting" : "Not linked"}</Chip>
            </div>
            <p className="mt-1 break-words type-body-m text-on-surface-variant">{detail}</p>
            {c.serverName && (
              <p className="mt-1 flex min-w-0 items-start gap-2 type-body-s text-on-surface-variant">
                <IconServer aria-hidden className="icon mt-0.5 size-4 flex-none" />
                <span className="min-w-0 break-words">
                  Server <span className="text-on-surface">{c.serverName}</span>
                  {seen ? ` · ${c.serverUp ? "seen" : "offline since"} ${seen}` : ""}
                </span>
              </p>
            )}
          </div>
        </div>
        {!ok && !bad && (
          <div className="mt-2 flex flex-wrap">
            <Out href={CURATING_WHATSAPP}>{c.whatsapp === "qr" ? "Scan in" : "Link in"} {CURATING}</Out>
          </div>
        )}
        {bad && (
          <div className="mt-2 flex flex-wrap">
            <Out href={CURATING_SERVER}>Server page in {CURATING}</Out>
          </div>
        )}
      </div>

      <div className="min-w-0 rounded-lg bg-surface-low p-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className={cx("grid size-10 flex-none place-items-center rounded-md", c.agent === "connected" && !bad ? "bg-secondary-container text-on-secondary-container" : "bg-surface-high text-primary")}>
            <IconChatCheck aria-hidden className="icon size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="type-title-m">Agent number</h3>
              <Chip tone={c.agent === "connected" && !bad ? "success" : "neutral"} className="flex-none">{c.agent === "connected" ? (bad ? "Paused" : "Linked") : c.agent === "offline" ? "Paused" : c.agent === "qr" ? "Needs QR" : "Not linked"}</Chip>
            </div>
            <p className="mt-1 break-words type-body-m text-on-surface-variant">
              {c.agent === "connected" ? `${bad ? "Paused while the server is offline. Linked as" : "Talks to you from"} ${maskPhoneTail(c.agentPhone)}.` : c.agent === "offline" ? "Paused while the server is offline." : "The optional second number that messages you. Set it up in " + CURATING + "."}
            </p>
          </div>
        </div>
        {c.agent !== "connected" && c.agent !== "offline" && (
          <div className="mt-2 flex flex-wrap">
            <Out href={CURATING_AGENT}>Set up in {CURATING}</Out>
          </div>
        )}
      </div>
      <p className="flex items-start gap-2 type-body-s text-on-surface-variant">
        <IconServer aria-hidden className="icon mt-0.5 size-4 flex-none" />
        Your WhatsApp and server are shared with {CURATING}.
      </p>
    </div>
  );
}

/** Today: a single line, shown only when something is wrong. */
export function ConnectionBanner({ uid }: { uid: string }) {
  const c: Connection = useConnection(uid);
  if (!c.problem) return null;
  const text = c.problem === "offline" ? "Server offline. Asks can't be sent until it's back." : c.problem === "qr" ? "WhatsApp needs a QR scan." : "WhatsApp isn't linked.";
  return (
    <Link to="/settings" className="state-layer pressable flex min-w-0 items-center gap-3 rounded-lg bg-error-container p-3 text-on-error-container">
      <IconWarn aria-hidden className="icon size-5 flex-none" />
      <span className="min-w-0 flex-1 type-body-m">{text}</span>
      <span className="flex-none type-label-l">Details</span>
    </Link>
  );
}
