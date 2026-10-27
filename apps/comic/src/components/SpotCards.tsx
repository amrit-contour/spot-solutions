import { SPOT_SOURCE_LABEL, SPOT_STATE_LABEL, formatTime, spotHasNotes, spotState, type MySpot } from "@spot/shared";
import { Button, Chip, IconBuilding, IconCheck, IconClose, IconStar, IconWarn } from "@spot/ui";

/** Five stars, filled up to `value`. */
export function Stars({ value, size = "size-4" }: { value: number; size?: string }) {
  return (
    <span className="inline-flex items-center gap-0.5 text-primary" role="img" aria-label={`${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <IconStar key={n} className={`icon ${size} ${n <= value ? "" : "opacity-25"}`} />
      ))}
    </span>
  );
}

const STATE_TONE = { upcoming: "neutral", tonight: "primary", to_check: "error", happened: "success", didnt: "neutral", cancelled: "neutral" } as const;

/** One spot on the list: time, room, where it came from, where it stands, a clash warning, and the notes at a glance. */
export function SpotCard({ spot, today, clash, onOpen, onMark }: { spot: MySpot; today: string; clash?: MySpot[]; onOpen: () => void; onMark: (happened: boolean) => void }) {
  const state = spotState(spot, today);
  const notes = spot.notes;
  const canMark = state === "tonight" || state === "to_check";
  return (
    <div className={`flex min-w-0 flex-col gap-2.5 rounded-lg bg-surface-low p-3.5 ${state === "didnt" || state === "cancelled" ? "opacity-70" : ""}`}>
      <button onClick={onOpen} className="state-layer pressable -m-1 flex min-w-0 flex-col gap-2 rounded-md p-1 text-left" aria-label={`Open ${spot.roomName ?? "spot"}`}>
        <span className="flex min-w-0 items-start gap-3">
          <span className="grid size-10 flex-none place-items-center rounded-md bg-tertiary-container text-on-tertiary-container">
            <IconBuilding className="icon size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate type-title-m">{spot.roomName || "Somewhere"}</span>
            <span className="block truncate type-body-m text-on-surface-variant">{spot.time ? formatTime(spot.time) : "No time set"}</span>
          </span>
          <Chip tone={STATE_TONE[state]} className="flex-none">
            {SPOT_STATE_LABEL[state]}
          </Chip>
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Chip>{SPOT_SOURCE_LABEL[spot.source]}</Chip>
          {notes?.rating ? <Stars value={notes.rating} /> : null}
        </span>
        {clash && clash.length > 0 && (
          <span className="flex min-w-0 items-start gap-1.5 rounded-sm bg-error-container px-2.5 py-1.5 type-label-m text-on-error-container">
            <IconWarn aria-hidden className="icon mt-0.5 size-4 flex-none" />
            <span className="min-w-0">
              Close to {clash[0]!.roomName || "another spot"}
              {clash[0]!.time ? ` at ${formatTime(clash[0]!.time)}` : ""}. You may not make both.
            </span>
          </span>
        )}
        {spotHasNotes(spot) && (notes?.whatWorked || notes?.crowd || notes?.room) && (
          <span className="line-clamp-2 type-body-s text-on-surface-variant">{[notes?.crowd, notes?.whatWorked ? `Worked: ${notes.whatWorked}` : "", notes?.room].filter(Boolean).join(" · ")}</span>
        )}
      </button>
      {canMark && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto type-label-m text-on-surface-variant">{state === "tonight" ? "After the set" : "Did this one happen?"}</span>
          <Button size="sm" variant="text" icon={IconClose} onClick={() => onMark(false)}>
            Didn't happen
          </Button>
          <Button size="sm" variant="tonal" icon={IconCheck} onClick={() => onMark(true)}>
            It happened
          </Button>
        </div>
      )}
    </div>
  );
}
