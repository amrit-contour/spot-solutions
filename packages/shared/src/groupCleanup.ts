// After-show group cleanup: the day after a mic, thank the group and clear it for next week's comics. POCs, regulars,
// co-hosts, admins, you, and anyone already on next week's lineup stay. If the mic didn't happen (or the curator wants to
// decide each time), it asks first: the same comics may be repeating next week. Pure rules; the worker runs them.
import { addDays, type GroupPost } from "./groupPosts.ts";
import type { MessageOverride } from "./messages.ts";
import { comicChatKeys } from "./threads.ts";
import type { Comic, Lineup, Show } from "./types.ts";

export interface GroupCleanup {
  enabled: boolean;
  /** auto: clear it when the mic happened, ask when it didn't. ask: always ask first. */
  mode: "auto" | "ask";
  /** Local time on the day after the show, "HH:MM". */
  time: string;
  /** The message sent before clearing. Missing: the "After the show" template in Settings → Messages. Empty string: none. */
  message?: MessageOverride | null;
  /**
   * Run the cleanup right after this scheduled post goes out (the thank-you, say) instead of at `time` the day after. Missing: the
   * old per-post "After sending: remove this week's comics" switch still counts (see cleanupTriggerPost). null: at `time`.
   * If the post is gone or paused the cleanup falls back to `time`.
   */
  afterPostId?: string | null;
}

export const DEFAULT_CLEANUP: GroupCleanup = { enabled: false, mode: "auto", time: "11:00" };

/** Someone the cleanup couldn't remove (yet), and why. */
export interface CleanupPending {
  /** The id to remove them by (phone-based when known). */
  id: string;
  name?: string;
  reason: string;
}

/**
 * What happened with one lineup's cleanup. Written by the worker (and by the curator's answer).
 * "partial": the pass ran but some people are still in; `pending` says who and why, `retryAt` when it tries again (missing:
 * out of retries, the curator has to remove them by hand).
 */
export interface LineupCleanup {
  status: "asked" | "done" | "partial" | "kept" | "skipped";
  at: number;
  removed?: number;
  failed?: number;
  /** Why it asked: the mic didn't happen, or the show is set to ask every time. */
  reason?: "canned" | "ask";
  pending?: CleanupPending[];
  /** Next automatic retry (epoch ms). Missing on a "partial" cleanup: gave up, or a retry is running. */
  retryAt?: number | null;
  /** Passes done so far (the first one counts). */
  attempts?: number;
  /** No automatic retry after this (epoch ms). */
  until?: number;
  /** Members left alone because they couldn't be identified (e.g. an @lid with no known number). */
  skipped?: number;
}

/** Past this many days after the show, a cleanup that never ran is dropped (a server that was off for a week). */
export const CLEANUP_WINDOW_DAYS = 3;

export type CleanupStep = "run" | "ask" | "skip" | "retry";

/**
 * The post that starts this show's cleanup when it goes out, or null (the cleanup runs at its set time). One source of truth: the
 * show's cleanup setting. `after.removeComics` on a post is the old way of saying the same thing; it only counts while the show
 * hasn't chosen (afterPostId missing), so it can never add a second trigger.
 */
export function cleanupTriggerPost(show: { cleanup?: GroupCleanup | null; groupPosts?: GroupPost[] | null }): GroupPost | null {
  const posts = show.groupPosts ?? [];
  const id = show.cleanup?.afterPostId;
  if (id) return show.cleanup?.enabled ? (posts.find((p) => p.id === id && p.enabled) ?? null) : null;
  if (id === null) return null;
  return posts.find((p) => p.enabled && p.after?.removeComics) ?? null;
}

/** A lineup's cleanup happens at most once: anything that already started one (asked, running, done, kept, skipped) blocks the next trigger. */
export const cleanupAlreadyStarted = (lineup: { cleanup?: unknown; backfilled?: boolean }) => Boolean(lineup.cleanup) || Boolean(lineup.backfilled);

/**
 * Moves the old per-post "remove this week's comics" switch into the show's cleanup setting: the show's cleanup now starts after
 * that post. Returns null when there is nothing to move. A show with cleanup off keeps asking first (what the old switch did), so
 * the cleanup is turned on in "ask" mode for it.
 */
export function migrateCleanupTrigger<T extends { cleanup?: GroupCleanup | null; groupPosts?: GroupPost[] | null }>(show: T): { cleanup: GroupCleanup; groupPosts: GroupPost[] } | null {
  const posts = show.groupPosts ?? [];
  if (!posts.some((p) => p.after?.removeComics)) return null;
  const cur = show.cleanup ?? DEFAULT_CLEANUP;
  const first = posts.find((p) => p.enabled && p.after?.removeComics) ?? posts.find((p) => p.after?.removeComics)!;
  const cleanup: GroupCleanup = cur.afterPostId === undefined ? { ...cur, enabled: true, mode: cur.enabled ? cur.mode : "ask", afterPostId: first.id } : { ...cur };
  const groupPosts = posts.map((p) => {
    if (!p.after?.removeComics) return p;
    const { removeComics: _drop, ...rest } = p.after;
    return { ...p, after: Object.keys(rest).length ? rest : null };
  });
  return { cleanup, groupPosts };
}

/**
 * What to do now for this lineup, or null for nothing yet. `micCheckOn`: without mic checks there's never an answer, so a
 * confirmed show counts as having happened.
 */
export function cleanupStep(
  show: Pick<Show, "groupId" | "cleanup" | "active" | "groupPosts">,
  lineup: Pick<Lineup, "date" | "status" | "outcome" | "cleanup"> & { backfilled?: boolean },
  now: { date: string; time: string },
  micCheckOn: boolean,
  nowMs: number = Date.now(),
): CleanupStep | null {
  const c = show.cleanup;
  if (lineup.backfilled) return null; // a past show recorded afterwards: the group was never ours to clear
  // A pass that left people behind: try again when it's time (retryAt is cleared while a retry runs, and when it gives up).
  if (lineup.cleanup?.status === "partial") return lineup.cleanup.retryAt && lineup.cleanup.retryAt <= nowMs ? "retry" : null;
  if (!c?.enabled || !show.groupId || !lineup.date || lineup.cleanup) return null;
  if (lineup.status !== "confirmed" && lineup.status !== "canned") return null;
  const day = addDays(lineup.date, 1);
  if (now.date < day || (now.date === day && now.time < c.time)) return null;
  if (now.date > addDays(lineup.date, CLEANUP_WINDOW_DAYS)) return "skip";
  const off = lineup.outcome === "canned" || lineup.status === "canned";
  if (off) return "ask";
  const happened = lineup.outcome === "happened" || (!micCheckOn && lineup.status === "confirmed");
  if (!happened) return null; // waiting for the mic check answer
  if (cleanupTriggerPost(show)) return null; // the chosen post starts it when it goes out (a show that didn't happen still asks, above)
  return c.mode === "auto" ? "run" : "ask";
}

/** Retry delays after the first pass: 2 min, 10 min, then hourly, until `until`. */
export const RETRY_DELAYS_MS = [2 * 60_000, 10 * 60_000, 60 * 60_000];
/** Automatic retries stop this long after the first pass (the rest of the day). */
export const RETRY_WINDOW_MS = 10 * 3600_000;
/** A fresh WhatsApp page needs this long before members are removed (the group list is complete by then). */
export const STABLE_BEFORE_CLEANUP_MS = 2 * 60_000;

/** When to retry after pass number `attempts` (1 = the first), or null once the window is over. */
export function nextRetryAt(attempts: number, now: number, until: number): number | null {
  const at = now + RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1];
  return at <= until ? at : null;
}

/** Clearing waits until WhatsApp answers (the health watchdog) and has been up a couple of minutes. */
export const canClearNow = (s: { healthy: boolean; stableMs: number }) => s.healthy && s.stableMs >= STABLE_BEFORE_CLEANUP_MS;

const digits = (id: string) => id.split("@")[0].split(":")[0].replace(/\D/g, "");

/** A group member as the worker reads it: every id WhatsApp knows for them, and their phone number when it is known. */
export interface CleanupMember {
  /** Raw ids: the @lid and/or the @c.us. The first one is tried first when removing. */
  ids: string[];
  /** Digits of the phone number, null when it can't be resolved (an @lid WhatsApp won't map). */
  phone: string | null;
  isAdmin: boolean;
}

export interface CleanupPlan {
  /** Positively identified, nobody keeps them: safe to remove. */
  remove: CleanupMember[];
  /** Members left alone because we can't tell who they are ("skipped: unknown id"). */
  unknown: CleanupMember[];
  kept: number;
}

/**
 * Who leaves the group: everyone except POCs, regulars, co-hosts, admins, you, and next week's lineup. People are matched by
 * phone digits across every id form (@c.us, @lid, comic ids, a comic's chat id), because the roster, the group and WhatsApp
 * each use a different one. Anyone who can't be positively identified is never removed.
 */
export function planCleanup(input: {
  members: CleanupMember[];
  /** Comic ids that stay: regulars, co-hosts, POCs, next week's lineup. */
  stay: string[];
  /** The roster, so a stayer's phone and chat id count too. */
  comics: Pick<Comic, "id" | "chatId" | "phone">[];
  /** The curator's own ids (@c.us and @lid). */
  self: string[];
}): CleanupPlan {
  const keys = new Set<string>();
  const add = (x: string | undefined | null) => {
    const d = digits(x ?? "");
    if (d) keys.add(d);
  };
  const stay = new Set(input.stay);
  for (const id of input.stay) add(id);
  for (const c of input.comics) if (stay.has(c.id)) comicChatKeys(c).forEach(add);
  input.self.forEach(add);
  const out: CleanupPlan = { remove: [], unknown: [], kept: 0 };
  for (const m of input.members) {
    const mine = [...m.ids.map(digits), m.phone ?? ""].filter(Boolean);
    if (m.isAdmin || mine.some((k) => keys.has(k))) out.kept++;
    else if (!m.phone) out.unknown.push(m);
    else out.remove.push(m);
  }
  return out;
}

/** Why a removal didn't work, in words for the curator. Codes are WhatsApp's per-participant results. */
export function removeFailureReason(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const code = /\b(40[0-9]|50[0-9])\b/.exec(raw)?.[1] ?? (typeof (e as { code?: unknown })?.code === "number" ? String((e as { code: number }).code) : null);
  if (code === "403" || /not[- ]authori[sz]ed|forbidden|admin/i.test(raw)) return "WhatsApp doesn't allow it (you may not be an admin of this group)";
  if (code === "404" || /not[- ]found|not in (the )?group|not a participant/i.test(raw)) return "not found in the group";
  if (code === "409" || /conflict/i.test(raw)) return "WhatsApp refused it (conflict)";
  if (/lid/i.test(raw)) return "WhatsApp couldn't match their number";
  if (/timed out|timeout|ProtocolError|Target closed/i.test(raw)) return "WhatsApp didn't answer in time";
  return raw ? `WhatsApp said: ${raw.slice(0, 80)}` : "WhatsApp didn't remove them";
}

/** The Updates notice after a pass. `retryInMs`: the next automatic try, null when there won't be one. */
export function cleanupNotice(x: { show: string; removed: number; pending: CleanupPending[]; skipped: number; retryInMs: number | null; retry: boolean }): string {
  const label = (p: CleanupPending) => `${p.name ?? `+${digits(p.id)}`}: ${p.reason}`;
  const skip = x.skipped ? ` ${x.skipped} member${x.skipped === 1 ? "" : "s"} I couldn't identify ${x.skipped === 1 ? "was" : "were"} left alone.` : "";
  if (!x.pending.length) return x.retry ? `${x.show}: the rest are out now. The group is cleared for next week.${skip}` : `${x.show}: cleared the group for next week (${x.removed} removed).${skip}`;
  const list = x.pending.length > 5 ? `${x.pending.slice(0, 5).map(label).join("; ")}; and ${x.pending.length - 5} more` : x.pending.map(label).join("; ");
  const head = `${x.show}: ${x.retry ? `${x.removed} more removed, ` : `cleared the group for next week (${x.removed} removed), but `}${x.pending.length} couldn't be removed (${list}).`;
  const when = x.retryInMs === null ? " Not retrying any more; remove them by hand in WhatsApp." : ` Trying again ${x.retryInMs < 90_000 ? "in a minute" : `in about ${Math.round(x.retryInMs / 60_000)} min`}.`;
  return head + when + skip;
}
