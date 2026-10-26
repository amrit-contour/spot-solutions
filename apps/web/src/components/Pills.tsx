// One pill style for every small fact on a comic tile (Lineup, Waiting, Calendar) and for group tags.
// Same tokens as the Requests page: solid = the app knows it, dashed = read from the comic's message.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DAY_SHORT, type Comic, type Show, type SpotRequest } from "@spot/shared";
import { cx, type Icon } from "./ui";
import { IconArrowRight, IconCalendar, IconChatCross, IconCrown, IconHistory, IconPen, IconRepeat, IconUserCheck, IconUserPlus } from "./icons";

export type PillTone = "fact" | "reading" | "told" | "warn" | "primary" | "secondary" | "joining" | "error" | "plain";

const TONE: Record<PillTone, string> = {
  // Each filled tone carries a hairline ring: in dark mode the containers sit one step from the tile behind them
  // and vanish without it. "told" is green (done); "warn" is the loud neutral with a strong outline.
  fact: "bg-surface-highest text-on-surface ring-1 ring-inset ring-outline/60",
  reading: "border border-dashed border-outline text-on-surface-variant",
  told: "bg-primary-container text-on-primary-container ring-1 ring-inset ring-primary/40",
  warn: "bg-tertiary-container text-on-tertiary-container ring-1 ring-inset ring-tertiary/70",
  primary: "bg-primary-container text-on-primary-container ring-1 ring-inset ring-primary/40",
  secondary: "bg-secondary-container text-on-secondary-container ring-1 ring-inset ring-outline/50",
  joining: "border border-dashed border-primary text-primary",
  error: "bg-error-container text-on-error-container ring-1 ring-inset ring-error/50",
  plain: "border border-outline text-on-surface-variant",
};

export interface PillSpec {
  key: string;
  label: string;
  tone: PillTone;
  icon?: Icon;
  title?: string;
}

/** Fixed height (20px) so tiles in a column stay level whatever they carry. Long labels truncate. */
export function Pill({ tone = "fact", icon: I, children, title, className }: { tone?: PillTone; icon?: Icon; children: React.ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={cx("inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded-sm px-1.5 type-label-m whitespace-nowrap", TONE[tone], className)}>
      {I && <I className="icon -ml-0.5 size-3.5 flex-none" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Icon-only pill, same tone as the full one. The label lives in a tooltip (hover, keyboard focus, or a tap on touch). */
export function IconPill({ pill, className }: { pill: PillSpec; className?: string }) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const el = useRef<HTMLButtonElement>(null);
  const text = pill.title ?? pill.label;
  const show = () => {
    const r = el.current?.getBoundingClientRect();
    if (r) setTip({ x: r.left + r.width / 2, y: r.top });
  };
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    const onDown = (e: PointerEvent) => !el.current?.contains(e.target as Node) && hide();
    const t = window.setTimeout(hide, 3200); // a tapped tooltip goes away on its own
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", hide, true);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", hide, true);
    };
  }, [tip]);
  const I = pill.icon;
  return (
    <>
      <button
        ref={el}
        type="button"
        title={text}
        aria-label={text}
        onPointerEnter={(e) => e.pointerType === "mouse" && show()}
        onPointerLeave={(e) => e.pointerType === "mouse" && setTip(null)}
        onFocus={show}
        onBlur={() => setTip(null)}
        onClick={() => (tip ? setTip(null) : show())}
        className={cx("inline-grid h-6 min-w-6 flex-none place-items-center rounded-sm px-1 type-label-m outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary", TONE[pill.tone], className)}
      >
        {I ? <I className="icon size-3.5" /> : <span aria-hidden>{pill.label.slice(0, 2)}</span>}
      </button>
      {tip &&
        createPortal(
          <span role="tooltip" style={{ left: Math.min(Math.max(tip.x, 90), window.innerWidth - 90), top: tip.y - 6 }} className="pointer-events-none fixed z-[70] max-w-44 -translate-x-1/2 -translate-y-full rounded-sm bg-inverse-surface px-2 py-1 text-center type-label-m text-inverse-on-surface shadow-lg">
            {text}
          </span>,
          document.body,
        )}
    </>
  );
}

/** One row, never wraps: the first `max` pills, then "+N" (its tooltip lists the rest). `compact` = icon-only with tooltips. */
export function PillRow({ pills, max = 2, className, compact }: { pills: PillSpec[]; max?: number; className?: string; compact?: boolean }) {
  if (!pills.length) return null;
  const shown = pills.slice(0, max);
  const rest = pills.slice(max);
  // Compact rows use icons to save room, but a lone pill has room for its words.
  if (compact && pills.length === 1) {
    const p = pills[0];
    return (
      <div className={cx("flex min-w-0 items-center", className)}>
        <Pill tone={p.tone} icon={p.icon} title={p.title ?? p.label}>
          {p.label}
        </Pill>
      </div>
    );
  }
  if (compact)
    return (
      <div className={cx("flex min-w-0 items-center gap-1", className)}>
        {shown.map((p) => <IconPill key={p.key} pill={{ ...p, icon: p.icon ?? IconRepeat }} />)}
        {rest.length > 0 && <IconPill pill={{ key: "more", label: `+${rest.length}`, tone: "plain", title: rest.map((p) => p.title ?? p.label).join(" · ") }} />}
      </div>
    );
  return (
    <div className={cx("flex min-w-0 items-center gap-1 overflow-hidden", className)}>
      {shown.map((p) => (
        <Pill key={p.key} tone={p.tone} icon={p.icon} title={p.title ?? p.label}>
          {p.label}
        </Pill>
      ))}
      {rest.length > 0 && (
        <Pill tone="plain" title={rest.map((p) => p.label).join(" · ")} className="flex-none">
          +{rest.length}
        </Pill>
      )}
    </div>
  );
}

/** What the lineup says about this comic and this send: already told, new, moved... Most urgent first. */
export type TellState = { kind: "told" | "new" | "moved" | "minutes"; text: string };

export function tellPill(s: TellState, i = 0): PillSpec {
  if (s.kind === "told") return { key: `state${i}`, label: s.text, tone: "told", icon: IconUserCheck };
  return { key: `state${i}`, label: s.text, tone: "warn", icon: s.kind === "minutes" ? IconPen : s.kind === "moved" ? IconArrowRight : IconChatCross };
}

/**
 * The pills for one comic, most useful first: tell state, role at this show, performed last week, day preference.
 * The day pill is dashed (read from their message) and only appears when they actually sent a request.
 */
export function comicPills({ comic, request, show, lastWeek, states, days = true, adhoc }: { comic?: Comic; request?: SpotRequest; show?: Pick<Show, "regulars" | "protected">; lastWeek?: string; states?: TellState[]; days?: boolean; /** A last-minute spot on this lineup. */ adhoc?: boolean }, id?: string): PillSpec[] {
  const out: PillSpec[] = [];
  const cid = id ?? comic?.id ?? request?.comicId;
  // Regulars and co-hosts always know: their role pill says enough, so no "Already told" on them.
  const standing = Boolean(cid && (show?.protected?.includes(cid) || show?.regulars?.includes(cid)));
  (states ?? []).forEach((s, i) => {
    if (standing && s.kind === "told") return;
    out.push(tellPill(s, i));
  });
  if (cid && show?.protected?.includes(cid)) out.push({ key: "role", label: "Co-host", tone: "fact", icon: IconCrown });
  else if (cid && show?.regulars?.includes(cid)) out.push({ key: "role", label: "Regular", tone: "fact", icon: IconRepeat });
  if (adhoc) out.push({ key: "adhoc", label: "Ad hoc", tone: "fact", icon: IconUserPlus, title: "Last-minute spot: kept in their history, doesn't hold them back" });
  if (lastWeek && comic?.lastPerformedWeek === lastWeek) out.push({ key: "last", label: "Last week", tone: "fact", icon: IconHistory, title: "Performed last week" });
  if (days && request) {
    const d = request.intent.preferredDays;
    out.push({ key: "days", label: d.length ? d.map((x) => DAY_SHORT[x]).join(" · ") : "Any day", tone: "reading", icon: IconCalendar });
  }
  return out;
}
