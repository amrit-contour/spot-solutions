import { closesLabel, limitsText, opensLabel, type Ask, type PlannedAsk } from "@spot/shared";
import { Bubble, Button, Chip, IconBuilding, IconClock, IconPen, IconPhone, IconSkip, IconSend, IconWarn, IconUserCheck } from "@spot/ui";
import { ago, dateTime } from "../lib/time";
import { TZ } from "../lib/asks";
import { messageFor } from "./askMessage";

const firstName = (n?: string) => (n ?? "").trim().split(/\s+/)[0] ?? "";

/** One ask that is open right now: who, which show, when it closes, the message, and Send or Skip. */
export function AskOpenCard({ a, template, now, busy, onSend, onSkip, onEdit }: { a: PlannedAsk; template: string; now: number; busy: boolean; onSend: () => void; onSkip: () => void; onEdit: () => void }) {
  const left = a.closesAt - now;
  const urgent = left < 3 * 3_600_000;
  const message = messageFor(a, template);
  const waitingForNine = a.mode === "auto" && now < a.sendFrom;
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg bg-surface-low p-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid size-10 flex-none place-items-center rounded-md bg-tertiary-container text-on-tertiary-container">
          <IconBuilding className="icon size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate type-title-m">{a.label}</p>
          <p className="truncate type-body-m text-on-surface-variant">{dateTime(a.showDate, a.time)}</p>
        </div>
        <Chip tone={urgent ? "error" : "neutral"} icon={IconClock} className="flex-none">
          {closesLabel(a.closesAt, now)}
        </Chip>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {a.canSend ? (
          <Chip tone="fact" icon={IconUserCheck}>
            Ask {firstName(a.curatorName)}
          </Chip>
        ) : (
          <Chip tone="error" icon={IconPhone}>
            {a.curatorName ? `${firstName(a.curatorName)} has no number` : "No curator set"}
          </Chip>
        )}
        {a.standIn && <Chip>Stand-in</Chip>}
        <Chip>{a.ruleLabel}</Chip>
        <Chip tone={a.mode === "auto" ? "primary" : "neutral"}>{a.mode === "auto" ? (waitingForNine ? "Sends by itself soon" : "Sends by itself") : "Draft for you"}</Chip>
        {a.blocked && (
          <Chip tone="error" icon={IconWarn}>
            {limitsText(a.hits)}
          </Chip>
        )}
      </div>

      <button onClick={onEdit} className="state-layer pressable group flex min-w-0 flex-col gap-1 rounded-md text-left" aria-label="Edit the message">
        <Bubble outgoing>
          <span className="line-clamp-3">{message}</span>
        </Bubble>
        <span className="ml-auto flex items-center gap-1 type-label-m text-on-surface-variant">
          <IconPen aria-hidden className="icon size-3.5" /> Edit
        </span>
      </button>

      {a.doc?.error && (
        <p role="alert" className="rounded-md bg-error-container px-3 py-2 type-body-s text-on-error-container">
          Last try failed: {a.doc.error}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="text" size="sm" icon={IconSkip} onClick={onSkip} disabled={busy}>
          Skip
        </Button>
        <Button size="sm" icon={IconSend} loading={busy} disabled={!a.canSend} onClick={onSend}>
          {a.blocked ? "Send anyway" : "Send"}
        </Button>
      </div>
    </div>
  );
}

/** A coming-up ask: compact, with when it opens. */
export function AskUpcomingRow({ a, today, onSkip }: { a: PlannedAsk; today: string; onSkip: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg bg-surface-low p-3 pl-4">
      <div className="min-w-0 flex-1">
        <p className="truncate type-title-s">{a.label}</p>
        <p className="truncate type-body-s text-on-surface-variant">
          {dateTime(a.showDate, a.time)} · {a.curatorName ? `ask ${firstName(a.curatorName)}` : "no curator set"}
        </p>
        <p className="truncate type-label-m text-on-surface-variant">
          {opensLabel(a, today, TZ)} · {a.mode === "auto" ? "sends by itself" : "draft for you"}
        </p>
      </div>
      <Button variant="text" size="sm" onClick={onSkip} aria-label={`Skip ${a.label} ${a.showDate}`}>
        Skip
      </Button>
    </div>
  );
}

const STATUS: Record<Ask["status"], { label: string; tone: "reading" | "success" | "error" | "neutral" }> = {
  planned: { label: "Draft", tone: "neutral" },
  sent: { label: "Waiting for a reply", tone: "reading" },
  got_it: { label: "Got it", tone: "success" },
  declined: { label: "Declined", tone: "error" },
  no_reply: { label: "No reply", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
};

/** An ask that has gone out: where it stands, the curator's reply when it was read, and what to do about it. */
export function AskSentCard({ ask, now, onAnswer }: { ask: Ask; now: number; onAnswer: (d: "got_it" | "declined" | "waiting") => void }) {
  const reply = ask.lastReply;
  const unclear = ask.status === "sent" && reply?.decision === "unclear";
  const check = ask.status === "got_it" && reply?.unsure;
  const st = STATUS[ask.status];
  const who = firstName(ask.curatorName) || "the curator";
  return (
    <div className={`flex min-w-0 flex-col gap-3 rounded-lg p-4 ${unclear || check ? "bg-secondary-container text-on-secondary-container" : "bg-surface-low"}`}>
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate type-title-m">{ask.roomName ?? "Room"}</p>
          <p className="truncate type-body-m opacity-80">{dateTime(ask.showDate, ask.time)}</p>
        </div>
        <Chip tone={unclear || check ? "primary" : st.tone} className="flex-none">
          {unclear ? "Needs you" : check ? "Check this" : st.label}
        </Chip>
      </div>
      <p className="type-body-s opacity-80">
        You asked {who}
        {ask.sentAt ? ` · ${ago(ask.sentAt, now)}` : ""}
      </p>

      {reply && (
        <div className="min-w-0 rounded-md bg-surface/60 px-3 py-2">
          <p className="type-label-m opacity-80">
            {who} replied · {ago(reply.at, now)}
          </p>
          <p className="mt-0.5 type-body-m break-words">“{reply.text}”</p>
        </div>
      )}

      {unclear && (
        <>
          <p className="type-body-m">Not sure what {who} meant. What do you think?</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="text" onClick={() => onAnswer("waiting")}>
              Keep waiting
            </Button>
            <Button size="sm" variant="outlined" onClick={() => onAnswer("declined")}>
              It's a no
            </Button>
            <Button size="sm" onClick={() => onAnswer("got_it")}>
              It's a yes
            </Button>
          </div>
        </>
      )}
      {check && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 flex-1 type-body-m">Counted as a yes and added to My spots.</p>
          <Button size="sm" variant="outlined" onClick={() => onAnswer("waiting")}>
            That wasn't a yes
          </Button>
        </div>
      )}
      {ask.status === "sent" && !unclear && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto type-label-m opacity-70">Heard some other way?</span>
          <Button size="sm" variant="text" onClick={() => onAnswer("declined")}>
            They said no
          </Button>
          <Button size="sm" variant="tonal" onClick={() => onAnswer("got_it")}>
            They said yes
          </Button>
        </div>
      )}
    </div>
  );
}
