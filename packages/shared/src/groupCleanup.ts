// After-show group cleanup: the day after a mic, thank the group and clear it for next week's comics. POCs, regulars,
// co-hosts, admins, you, and anyone already on next week's lineup stay. If the mic didn't happen (or the curator wants to
// decide each time), it asks first: the same comics may be repeating next week. Pure rules; the worker runs them.
import { addDays, type GroupPost } from "./groupPosts.ts";
import type { MessageOverride } from "./messages.ts";
import { comicChatKeys } from "./threads.ts";
import type { Comic, Lineup, Show } from "./types.ts";

export interface GroupCleanup {
  enabled: boolean;
  /** Old setting (auto: clear when the mic happened, ask when it didn't; ask: always ask). Read through cleanupRules; the editor drops it on the next save. */
  mode?: "auto" | "ask";
  /** If the mic happened. Missing: from `mode`, else "clear". */
  onHappened?: HappenedRule;
  /** If the mic didn't happen (it was meant to). Missing: from `mode`, else "repeat". */
  onDidnt?: DidntRule;
  /** If the show was called off in advance. Missing: from `mode`, else "repeat". */
  onCalledOff?: DidntRule;
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

/** What to do with the group when the mic happened: clear it on its own, ask the curator, or keep everyone. */
export type HappenedRule = "clear" | "ask" | "keep";
/** When it didn't happen or was called off: also "repeat" = decide by the lineup's "repeat next week" (repeat keeps everyone, don't repeat clears, undecided asks). */
export type DidntRule = "repeat" | "ask" | "keep" | "clear";
export type CleanupOutcome = "happened" | "didnt" | "calledOff";
export interface CleanupRules {
  happened: HappenedRule;
  didnt: DidntRule;
  calledOff: DidntRule;
}

export const DEFAULT_CLEANUP: GroupCleanup = { enabled: false, time: "11:00", onHappened: "clear", onDidnt: "repeat", onCalledOff: "repeat" };

/**
 * The three rules a show's cleanup follows. The old auto/ask `mode` still reads: auto = clear when it happened and decide by
 * repeat when it didn't; ask = ask in every case. A rule that is set always wins over `mode`.
 */
export function cleanupRules(c?: Pick<GroupCleanup, "mode" | "onHappened" | "onDidnt" | "onCalledOff"> | null): CleanupRules {
  const ask = c?.mode === "ask";
  return { happened: c?.onHappened ?? (ask ? "ask" : "clear"), didnt: c?.onDidnt ?? (ask ? "ask" : "repeat"), calledOff: c?.onCalledOff ?? (ask ? "ask" : "repeat") };
}

/** The cleanup setting with the three rules written out and the old `mode` gone (what the editor saves). */
export function withCleanupRules(c: GroupCleanup | null | undefined, patch: Partial<GroupCleanup> = {}): GroupCleanup {
  const base = c ?? DEFAULT_CLEANUP;
  const r = cleanupRules(base);
  const { mode: _old, ...rest } = base;
  return { ...rest, onHappened: r.happened, onDidnt: r.didnt, onCalledOff: r.calledOff, ...patch };
}

/**
 * How the lineup ended, for the cleanup: "calledOff" (cancelled in advance), "didnt" (meant to happen, didn't), "happened", or null
 * while the mic check is unanswered. `micCheckOn`: without mic checks there's never an answer, so a confirmed show counts as happened.
 */
export function cleanupOutcome(lineup: Pick<Lineup, "status" | "outcome">, micCheckOn: boolean): CleanupOutcome | null {
  if (lineup.status === "cancelled") return "calledOff";
  if (lineup.outcome === "canned" || lineup.status === "canned") return "didnt";
  if (lineup.outcome === "happened" || (!micCheckOn && lineup.status === "confirmed")) return "happened";
  return null;
}

/** What the rules say to do: clear (run), keep everyone, ask the curator, or ask the repeat question (its answer decides). */
export type CleanupDecision = "run" | "keep" | "ask" | "askRepeat";

export function cleanupDecision(rules: CleanupRules, outcome: CleanupOutcome, repeatNext: boolean | null | undefined): CleanupDecision {
  const rule = outcome === "happened" ? rules.happened : outcome === "didnt" ? rules.didnt : rules.calledOff;
  switch (rule) {
    case "clear":
      return "run";
    case "keep":
      return "keep";
    case "ask":
      return "ask";
    case "repeat":
      return repeatNext === true ? "keep" : repeatNext === false ? "run" : "askRepeat";
  }
}

/** The labels the show editor offers for each rule (value, words). */
export const HAPPENED_RULE_OPTIONS: { value: HappenedRule; label: string }[] = [
  { value: "clear", label: "Clear automatically" },
  { value: "ask", label: "Ask me" },
  { value: "keep", label: "Keep everyone" },
];
export const DIDNT_RULE_OPTIONS: { value: DidntRule; label: string }[] = [
  { value: "repeat", label: "Decide by 'repeat next week'" },
  { value: "ask", label: "Ask me" },
  { value: "keep", label: "Keep everyone" },
  { value: "clear", label: "Clear anyway" },
];

/** The three rules in plain words, for under the show editor's rows. */
export function cleanupSummary(r: CleanupRules): string {
  const happened = { clear: "clears the group", ask: "asks you first", keep: "keeps everyone" }[r.happened];
  const off = (x: DidntRule) => ({ repeat: "follows 'repeat next week'", ask: "asks you first", keep: "keeps everyone", clear: "clears the group anyway" })[x];
  const offText = r.didnt === r.calledOff ? `Didn't happen or called off: ${off(r.didnt)}.` : `Didn't happen: ${off(r.didnt)}. Called off: ${off(r.calledOff)}.`;
  const tail = r.didnt === "repeat" || r.calledOff === "repeat" ? " Repeat keeps everyone, don't repeat clears, undecided asks you." : "";
  return `Mic happened: ${happened}. ${offText}${tail}`;
}

/** The rule that applies to a show that didn't happen or was called off, for a lineup in that state (null: it happened or isn't known). */
export function offRuleFor(show: { cleanup?: GroupCleanup | null }, lineup: Pick<Lineup, "status" | "outcome">): DidntRule | null {
  const o = cleanupOutcome(lineup, true);
  if (o !== "didnt" && o !== "calledOff") return null;
  const r = cleanupRules(show.cleanup);
  return o === "didnt" ? r.didnt : r.calledOff;
}

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
  /**
   * Why it asked: the show didn't happen (or was called off) and the rule is "ask" ("canned"), the happened rule is "ask" ("ask"), or
   * the rule is "decide by repeat next week" and that isn't answered yet ("repeat": the repeat answer settles it, see cleanupStep).
   */
  reason?: "canned" | "ask" | "repeat";
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

/** run: clear it. keep: keep everyone (no question). ask: ask "clear the group?". askRepeat: ask "repeat next week?" (the answer decides). */
export type CleanupStep = "run" | "ask" | "askRepeat" | "keep" | "skip" | "retry";

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
 * the cleanup is turned on asking in every case for it.
 */
export function migrateCleanupTrigger<T extends { cleanup?: GroupCleanup | null; groupPosts?: GroupPost[] | null }>(show: T): { cleanup: GroupCleanup; groupPosts: GroupPost[] } | null {
  const posts = show.groupPosts ?? [];
  if (!posts.some((p) => p.after?.removeComics)) return null;
  const cur = show.cleanup ?? DEFAULT_CLEANUP;
  const first = posts.find((p) => p.enabled && p.after?.removeComics) ?? posts.find((p) => p.after?.removeComics)!;
  const ask = { onHappened: "ask", onDidnt: "ask", onCalledOff: "ask" } as const;
  const cleanup: GroupCleanup = cur.afterPostId === undefined ? withCleanupRules(cur, { enabled: true, afterPostId: first.id, ...(cur.enabled ? {} : ask) }) : withCleanupRules(cur);
  const groupPosts = posts.map((p) => {
    if (!p.after?.removeComics) return p;
    const { removeComics: _drop, ...rest } = p.after;
    return { ...p, after: Object.keys(rest).length ? rest : null };
  });
  return { cleanup, groupPosts };
}

/**
 * What to do now for this lineup, or null for nothing yet. The show's three rules (happened / didn't happen / called off) pick the
 * answer, see cleanupDecision. `micCheckOn`: without mic checks there's never an answer, so a confirmed show counts as having happened.
 * A cleanup waiting on the repeat answer ("asked", reason "repeat") settles itself once the lineup's repeatNext is set: repeat keeps
 * everyone, don't repeat clears.
 */
export function cleanupStep(
  show: Pick<Show, "groupId" | "cleanup" | "active" | "groupPosts">,
  lineup: Pick<Lineup, "date" | "status" | "outcome" | "cleanup"> & { backfilled?: boolean; repeatNext?: boolean | null },
  now: { date: string; time: string },
  micCheckOn: boolean,
  nowMs: number = Date.now(),
): CleanupStep | null {
  const c = show.cleanup;
  if (lineup.backfilled) return null; // a past show recorded afterwards: the group was never ours to clear
  // A pass that left people behind: try again when it's time (retryAt is cleared while a retry runs, and when it gives up).
  if (lineup.cleanup?.status === "partial") return lineup.cleanup.retryAt && lineup.cleanup.retryAt <= nowMs ? "retry" : null;
  // Asked "repeat next week?" and the answer has come (in the app or on WhatsApp): that is the clean-up's answer too.
  if (lineup.cleanup?.status === "asked" && lineup.cleanup.reason === "repeat") {
    if (!c?.enabled || !show.groupId) return null;
    return lineup.repeatNext === true ? "keep" : lineup.repeatNext === false ? "run" : null;
  }
  if (!c?.enabled || !show.groupId || !lineup.date || lineup.cleanup) return null;
  if (lineup.status !== "confirmed" && lineup.status !== "canned" && lineup.status !== "cancelled") return null;
  const day = addDays(lineup.date, 1);
  if (now.date < day || (now.date === day && now.time < c.time)) return null;
  if (now.date > addDays(lineup.date, CLEANUP_WINDOW_DAYS)) return "skip";
  const outcome = cleanupOutcome(lineup, micCheckOn);
  if (!outcome) return null; // waiting for the mic check answer
  if (outcome === "happened" && cleanupTriggerPost(show)) return null; // the chosen post starts it when it goes out (a show that didn't happen never waits on it)
  return cleanupDecision(cleanupRules(c), outcome, lineup.repeatNext);
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
