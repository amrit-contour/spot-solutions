import { alertDayLabel, alertState, formatTime, givenName, timeLeft, timesShort, type SpotAlert } from "@spot/shared";
import { Button, Chip, IconBuilding, IconCheck, IconClock, IconClose, IconGroup, IconSend, IconUserCheck, IconWarn } from "@spot/ui";
import { ago } from "../lib/time";

/** One offer read from a group: where, when, who to DM, how long is left, and Ask for it. */
export function AlertCard({
  alert: a,
  now,
  today,
  clash,
  highlight,
  compact,
  onAsk,
  onDismiss,
  onGotIt,
}: {
  alert: SpotAlert;
  now: number;
  today: string;
  /** The booked spot this clashes with, in words (also read from the alert itself). */
  clash?: { with: string } | null;
  highlight?: boolean;
  compact?: boolean;
  onAsk: () => void;
  onDismiss: () => void;
  onGotIt?: () => void;
}) {
  const state = alertState(a, now);
  const live = state === "open" || state === "asked";
  const clashWith = clash?.with ?? a.clash?.with;
  const when = [alertDayLabel(a.date, today), a.times.length ? timesShort(a.times) : "time not said"].join(" · ");
  const urgent = live && a.expiresAt - now < 30 * 60_000;
  return (
    <div id={`alert-${a.id}`} className={`flex min-w-0 flex-col gap-3 rounded-lg bg-surface-low p-4 ${live ? "" : "opacity-70"} ${highlight ? "ring-2 ring-primary" : ""}`}>
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid size-10 flex-none place-items-center rounded-md bg-tertiary-container text-on-tertiary-container">
          <IconBuilding className="icon size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate type-title-m">{a.roomName ?? "A room (not named)"}</p>
          <p className="truncate type-body-m text-on-surface-variant">{when}</p>
        </div>
        {state === "open" && (
          <Chip tone={urgent ? "error" : "neutral"} icon={IconClock} className="flex-none">
            {timeLeft(a.expiresAt, now)}
          </Chip>
        )}
        {state === "asked" && (
          <Chip tone="primary" icon={IconSend} className="flex-none">
            Asked
          </Chip>
        )}
        {state === "closed" && <Chip tone="error" className="flex-none">Closed</Chip>}
        {state === "expired" && <Chip className="flex-none">Ended</Chip>}
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Chip tone="fact" icon={IconUserCheck}>
          DM {givenName(a.contact.name) || "them"}
          {a.contact.kind === "mentioned" ? " (tagged)" : ""}
        </Chip>
        {a.reachBy && <Chip tone={urgent ? "error" : "neutral"} icon={IconClock}>Reach by {formatTime(a.reachBy)}</Chip>}
        {a.busking && <Chip tone="tertiary">Busking</Chip>}
        {a.long && <Chip tone="tertiary">Long spot</Chip>}
        {a.groupName && <Chip icon={IconGroup}>{a.groupName}</Chip>}
        {a.score != null && <Chip title="How sure your alert rules were that this is a spot offer">{a.score}% sure</Chip>}
        {!a.roomId && a.roomName && <Chip tone="reading" title="Couldn't tell which of your rooms this is">Room not matched</Chip>}
      </div>

      {clashWith && live && (
        <p className="flex items-start gap-2 rounded-md bg-error-container px-3 py-2 type-body-s text-on-error-container">
          <IconWarn aria-hidden className="icon mt-0.5 size-4 flex-none" />
          <span>Clashes with your spot at {clashWith}. You can still ask.</span>
        </p>
      )}

      {!compact && a.text && <p className="line-clamp-2 type-body-s text-on-surface-variant">“{a.text}”</p>}
      {state === "asked" && a.askedAt && <p className="type-body-s text-on-surface-variant">You asked {ago(a.askedAt, now)}. Waiting for {givenName(a.contact.name) || "them"} to reply on WhatsApp.</p>}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="text" size="sm" icon={IconClose} onClick={onDismiss}>
          {live ? "Dismiss" : "Clear"}
        </Button>
        {state === "asked" && onGotIt && (
          <Button variant="tonal" size="sm" icon={IconCheck} onClick={onGotIt}>
            I got it
          </Button>
        )}
        <Button size="sm" variant={live ? "filled" : "tonal"} icon={IconSend} onClick={onAsk}>
          {state === "asked" ? "Ask again" : live ? "Ask for it" : "Ask anyway"}
        </Button>
      </div>
    </div>
  );
}
