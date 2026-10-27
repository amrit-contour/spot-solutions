import { alertDayLabel, alertState, formatTime, givenName, timeLeft, timesShort, type SpotAlert } from "@spot/shared";
import { Button, Chip, IconBuilding, IconCheck, IconClock, IconSend, IconUserCheck, IconWarn } from "@spot/ui";
import { Card, CardActions, Chips, IconTile } from "./ui";
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
  onPickRoom,
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
  /** Which of the candidate rooms the offer is about. */
  onPickRoom?: (roomId: string) => void;
}) {
  const state = alertState(a, now);
  const live = state === "open" || state === "asked";
  const clashWith = clash?.with ?? a.clash?.with;
  const when = [alertDayLabel(a.date, today), a.times.length ? timesShort(a.times) : "time not said"].join(" · ");
  const urgent = live && a.expiresAt - now < 30 * 60_000;
  const stateChip =
    state === "open" ? (
      <Chip tone={urgent ? "error" : "neutral"} icon={IconClock}>{timeLeft(a.expiresAt, now)}</Chip>
    ) : state === "asked" ? (
      <Chip tone="primary" icon={IconSend}>Asked</Chip>
    ) : state === "got" ? (
      <Chip tone="success" icon={IconCheck}>Got it</Chip>
    ) : state === "declined" ? (
      <Chip tone="error">Said no</Chip>
    ) : state === "closed" ? (
      <Chip tone="error">Closed</Chip>
    ) : (
      <Chip>Ended</Chip>
    );
  const meta = [a.groupName, a.score != null ? `${a.score}% sure` : null].filter(Boolean).join(" · ");
  return (
    <Card id={`alert-${a.id}`} highlight={highlight} dim={!live} className="flex flex-col gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <IconTile icon={IconBuilding} />
        <div className="min-w-0 flex-1">
          <p className="truncate type-title-m">{a.roomName ?? "A room (not named)"}</p>
          <p className="truncate type-body-s text-on-surface-variant">{when}</p>
        </div>
      </div>

      <Chips>
        {stateChip}
        <Chip tone="fact" icon={IconUserCheck}>
          DM {givenName(a.contact.name) || "them"}
          {a.contact.kind === "mentioned" ? " (tagged)" : ""}
        </Chip>
        {a.reachBy && <Chip tone={urgent ? "error" : "neutral"} icon={IconClock}>Reach by {formatTime(a.reachBy)}</Chip>}
        {a.busking && <Chip tone="tertiary">Busking</Chip>}
        {a.long && <Chip tone="tertiary">Long spot</Chip>}
        {!a.roomId && a.roomName && <Chip tone="reading" title="Couldn't tell which of your rooms this is">Room not matched</Chip>}
      </Chips>

      {live && !a.roomId && a.roomCandidates && a.roomCandidates.length > 1 && onPickRoom && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="type-body-s text-on-surface-variant">Which {a.roomName ?? "room"}?</span>
          {a.roomCandidates.map((c) => (
            <Button key={c.id} size="sm" variant="tonal" onClick={() => onPickRoom(c.id)}>
              {c.area || c.name}
            </Button>
          ))}
        </div>
      )}

      {clashWith && live && (
        <p className="flex items-start gap-2 rounded-md bg-error-container px-3 py-2 type-body-s text-on-error-container">
          <IconWarn aria-hidden className="icon mt-0.5 size-4 flex-none" />
          <span>Clashes with your spot at {clashWith}. You can still ask.</span>
        </p>
      )}

      {!compact && a.text && <p className="line-clamp-2 type-body-s text-on-surface-variant">“{a.text}”</p>}
      {meta && <p className="truncate type-label-m text-on-surface-variant" title="How sure your alert rules were that this is a spot offer">{meta}</p>}
      {state === "asked" && a.askedAt && !a.reply && <p className="type-body-s text-on-surface-variant">You asked {ago(a.askedAt, now)}. Waiting for {givenName(a.contact.name) || "them"} to reply on WhatsApp.</p>}
      {a.reply && (
        <p className="type-body-s text-on-surface-variant">
          {givenName(a.contact.name) || "They"} {state === "got" ? "said yes" : state === "declined" ? "said no" : "replied"}: “{a.reply.text}”
          {state === "got" ? (a.reply.unsure ? " Check it, then it's in My spots." : " It's in My spots.") : state === "asked" ? " Not sure what that means: you decide." : ""}
        </p>
      )}

      <CardActions spread>
        <Button variant="text" size="sm" onClick={onDismiss} className="-ml-2">
          {live ? "Dismiss" : "Clear"}
        </Button>
        <span className="flex items-center gap-2">
          {state === "asked" && onGotIt && (
            <Button variant="tonal" size="sm" icon={IconCheck} onClick={onGotIt}>
              I got it
            </Button>
          )}
          <Button size="sm" variant={live ? "filled" : "tonal"} icon={IconSend} onClick={onAsk}>
            {state === "asked" ? "Ask again" : live ? "Ask for it" : "Ask anyway"}
          </Button>
        </span>
      </CardActions>
    </Card>
  );
}
