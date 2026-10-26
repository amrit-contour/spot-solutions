// What every calendar view shares: the event model, the status colours, the data the views read, and the
// button that opens an event's full card in a popover (a bottom sheet on phones).
import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import { diffLineup, formatTime, sentSnapshot, type Comic, type Lineup, type Show, type SpotRequest } from "@spot/shared";
import { Popover } from "../Popover";
import { EventCard } from "./EventCard";
import { cx } from "../ui";
import { IconChatCross } from "../icons";
import { fmtDayShort, toMinutes } from "../../lib/calendarDates";

export interface CalEvent {
  key: string;
  show: Show;
  date: string;
  /** Monday of the week the date is in. */
  week: string;
  lineup?: Lineup;
  startMin: number;
  endMin: number;
}

export interface CalData {
  today: string;
  /** Minutes since midnight, in the curator's timezone. */
  nowMin: number;
  loading: boolean;
  comicsById: Map<string, Comic>;
  asksByWeek: Map<string, SpotRequest[]>;
  /** Every lineup the current view loaded (all its weeks). */
  lineups: Lineup[];
  /** Shows that fit a day, earliest first. */
  eventsOn: (date: string) => CalEvent[];
  regretsFor: (ev: CalEvent) => number;
  /** Phones and desktop differ on what tapping a date does. */
  openDay: (date: string) => void;
}

const Ctx = createContext<CalData | null>(null);
export const CalProvider = ({ value, children }: { value: CalData; children: ReactNode }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export function useCal() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCal outside CalProvider");
  return v;
}

/** How long a show is blocked out for on the time grid: slots at the show's pace, between 1.5 and 3 hours. */
export function showMinutes(show: Show) {
  return Math.min(180, Math.max(90, show.slotCount * (show.defaultMinutes ?? 10) + 20));
}

export function makeEvent(show: Show, date: string, week: string, lineup?: Lineup): CalEvent {
  const startMin = toMinutes(show.startTime);
  return { key: `${week}_${show.id}`, show, date, week, lineup, startMin, endMin: startMin + showMinutes(show) };
}

/* ---------- Status ---------- */

export interface Tone {
  id: "loading" | "confirmed" | "happened" | "ask" | "draft" | "empty" | "off";
  label: string;
  /** Tinted surface and its text. */
  block: string;
  /** The leading bar and the dot in month chips. */
  bar: string;
  dashed?: boolean;
}

const TONES: Record<Tone["id"], Omit<Tone, "id" | "label">> = {
  loading: { block: "bg-surface-high text-on-surface-variant animate-pulse", bar: "bg-outline-variant" },
  confirmed: { block: "bg-primary-container text-on-primary-container", bar: "bg-primary" },
  happened: { block: "bg-secondary-container text-on-secondary-container", bar: "bg-secondary" },
  ask: { block: "bg-tertiary-container text-on-tertiary-container", bar: "bg-tertiary" },
  draft: { block: "bg-tertiary-container text-on-tertiary-container", bar: "bg-tertiary" },
  empty: { block: "bg-surface text-on-surface-variant border border-dashed border-outline", bar: "bg-outline", dashed: true },
  off: { block: "bg-error-container text-on-error-container", bar: "bg-error" },
};

export function toneOf(ev: CalEvent, today: string, loading: boolean): Tone {
  const l = ev.lineup;
  const past = ev.date < today;
  const t = (id: Tone["id"], label: string): Tone => ({ id, label, ...TONES[id] });
  if (!l) return loading ? t("loading", "Loading") : t("empty", past ? "No lineup" : "Not started");
  if (l.status === "cancelled") return t("off", "Cancelled");
  if (l.status === "canned") return t("off", "Didn't happen");
  if (l.status === "confirmed") {
    if (past && l.outcome === "happened") return t("happened", "Happened");
    if (past && !l.outcome) return t("ask", "Did it happen?");
    return t("confirmed", "Confirmed");
  }
  return l.slots.length ? t("draft", "Draft") : t("empty", past ? "No lineup" : "Not started");
}

export const TONE_LEGEND: { id: Tone["id"]; label: string }[] = [
  { id: "confirmed", label: "Confirmed" },
  { id: "draft", label: "Draft" },
  { id: "empty", label: "Not started" },
  { id: "happened", label: "Happened" },
  { id: "off", label: "Cancelled" },
];
export const legendBar = (id: Tone["id"]) => TONES[id].bar;

/** Changes made since the lineup was confirmed that the comics haven't been told about. */
export function pendingCount(ev: CalEvent) {
  const l = ev.lineup;
  if (!l || l.status !== "confirmed") return 0;
  return diffLineup(l.slots, l.sent ?? sentSnapshot(l.slots, ev.show, l.sentAt ?? 0), ev.show).total;
}

/** Shown in a week block, month chip or agenda row when people still need telling. Static: the whole event is the button. */
export function NotToldMark({ n, className }: { n: number; className?: string }) {
  if (!n) return null;
  const label = `${n} change${n > 1 ? "s" : ""} not told yet`;
  return (
    <span title={label} role="img" aria-label={label} className={cx("inline-grid size-5 flex-none place-items-center rounded-sm bg-tertiary text-on-tertiary", className)}>
      <IconChatCross className="icon size-3.5" />
    </span>
  );
}

export const fillOf = (ev: CalEvent) => `${ev.lineup?.slots.length ?? 0}/${ev.show.slotCount}`;

/* ---------- The popover ---------- */

/**
 * Wraps one event trigger. Tapping it opens the same card the Day view shows, with every quick action:
 * an anchored popover on desktop, a bottom sheet on phones.
 */
export function EventPopover({ ev, anchorClassName, anchorStyle, className, children }: { ev: CalEvent; anchorClassName?: string; anchorStyle?: CSSProperties; className?: string; children: ReactNode }) {
  const cal = useCal();
  const tone = toneOf(ev, cal.today, cal.loading);
  return (
    <Popover
      title={`${ev.show.name} · ${fmtDayShort(ev.date)}`}
      width={380}
      anchorClassName={anchorClassName}
      anchorStyle={anchorStyle}
      trigger={(toggle, open) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${ev.show.name}, ${fmtDayShort(ev.date)}, ${formatTime(ev.show.startTime)}. ${tone.label}, ${fillOf(ev)} slots filled`}
          className={cx("state-layer pressable text-left focus-visible:outline-offset-[-3px]! aria-expanded:ring-2 aria-expanded:ring-inset aria-expanded:ring-primary", className)}
        >
          {children}
        </button>
      )}
    >
      {() => (
        <ul>
          <EventCard
            bare
            show={ev.show}
            date={ev.date}
            today={cal.today}
            week={ev.week}
            lineup={ev.lineup}
            loading={cal.loading}
            asks={cal.asksByWeek.get(ev.week) ?? []}
            comicsById={cal.comicsById}
            regretsAfter={cal.regretsFor(ev)}
          />
        </ul>
      )}
    </Popover>
  );
}
