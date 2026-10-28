import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { maskPhoneTail, phoneHeadline, phoneNotice, restartLabel, unreachableNotice } from "@spot/shared";
import { Chip, IconArrowRight, IconChatCheck, IconCheck, IconPhone, IconQr, IconServer, IconWarn, Spinner, cx } from "@spot/ui";
import { CURATING_AGENT, CURATING_SERVER, CURATING_WHATSAPP, useConnection, type Connection } from "../lib/connection";
import { useClock } from "../lib/alerts";
import { Card } from "./ui";
import { ago } from "../lib/time";

const CURATING = "Nothing BOT Curate";

function Out({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="state-layer pressable -ml-3 inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 type-label-l text-primary">
      {children}
      <IconArrowRight aria-hidden className="icon size-4" />
    </a>
  );
}

/** Settings: the WhatsApp link, the server and the agent number, shared with Nothing BOT Curate. Read only. */
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
  // One derivation for every page (shared deriveServer): unknown = this phone is offline or on cached data, so it never claims the server is down.
  const unknown = c.server.reach === "unknown";
  const wait = Boolean(c.restarting);
  const bad = !c.serverUp && !wait && !unknown;
  const stuck = c.whatsapp === "unresponsive" && !bad && !unknown;
  const ok = c.whatsapp === "connected" && !bad && !wait && !unknown;
  const seen = c.lastSeen ? ago(c.lastSeen, now) : null;
  const title = unknown ? phoneHeadline(c.server) : wait ? (c.restarting?.reason === "update" ? "Updating server…" : "Restarting server…") : ok ? `WhatsApp connected · ${maskPhoneTail(c.phone)}` : stuck ? "WhatsApp stopped responding" : bad ? "Server offline" : c.whatsapp === "qr" ? "WhatsApp needs a scan" : c.whatsapp === "starting" ? "Starting WhatsApp…" : "WhatsApp isn't linked";
  const detail = unknown
    ? `${phoneNotice(c.server)}.`
    : wait
    ? `${restartLabel(c.restarting?.reason)}. ${c.phone ? `Linked as ${maskPhoneTail(c.phone)}. ` : ""}This updates by itself.`
    : ok
    ? ""
    : stuck
      ? `${c.healthNote ?? "The server is restarting WhatsApp."} Asks wait until it answers again.`
      : bad
      ? `${unreachableNotice(c.server)}.${c.netNote ? ` ${c.netNote} earlier.` : ""} ${c.phone ? `Linked as ${maskPhoneTail(c.phone)}. ` : ""}Check that the machine running it is on and online. This updates by itself once it's back.`
      : c.whatsapp === "qr"
        ? `Open ${CURATING} on a laptop and scan the code with your phone.`
        : c.whatsapp === "starting"
          ? "Hang on, it will be ready in a moment."
          : `Link your WhatsApp in ${CURATING}. Once, for both apps.`;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Card>
        <div className="flex min-w-0 items-start gap-3">
          <span className={cx("grid size-10 flex-none place-items-center rounded-md", ok ? "bg-secondary-container text-on-secondary-container" : wait ? "bg-tertiary-container text-on-tertiary-container" : bad || stuck ? "bg-error-container text-on-error-container" : "bg-surface-high text-primary")}>
            {ok ? <IconCheck aria-hidden className="icon size-5" /> : bad || wait ? <IconServer aria-hidden className="icon size-5" /> : c.whatsapp === "qr" ? <IconQr aria-hidden className="icon size-5" /> : <IconPhone aria-hidden className="icon size-5" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="type-title-m">{title}</h3>
              {!ok && <Chip tone={wait ? "tertiary" : bad || stuck ? "error" : "neutral"} className="flex-none">{unknown ? (c.server.checking ? "Checking" : "Last known") : wait ? "Restarting" : stuck ? "Not responding" : bad ? "Offline" : c.whatsapp === "qr" ? "Needs QR" : c.whatsapp === "starting" ? "Starting" : "Not linked"}</Chip>}
            </div>
            {detail && <p className="mt-1 break-words type-body-m text-on-surface-variant">{detail}</p>}
            {c.serverName && (
              <p className="mt-1 flex min-w-0 items-start gap-2 type-body-s text-on-surface-variant">
                <IconServer aria-hidden className="icon mt-0.5 size-4 flex-none" />
                <span className="min-w-0 break-words">
                  Server <span className="text-on-surface">{c.serverName}</span>
                  {seen ? ` · ${unknown ? "last known" : c.serverUp ? "seen" : "offline since"} ${seen}` : ""}
                </span>
              </p>
            )}
          </div>
        </div>
        {!ok && !bad && !stuck && !wait && !unknown && (
          <div className="mt-1 -mb-2 flex flex-wrap">
            <Out href={CURATING_WHATSAPP}>{c.whatsapp === "qr" ? "Scan in" : "Link in"} {CURATING}</Out>
          </div>
        )}
        {bad && (
          <div className="mt-1 -mb-2 flex flex-wrap">
            <Out href={CURATING_SERVER}>Server page in {CURATING}</Out>
          </div>
        )}
      </Card>

      <Card>
        <div className="flex min-w-0 items-start gap-3">
          <span className={cx("grid size-10 flex-none place-items-center rounded-md", c.agent === "connected" && !bad ? "bg-secondary-container text-on-secondary-container" : "bg-surface-high text-primary")}>
            <IconChatCheck aria-hidden className="icon size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="type-title-m">Agent number</h3>
              <Chip tone={c.agent === "connected" && !bad ? "success" : "neutral"} className="flex-none">{c.agent === "unknown" ? "Last known" : c.agent === "restarting" ? "Paused" : c.agent === "connected" ? (bad ? "Paused" : "Linked") : c.agent === "offline" ? "Paused" : c.agent === "qr" ? "Needs QR" : "Not linked"}</Chip>
            </div>
            <p className="mt-1 break-words type-body-m text-on-surface-variant">
              {c.agent === "unknown" ? `${phoneNotice(c.server)}.` : c.agent === "restarting" ? "Paused for a minute while the server restarts. It comes back by itself." : c.agent === "connected" ? `${bad ? "Paused while the server is offline. Linked as" : "Talks to you from"} ${maskPhoneTail(c.agentPhone)}.` : c.agent === "offline" ? "Paused while the server is offline." : "The optional second number that messages you. Set it up in " + CURATING + "."}
            </p>
          </div>
        </div>
        {c.agent !== "connected" && c.agent !== "offline" && c.agent !== "restarting" && c.agent !== "unknown" && (
          <div className="mt-1 -mb-2 flex flex-wrap">
            <Out href={CURATING_AGENT}>Set up in {CURATING}</Out>
          </div>
        )}
      </Card>
      <p className="flex items-start gap-2 px-1 type-body-s text-on-surface-variant">
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
  const text = c.problem === "unknown" ? phoneNotice(c.server) + "." : c.problem === "restarting" ? restartLabel(c.restarting?.reason) + "." : c.problem === "offline" ? `${unreachableNotice(c.server)}. Asks can't be sent until it's back.` : c.problem === "qr" ? "WhatsApp needs a QR scan." : c.problem === "unresponsive" ? "WhatsApp stopped responding; the server is restarting it." : "WhatsApp isn't linked.";
  return (
    <Link to="/settings" className={cx("state-layer pressable flex min-w-0 items-center gap-3 rounded-lg p-3", c.problem === "restarting" ? "bg-tertiary-container text-on-tertiary-container" : c.problem === "unknown" ? "bg-surface-high text-on-surface-variant" : "bg-error-container text-on-error-container")}>
      <IconWarn aria-hidden className="icon size-5 flex-none" />
      <span className="min-w-0 flex-1 type-body-m">{text}</span>
      <span className="flex-none type-label-l">Details</span>
    </Link>
  );
}
