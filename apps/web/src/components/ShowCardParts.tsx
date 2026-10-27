// Pieces of a Lineup show card: the state pill, the collapse behaviour (remembered per lineup) and the Activity section.
import { useId, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { formatDate, lineupActivity, type ActivityRow, type Lineup, type Show, type ShowState, type SpotOffer } from "@spot/shared";
import { Button, Chip, cx, type Icon } from "@spot/ui";
import { IconArrowDown, IconCancel, IconCheck, IconChat, IconClock, IconGroup, IconHistory, IconLogout, IconMic, IconSend, IconUserMinus, IconUserPlus, IconWarn } from "@spot/ui";
import { useApp } from "../lib/app";
import { ComicAvatar } from "../lib/photos";
import { runCommand, timeAgo } from "../lib/data";

/* ---------- State pill ---------- */

const PILL: Record<ShowState["kind"], { tone: "primary" | "tertiary" | "success" | "error" | "neutral"; icon: Icon }> = {
  upcoming: { tone: "primary", icon: IconClock },
  today: { tone: "tertiary", icon: IconMic },
  done: { tone: "success", icon: IconCheck },
  didnt: { tone: "error", icon: IconCancel },
  recorded: { tone: "neutral", icon: IconHistory },
  called_off: { tone: "error", icon: IconCancel },
  past: { tone: "neutral", icon: IconHistory },
};

export function StatePill({ state, sent }: { state: ShowState; sent?: boolean }) {
  const p = PILL[state.kind];
  return (
    <Chip tone={p.tone} icon={p.icon} title={sent && !state.over ? `${state.label}. The lineup has been sent` : state.label} className="flex-none">
      {state.label}
      {sent && !state.over && <IconCheck className="icon ml-0.5 size-3.5" aria-hidden />}
    </Chip>
  );
}

/* ---------- Collapse, remembered per lineup ---------- */

const KEY = "spot.lineup.open.";
const memory = new Map<string, boolean>(); // when storage is blocked the choice lasts until the page closes

function read(key: string): boolean | undefined {
  try {
    const v = localStorage.getItem(KEY + key);
    if (v !== null) return v === "1";
  } catch {
    /* blocked storage */
  }
  return memory.get(key);
}

/**
 * Open or shut, with a default that follows the show (shut once it is over) until the curator toggles it by hand;
 * after that their choice stands for this lineup.
 */
export function useRemembered(key: string, fallback: boolean) {
  const [, bump] = useState(0);
  const open = read(key) ?? fallback;
  const set = (next: boolean) => {
    memory.set(key, next);
    try {
      localStorage.setItem(KEY + key, next ? "1" : "0");
    } catch {
      /* the choice just isn't remembered across visits */
    }
    bump((n) => n + 1);
  };
  return [open, set] as const;
}

/** Height animation without clipping menus: overflow is only hidden while it moves. */
export function Reveal({ open, id, className, children }: { open: boolean; id?: string; className?: string; children: ReactNode }) {
  const reduce = useReducedMotion();
  const [clip, setClip] = useState(false);
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          id={id}
          key="body"
          className={className}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.25, ease: [0.23, 1, 0.32, 1] }}
          style={{ overflow: clip ? "hidden" : "visible" }}
          onAnimationStart={() => setClip(true)}
          onAnimationComplete={() => setClip(false)}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return <IconArrowDown className={cx("icon size-5 flex-none text-on-surface-variant transition-transform duration-200", open && "rotate-180")} aria-hidden />;
}

/** The one line a collapsed card shows: avatars and what happened. */
export function CollapsedSummary({ names, ids, text, onOpen, panel }: { names: string[]; /** Comic ids, same order as names: shows their profile photos. */ ids?: string[]; text: string; onOpen: () => void; panel: string }) {
  const shown = names.slice(0, 4);
  return (
    <button type="button" aria-expanded={false} aria-controls={panel} onClick={onOpen} className="state-layer pressable mt-2 flex min-h-11 w-full items-center gap-2.5 rounded-md bg-surface-container px-3 text-left">
      {shown.length > 0 && (
        <span className="flex flex-none items-center" aria-hidden>
          {shown.map((n, i) => (
            <span key={`${n}${i}`} className={cx("rounded-full ring-2 ring-[var(--md-sys-color-surface-container)]", i > 0 && "-ml-1")}>
              <ComicAvatar id={ids?.[i]} name={n} size={24} tone="secondary" />
            </span>
          ))}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate type-label-l text-on-surface-variant">
        {text}
        {names.length > shown.length && <span className="text-on-surface-variant/70"> · +{names.length - shown.length}</span>}
      </span>
      <span className="flex-none type-label-m text-primary">Show</span>
    </button>
  );
}

/* ---------- Activity ---------- */

const ICON: Record<ActivityRow["icon"], Icon> = { send: IconSend, group: IconGroup, post: IconChat, offer: IconUserPlus, mic: IconMic, cleanup: IconUserMinus, out: IconLogout };
const TONE: Record<ActivityRow["tone"], string> = {
  done: "bg-primary-container text-on-primary-container",
  failed: "bg-error-container text-on-error-container",
  scheduled: "border border-dashed border-tertiary text-tertiary",
  info: "bg-surface-highest text-on-surface-variant",
};

function timeOf(r: ActivityRow, now: number): { label: string; title?: string } {
  if (r.when) return { label: r.when };
  if (r.at === null) return { label: r.tone === "scheduled" ? "Now" : "" };
  if (r.day) return { label: formatDate(r.day) };
  return { label: timeAgo(r.at, now), title: new Date(r.at).toLocaleString() };
}

// Building an Intl.DateTimeFormat is slow; every show card on the page used to build two per render.
const nowFormats = new Map<string, [Intl.DateTimeFormat, Intl.DateTimeFormat]>();
function zonedNow(timeZone: string, at: number) {
  let f = nowFormats.get(timeZone);
  if (!f) nowFormats.set(timeZone, (f = [new Intl.DateTimeFormat("en-CA", { timeZone }), new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })]));
  return { date: f[0].format(at), time: f[1].format(at) };
}

export function ActivitySection({ lineup, show, offers, nameOf }: { lineup?: Lineup; show: Show; offers: SpotOffer[]; nameOf: (id: string) => string; over?: boolean }) {
  const { uid, settings } = useApp();
  const nowMs = Date.now();
  const now = zonedNow(settings.timezone, nowMs);
  const rows = lineupActivity({ lineup, show, offers, now, nameOf });
  const key = `${lineup?.id ?? show.id}:activity`;
  const [open, setOpen] = useRemembered(key, false); // collapsed for every show until opened; the choice is kept per lineup
  const panel = useId();
  const [busy, setBusy] = useState(false);
  if (!rows.length) return null;
  const failed = rows.filter((r) => r.tone === "failed").length;
  const ahead = rows.filter((r) => r.tone === "scheduled").length;

  const retry = async () => {
    if (!lineup) return;
    setBusy(true);
    try {
      const r = await runCommand<{ removed?: number; failed?: number } | null>(uid, "cleanup_group", { lineupId: lineup.id }, 10 * 60_000);
      toast.success(r?.failed ? `${r.failed} still couldn't be removed from the ${show.name} group` : `The ${show.name} group is cleared`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-3 border-t border-outline-variant/60 pt-1">
      <button type="button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)} className="state-layer flex min-h-11 w-full items-center gap-2 rounded-md px-1 text-left">
        <span className="min-w-0 flex-1 truncate type-label-l text-on-surface-variant">Activity · {rows.length}</span>
        {failed > 0 && <Chip tone="error">{failed} failed</Chip>}
        {failed === 0 && ahead > 0 && <Chip tone="tertiary">{ahead} coming</Chip>}
        <Chevron open={open} />
      </button>
      <Reveal open={open} id={panel}>
        <ol className="flex flex-col pb-1">
          {rows.map((r) => {
            const I = ICON[r.icon];
            const t = timeOf(r, nowMs);
            return (
              // One grid for every row: icon | text block | time. The icon and the time are centred on the text block (title, then its subtext below), so titles share one left edge down the list.
              <li key={r.key} className="grid min-h-12 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 py-2">
                <span className={cx("grid size-8 place-items-center justify-self-center rounded-full", TONE[r.tone])}>{r.tone === "failed" ? <IconWarn className="icon size-4" aria-label="Failed" /> : <I className="icon size-4" aria-hidden />}</span>
                <div className="min-w-0">
                  <p className="type-body-m break-words">{r.text}</p>
                  {r.detail?.map((d, i) => (
                    <p key={i} className="type-body-s break-words text-on-surface-variant">{d}</p>
                  ))}
                </div>
                {t.label ? <time title={t.title} className="max-w-[6.5rem] text-right type-label-m tabular text-on-surface-variant">{t.label}</time> : <span aria-hidden />}
                {r.action === "retry_cleanup" && (
                  <Button size="sm" variant="tonal" className="col-start-2 justify-self-start" loading={busy} disabled={busy} onClick={() => void retry()}>
                    Retry now
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      </Reveal>
    </section>
  );
}
