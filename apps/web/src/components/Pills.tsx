// One pill style for every small fact on a comic tile (Lineup, Waiting, Calendar) and for group tags.
// Same tokens as the Requests page: solid = the app knows it, dashed = read from the comic's message.
import { DAY_SHORT, type Comic, type Show, type SpotRequest } from "@spot/shared";
import { cx, type Icon } from "./ui";
import { IconCalendar, IconCrown, IconHistory, IconPen, IconRepeat, IconUserCheck } from "./icons";

export type PillTone = "fact" | "reading" | "told" | "warn" | "primary" | "secondary" | "joining" | "error" | "plain";

const TONE: Record<PillTone, string> = {
  fact: "bg-surface-high text-on-surface",
  reading: "border border-dashed border-outline-variant text-on-surface-variant",
  told: "bg-secondary-container text-on-secondary-container",
  warn: "bg-tertiary-container text-on-tertiary-container",
  primary: "bg-primary-container text-on-primary-container",
  secondary: "bg-secondary-container text-on-secondary-container",
  joining: "border border-dashed border-primary text-primary",
  error: "bg-error-container text-on-error-container",
  plain: "border border-outline-variant text-on-surface-variant",
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

/** One row, never wraps: the first `max` pills, then "+N" (its tooltip lists the rest). */
export function PillRow({ pills, max = 2, className }: { pills: PillSpec[]; max?: number; className?: string }) {
  if (!pills.length) return null;
  const shown = pills.slice(0, max);
  const rest = pills.slice(max);
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
  return { key: `state${i}`, label: s.text, tone: "warn", icon: s.kind === "minutes" ? IconPen : undefined };
}

/**
 * The pills for one comic, most useful first: tell state, role at this show, performed last week, day preference.
 * The day pill is dashed (read from their message) and only appears when they actually sent a request.
 */
export function comicPills({ comic, request, show, lastWeek, states, days = true }: { comic?: Comic; request?: SpotRequest; show?: Pick<Show, "regulars" | "protected">; lastWeek?: string; states?: TellState[]; days?: boolean }, id?: string): PillSpec[] {
  const out: PillSpec[] = [];
  (states ?? []).forEach((s, i) => out.push(tellPill(s, i)));
  const cid = id ?? comic?.id ?? request?.comicId;
  if (cid && show?.protected?.includes(cid)) out.push({ key: "role", label: "Co-host", tone: "fact", icon: IconCrown });
  else if (cid && show?.regulars?.includes(cid)) out.push({ key: "role", label: "Regular", tone: "fact", icon: IconRepeat });
  if (lastWeek && comic?.lastPerformedWeek === lastWeek) out.push({ key: "last", label: "Last week", tone: "fact", icon: IconHistory, title: "Performed last week" });
  if (days && request) {
    const d = request.intent.preferredDays;
    out.push({ key: "days", label: d.length ? d.map((x) => DAY_SHORT[x]).join(" · ") : "Any day", tone: "reading", icon: IconCalendar });
  }
  return out;
}
