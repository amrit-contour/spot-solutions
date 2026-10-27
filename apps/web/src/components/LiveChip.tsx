// A pill on a comic's row for what their show group just said: "Running late · ETA 8:40", "Wants to cancel", "Here ✓", "Asked to swap".
// Tap it for the quote and the quick actions. The worker writes `slot.live` (showGroupWatch.ts); it goes away after the show.
import { useState } from "react";
import { toast } from "sonner";
import { formatTime, liveActive, liveLabel, type Lineup, type Show, type Slot, type SlotLive } from "@spot/shared";
import { Button, Popover, cx } from "@spot/ui";
import { IconChat, IconChatCross, IconClock, IconRepeat, IconUserCheck, type Icon } from "@spot/ui";
import { runCommand } from "../lib/data";
import { setSlots } from "../lib/lineup";
import { Pill, type PillTone } from "./Pills";

const LOOK: Record<SlotLive["kind"], { tone: PillTone; icon: Icon }> = {
  late: { tone: "warn", icon: IconClock },
  cancel: { tone: "error", icon: IconChatCross },
  swap: { tone: "secondary", icon: IconRepeat },
  here: { tone: "told", icon: IconUserCheck },
  question: { tone: "secondary", icon: IconChat },
};

/** The live note on a slot, if it is still worth showing (not ignored, not expired). */
export const liveOf = (slot: Slot | undefined, now = Date.now()): SlotLive | null => (liveActive(slot?.live, now) ? slot!.live! : null);

const ago = (at: number, now = Date.now()) => {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

export function LiveChip({ uid, live, name, show, lineup, className }: { uid: string; live: SlotLive; name: string; show: Show; lineup: Lineup; className?: string }) {
  const [busy, setBusy] = useState(false);
  const { tone, icon } = LOOK[live.kind];
  const label = liveLabel(live, live.eta ? formatTime(live.eta) : undefined);
  const i = lineup.slots.findIndex((s) => s.live?.msgId === live.msgId);
  const first = name.split(/\s+/)[0] || "They";
  const editable = lineup.status === "draft" || lineup.status === "confirmed";

  const run = async (what: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await what();
      if (done) toast.success(done);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Ignore keeps the record (so the same message never comes back as a new pill) but hides it.
  const ignore = () => setSlots(uid, lineup.weekOf, show, lineup.slots.map((s, j) => (j === i && s.live ? { ...s, live: { ...s.live, handled: "ignored" as const } } : s)));
  const later = () => {
    const slots = [...lineup.slots];
    [slots[i], slots[i + 1]] = [slots[i + 1], slots[i]];
    return setSlots(uid, lineup.weekOf, show, slots);
  };

  return (
    // Stops the drag sensors from treating a tap on the pill as the start of a drag.
    <span className={cx("inline-flex min-w-0 max-w-full", className)} onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <Popover
        title={`${name}: ${label}`}
        width={320}
        trigger={(toggle) => (
          <button type="button" onClick={toggle} aria-label={`${name}: ${label}. Show message and actions`} className="state-layer pressable inline-flex min-w-0 max-w-full rounded-sm">
            <Pill tone={tone} icon={icon}>{label}</Pill>
          </button>
        )}
      >
        {(close) => (
          <div className="flex flex-col gap-3">
            <div>
              <p className="type-label-l text-on-surface-variant">From the {show.name} group, {ago(live.at)}</p>
              <blockquote className="mt-1 rounded-md bg-surface-container px-3 py-2 type-body-m text-balance">“{live.snippet}”</blockquote>
            </div>
            <div className="flex flex-wrap gap-2">
              {live.kind === "cancel" && editable && (
                <Button size="sm" disabled={busy} onClick={() => void run(() => runCommand(uid, "drop_from_lineup", { lineupId: lineup.id, comicId: lineup.slots[i]?.comicId }, 120_000), `${first} is off the lineup`).then(close)}>
                  Remove from lineup
                </Button>
              )}
              {live.kind === "late" && editable && i >= 0 && i < lineup.slots.length - 1 && (
                <Button size="sm" disabled={busy} onClick={() => void run(later, `${first} moved later in the order`).then(close)}>
                  Move later in order
                </Button>
              )}
              <Button size="sm" variant="text" disabled={busy} onClick={() => void run(ignore).then(close)}>
                {live.kind === "cancel" ? "Ignore" : "Dismiss"}
              </Button>
            </div>
            {live.kind === "cancel" && <p className="type-body-s text-on-surface-variant">Removing runs the usual drop-out: the slot opens, and {first} leaves the group on the show day.</p>}
          </div>
        )}
      </Popover>
    </span>
  );
}
