// What a vote on one of the agent's polls does. A tap is the same as typing the answer: the picked option becomes "yes", "no" or a
// number and goes through the same handlers as a message. A vote counts only while the question it belongs to is still waiting;
// anything else (answered, replaced, timed out) gets one "That question already closed", then silence. Dependencies are passed in
// so the tests wire fakes; agent.ts wires the real ones.
import { MIC_POLL_TTL_MS, conflictText, judgeLateVote, logPoll, oppositeOf, ratingPollRef, voteAnswer, voteOverall, voteRepeat, voteReview, type AskKind, AGENT_CONFIRM_TTL_MS, CHANGE_WORD, type ChangeAsk, type LateWant, type MirrorAsk, type PollRecord, type SpotReview } from "@spot/shared";
import type { AgentMemory } from "./agentOutbox.ts";

export interface VoteDeps {
  readMemory(): Promise<AgentMemory>;
  writeMemory(patch: Record<string, unknown>): Promise<unknown>;
  say(text: string): Promise<unknown>;
  now(): number;
  /** Handle the answer exactly as if the curator had typed `text` (for the kind of question the poll was). `rec` is the poll, so a mic check answers ITS show. */
  answer(kind: AskKind, text: string, rec?: PollRecord): Promise<void>;
  /** This question is being answered here: close it on the app mirror so the app's later state change gets no reaction or reply. */
  claim?(pollId: string): Promise<void>;
  /** Save one comic's review (rating or attendance) on a lineup slot and the comic's history. Present where rating polls are wired. */
  review?(lineupId: string, comicId: string, review: SpotReview): Promise<boolean>;
  /** Save the show's overall rating. */
  overall?(lineupId: string, rating: number): Promise<boolean>;
  /** A comic's name, for the one-line note when two ratings were ticked. */
  nameOf?(comicId: string): Promise<string>;
  /** "Didn't happen" polls: the reasons ticked (the whole set), and the repeat-next-week answer (returns what to say). */
  why?(lineupId: string, reasons: string[]): Promise<boolean>;
  repeat?(lineupId: string, choice: "repeat" | "no" | "later"): Promise<string | null>;
}

export const POLL_CLOSED = "That question already closed. Ask me again if you still want it.";

/** Is the question this poll asked still waiting? */
export function pollOpen(rec: PollRecord, mem: AgentMemory & { comicPending?: { pollId?: string; expiresAt: number } | null }, now: number): boolean {
  switch (rec.kind) {
    case "pending":
      return mem.pending?.pollId === rec.id && mem.pending.expiresAt > now;
    case "comic":
      return mem.comicPending?.pollId === rec.id && mem.comicPending.expiresAt > now;
    case "side":
      return (mem.sideAsk as { pollId?: string } | null | undefined)?.pollId === rec.id && mem.sideAsk!.expiresAt > now;
    case "mic":
    case "command":
      return !rec.closed && now - rec.at < MIC_POLL_TTL_MS;
  }
}

const askOf = (mem: AgentMemory, pollId: string): MirrorAsk | undefined => mem.asks?.find((x) => x.msgId === pollId);

/** What a late vote wants, for the asks the app can already have answered. */
function wantOf(ask: MirrorAsk, text: string): LateWant {
  const yes = text === "yes";
  const no = text === "no";
  if (ask.kind === "mic" || ask.kind === "plan") return yes ? "happened" : no ? "canned" : null;
  if (ask.kind === "cleanup") return yes ? "cleared" : no ? "kept" : null;
  return null;
}

/** A vote on a question the app already answered: agree (nothing to say) or conflict (say what the app did and wait for "change"). */
async function lateVote(d: VoteDeps, ask: MirrorAsk, want: LateWant): Promise<"agreed" | "conflict"> {
  if (judgeLateVote(ask, want) === "agree") return "agreed";
  await d.say(conflictText(ask));
  const to = oppositeOf(ask.closed?.result);
  // Only a show's answer and a repeat answer can be switched by a word; a cleared or kept group is changed in the app.
  if (to && ask.lineupId && (ask.kind === "mic" || ask.kind === "plan" || ask.kind === "repeat")) {
    const change: ChangeAsk = { key: ask.key, kind: ask.kind === "repeat" ? "repeat" : "mic", lineupId: ask.lineupId, to, at: d.now() };
    await d.writeMemory({ changeAsk: change });
  }
  return "conflict";
}

/** One vote: `selected` is the option names the voter has ticked now (empty when they took their vote back). */
export async function applyVote(d: VoteDeps, pollId: string, selected: string[]): Promise<"answered" | "closed" | "ignored" | "agreed" | "conflict"> {
  const mem = await d.readMemory();
  const rated = ratingPollRef(mem.ratingPolls, pollId, d.now());
  if (rated) {
    const r = await applyRatingVote(d, rated, selected, askOf(mem, pollId), pollId);
    return r === true ? "answered" : r === false ? "ignored" : r;
  }
  const rec = mem.polls?.find((p) => p.id === pollId);
  if (!rec) return "ignored"; // not one of ours (or forgotten)
  const text = voteAnswer(rec, selected);
  if (text === null) return "ignored";
  const ask = askOf(mem, pollId);
  // Already answered in the app: the same answer is fine; a different one is not changed behind the curator's back.
  if (ask?.closed && (ask.closed.by === "app" || ask.closed.result) && ["mic", "plan", "cleanup", "confirm"].includes(ask.kind)) {
    if (ask.kind === "confirm") return "agreed";
    return lateVote(d, ask, wantOf(ask, text));
  }
  if (!pollOpen(rec, mem, d.now())) {
    if (!rec.noted) {
      await d.writeMemory({ polls: logPoll(mem.polls, { ...rec, noted: true }) });
      await d.say(POLL_CLOSED);
    }
    return "closed";
  }
  await d.claim?.(pollId);
  if (rec.kind === "command") {
    // A suggestion from the morning message: one tap, once. "Later" (no text) just closes it.
    await d.writeMemory({ polls: logPoll(mem.polls, { ...rec, closed: true }) });
    if (text) await d.answer(rec.kind, text, rec);
    return "answered";
  }
  await d.answer(rec.kind, text, rec);
  return "answered";
}

/**
 * A vote on one of the rating polls (one per comic, plus the show overall). Counts at any time inside the poll's window, and a
 * changed vote replaces the earlier one: the current pick is the truth. Silent (the tap is the feedback). True when something was saved.
 */
async function applyRatingVote(d: VoteDeps, ref: { lineupId: string; comicId: string | null; kind?: "rate" | "why" | "repeat" }, selected: string[], ask: MirrorAsk | undefined, pollId: string): Promise<boolean | "conflict" | "agreed"> {
  if (ref.kind === "why") {
    await d.claim?.(pollId);
    return d.why ? d.why(ref.lineupId, selected) : false;
  }
  if (ref.kind === "repeat") {
    const c = voteRepeat(selected);
    if (!c || !d.repeat) return false;
    // The app already answered: the same answer is fine; a different one asks first. "Not decided" never overrides an answer.
    if (ask?.closed && (ask.closed.by === "app" || ask.closed.result) && ask.kind === "repeat") return c === "later" ? "agreed" : lateVote(d, ask, c);
    await d.claim?.(pollId);
    const said = await d.repeat(ref.lineupId, c);
    if (said) await d.say(said);
    return true;
  }
  // A rating just updates: a later vote replaces the earlier rating, whoever set it first. Not a conflict.
  await d.claim?.(pollId);
  if (ref.comicId === null) {
    const v = voteOverall(selected);
    return v && "rating" in v && d.overall ? d.overall(ref.lineupId, v.rating) : false;
  }
  if (!d.review) return false;
  const v = voteReview(selected);
  const ok = await d.review(ref.lineupId, ref.comicId, v.review);
  if (ok && v.multiple) await d.say(`Saved ${v.review.rating} for ${(await d.nameOf?.(ref.comicId)) ?? "them"} (you picked two ratings).`);
  return ok;
}

/** A mic check was answered (by tap or by text): its polls stop counting. */
export async function closeMicPolls(d: Pick<VoteDeps, "readMemory" | "writeMemory">, lineupId?: string): Promise<void> {
  const mem = await d.readMemory();
  // A mic check about one show closes that show's polls (and any from before polls knew their show); the others stay answerable.
  const mine = (p: PollRecord) => p.kind === "mic" && !p.closed && (!lineupId || !p.lineupId || p.lineupId === lineupId);
  if (!mem.polls?.some(mine)) return;
  await d.writeMemory({ polls: mem.polls.map((p) => (mine(p) ? { ...p, closed: true } : p)) });
}

export interface ChangeDeps {
  readMemory(): Promise<AgentMemory>;
  writeMemory(patch: Record<string, unknown>): Promise<unknown>;
  say(text: string): Promise<unknown>;
  now(): number;
  setOutcome(lineupId: string, outcome: "happened" | "canned"): Promise<unknown>;
  setRepeat(lineupId: string, choice: "repeat" | "no"): Promise<string | null>;
  /** Remember the new answer as given on WhatsApp, so the next late vote is judged against it. */
  reclose(key: string, result: string, what: string): unknown;
}

/** The word "change" after "Already marked happened in the app. Reply *change* to switch." True when the message was that word (and something was waiting for it). */
export async function applyChange(d: ChangeDeps, text: string): Promise<boolean> {
  if (!CHANGE_WORD.test(text)) return false;
  const c = (await d.readMemory()).changeAsk;
  if (!c) return false;
  await d.writeMemory({ changeAsk: null });
  if (d.now() - c.at > AGENT_CONFIRM_TTL_MS) return void (await d.say("That one timed out after 10 minutes, so I left it as it is.")), true;
  if (c.kind === "mic") {
    if (c.to !== "happened" && c.to !== "canned") return false;
    await d.setOutcome(c.lineupId, c.to);
    await d.reclose(c.key, c.to, c.to === "happened" ? "marked happened" : "marked didn't happen");
    await d.say(`Switched: marked ${c.to === "happened" ? "happened" : "didn't happen"} ✓`);
    return true;
  }
  const said = await d.setRepeat(c.lineupId, c.to === "repeat" ? "repeat" : "no");
  await d.reclose(c.key, c.to, c.to === "repeat" ? "Repeat" : "Don't repeat");
  await d.say(said ?? `Switched: ${c.to === "repeat" ? "Repeat" : "Don't repeat"} ✓`);
  return true;
}
