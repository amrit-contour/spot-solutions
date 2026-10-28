// Two-way mirror between the agent number's questions and the app's Updates (docs/agent.md). Every question the agent sends is
// remembered with its WhatsApp message id under a stable key (lineup id plus kind, or notice id). When the curator answers in
// the app, the worker sees the state change, reacts to the original message and sends one short quoted reply. WhatsApp polls
// can't be edited or voted on by their sender, so the reaction plus the quoted reply is how "already done" shows. Everything
// here is pure: the worker feeds it what it read from Firestore.
import { isRating } from "./showRatings.ts";
import type { Lineup } from "./types.ts";

export type MirrorKind = "mic" | "repeat" | "rate" | "overall" | "cleanup" | "adhoc" | "confirm" | "plan" | "batch";

/** A notice or follow-up the message was about. */
export interface MirrorRef {
  c: "notices" | "actions";
  id: string;
}

/** What it was answered with, so a late vote can be compared with it. */
export interface MirrorClosed {
  by: "app" | "whatsapp";
  at: number;
  /** Machine value: "happened" | "canned" | "repeat" | "no" | "kept" | "cleared" | "rated" | ... */
  result?: string;
  /** Words for the reply: "marked happened", "Repeat", "kept everyone". */
  what?: string;
  verb?: "Done" | "Answered";
}

export interface MirrorAsk {
  /** Stable: kind plus lineup (or round, comic, notice) id. Asking the same thing again replaces the entry. */
  key: string;
  /** The WhatsApp message id of the poll or question (what the reaction and the quoted reply go to). */
  msgId: string;
  kind: MirrorKind;
  at: number;
  lineupId?: string;
  comicId?: string | null;
  roundId?: string;
  refs?: MirrorRef[];
  /** For a grouped reply: "Tuesday Mic", "Rohan". */
  label?: string;
  closed?: MirrorClosed;
  reacted?: boolean;
  replied?: boolean;
}

export const MIRROR_TTL_MS = 3 * 86_400_000;
export const MIRROR_CAP = 80;
/** Resolutions that happen within this long of the first one share one reply. */
export const MIRROR_GROUP_MS = 60_000;
export const MIRROR_REACTION = "✅";
/** The most lines in one grouped reply. */
const MAX_LINES = 8;

export const mirrorKey = {
  mic: (lineupId: string) => `mic:${lineupId}`,
  repeat: (lineupId: string) => `repeat:${lineupId}`,
  rate: (lineupId: string, comicId: string) => `rate:${lineupId}:${comicId}`,
  overall: (lineupId: string) => `overall:${lineupId}`,
  cleanup: (lineupId: string) => `cleanup:${lineupId}`,
  adhoc: (roundId: string) => `adhoc:${roundId}`,
  confirm: (lineupId: string) => `confirm:${lineupId}`,
  plan: (type: string, id: string) => `plan:${type}:${id}`,
  /** One notice or follow-up: its own id. Several in one message: the message id. */
  notices: (refs: MirrorRef[], msgId: string) => (refs.length === 1 ? `${refs[0]!.c}:${refs[0]!.id}` : `batch:${msgId}`),
};

/** The list with this ask added (the same key replaces the older one) and expired or beyond-cap entries dropped. */
export function addAsk(list: MirrorAsk[] | undefined, ask: MirrorAsk, now: number): MirrorAsk[] {
  return [...(list ?? []).filter((a) => a.key !== ask.key && a.msgId !== ask.msgId), ask].filter((a) => now - a.at < MIRROR_TTL_MS).slice(-MIRROR_CAP);
}

/** Close the open asks that `match` picks as answered on WhatsApp itself: they never get a reaction or a reply. */
export function claimAsks(list: MirrorAsk[] | undefined, match: (a: MirrorAsk) => boolean, now: number, result?: Pick<MirrorClosed, "result" | "what" | "verb">): MirrorAsk[] {
  return (list ?? []).map((a) => (!a.closed && match(a) ? { ...a, closed: { by: "whatsapp" as const, at: now, ...result }, reacted: true, replied: true } : a));
}

// ---------------------------------------------------------------- what the app already answered

type LineupFacts = Pick<Lineup, "outcome" | "status" | "repeatNext" | "cleanup" | "slots" | "review">;
export interface MirrorFacts {
  lineups: Record<string, LineupFacts | undefined>;
  /** Ad hoc rounds that still have yeses waiting for a pick. Undefined: not read. */
  openRounds?: Set<string>;
  /** "notices:<id>" / "actions:<id>": true when it is read, dismissed or no longer pending. Absent: unknown. */
  handled?: Record<string, boolean>;
}

export interface Resolution {
  result: string;
  what: string;
  verb: "Done" | "Answered";
}

/** Has the question behind this ask been answered (in the app, or anywhere)? null: still open. */
export function resolution(a: MirrorAsk, f: MirrorFacts): Resolution | null {
  const l = a.lineupId ? f.lineups[a.lineupId] : undefined;
  switch (a.kind) {
    case "mic":
    case "plan": {
      if (!l?.outcome) return null;
      return { result: l.outcome, what: l.outcome === "happened" ? "marked happened" : "marked didn't happen", verb: "Done" };
    }
    case "repeat": {
      if (l?.repeatNext == null) return null;
      return l.repeatNext ? { result: "repeat", what: "Repeat", verb: "Answered" } : { result: "no", what: "Don't repeat", verb: "Answered" };
    }
    case "rate": {
      const s = l?.slots.find((x) => x.comicId === a.comicId);
      return s && isRating(s.rating) ? { result: "rated", what: `rated ${s.rating}`, verb: "Done" } : null;
    }
    case "overall":
      return l?.review && isRating(l.review.rating) ? { result: "rated", what: `rated ${l.review.rating}`, verb: "Done" } : null;
    case "cleanup": {
      const s = l?.cleanup?.status;
      if (s === "done") return { result: "cleared", what: "cleared the group", verb: "Done" };
      if (s === "kept") return { result: "kept", what: "kept everyone", verb: "Done" };
      return null;
    }
    case "adhoc":
      return a.roundId && f.openRounds && !f.openRounds.has(a.roundId) ? { result: "picked", what: "picked who got the spot", verb: "Done" } : null;
    case "confirm":
      return l?.status === "confirmed" ? { result: "confirmed", what: "confirmed", verb: "Done" } : null;
    case "batch": {
      const refs = a.refs ?? [];
      return refs.length && f.handled && refs.every((r) => f.handled![`${r.c}:${r.id}`] === true) ? { result: "dismissed", what: refs.length === 1 ? "dismissed" : `${refs.length} dismissed`, verb: "Done" } : null;
    }
  }
}

/** The open asks the app has answered, and what they were answered with. */
export function findResolved(list: MirrorAsk[], f: MirrorFacts, now: number): { ask: MirrorAsk; res: Resolution }[] {
  const out: { ask: MirrorAsk; res: Resolution }[] = [];
  for (const ask of list) {
    if (ask.closed || now - ask.at >= MIRROR_TTL_MS) continue;
    const res = resolution(ask, f);
    if (res) out.push({ ask, res });
  }
  return out;
}

/** Mark these asks answered in the app (reaction and reply are still to do). */
export function closeByApp(list: MirrorAsk[], found: { ask: MirrorAsk; res: Resolution }[], now: number): MirrorAsk[] {
  const by = new Map(found.map((x) => [x.ask.key, x.res]));
  return list.map((a) => {
    const r = by.get(a.key);
    return r && !a.closed ? { ...a, closed: { by: "app" as const, at: now, result: r.result, what: r.what, verb: r.verb } } : a;
  });
}

// ---------------------------------------------------------------- the quoted reply, grouped

/** Answered in the app, not yet replied to. */
export const owingReply = (list: MirrorAsk[]) => list.filter((a) => a.closed?.by === "app" && !a.replied);

/** Time to send the grouped reply: the oldest unreplied one has waited out the window, so anything closed meanwhile is in it. */
export function replyDue(list: MirrorAsk[], now: number): MirrorAsk[] {
  const owed = owingReply(list);
  if (!owed.length) return [];
  const first = Math.min(...owed.map((a) => a.closed!.at));
  return now - first >= MIRROR_GROUP_MS ? owed : [];
}

/**
 * One short reply for everything answered in the app in that minute. A single one reads "Done in the app: marked happened ✓"
 * (the quote already says which); several list one line each. It quotes the newest question.
 */
export function composeDoneReply(asks: MirrorAsk[]): { text: string; quoteMsgId: string } {
  const sorted = [...asks].sort((a, b) => a.closed!.at - b.closed!.at || a.at - b.at);
  const last = sorted[sorted.length - 1]!;
  if (sorted.length === 1) return { text: `${last.closed!.verb ?? "Done"} in the app: ${last.closed!.what ?? "handled"} ✓`, quoteMsgId: last.msgId };
  const line = (a: MirrorAsk) => `• ${a.label ? `${a.label}: ` : ""}${a.closed!.what ?? "handled"}`;
  const shown = sorted.slice(0, MAX_LINES).map(line);
  if (sorted.length > MAX_LINES) shown.push(`• +${sorted.length - MAX_LINES} more`);
  return { text: `Handled in the app ✓\n${shown.join("\n")}`, quoteMsgId: last.msgId };
}

// ---------------------------------------------------------------- a vote after the app already answered

/** What a late vote wants, in the same words as MirrorClosed.result. */
export type LateWant = "happened" | "canned" | "repeat" | "no" | "cleared" | "kept" | null;

/** A late vote on a question the app answered: agrees (say nothing) or conflicts (ask before changing anything). */
export function judgeLateVote(ask: Pick<MirrorAsk, "closed">, want: LateWant): "agree" | "conflict" {
  return !want || !ask.closed?.result || ask.closed.result === want ? "agree" : "conflict";
}

/** "Already marked happened in the app. Reply *change* to switch." (a cleanup can't be undone by a word, so it only informs). */
export function conflictText(ask: Pick<MirrorAsk, "closed" | "kind">): string {
  const what = ask.closed?.what ?? "answered";
  return ask.kind === "cleanup" ? `Already ${what} in the app. Change it there if that's not what you meant.` : `Already ${what} in the app. Reply *change* to switch.`;
}

/** What "change" switches to: the other answer. */
export const oppositeOf = (result: string | undefined): "happened" | "canned" | "repeat" | "no" | null => (result === "happened" ? "canned" : result === "canned" ? "happened" : result === "repeat" ? "no" : result === "no" ? "repeat" : null);

/** A waiting "reply *change*": the question it belongs to and what it would switch to. Open for AGENT_CONFIRM_TTL_MS. */
export interface ChangeAsk {
  key: string;
  kind: "mic" | "repeat";
  lineupId: string;
  to: "happened" | "canned" | "repeat" | "no";
  at: number;
}
export const CHANGE_WORD = /^\s*change\s*[.!]?\s*$/i;

/** A kept-open ask for a notice reaction: only the curator's own reactions on a batch message dismiss. */
export const DISMISS_REACTIONS = new Set(["✅", "👍", "☑️", "✔️"]);
