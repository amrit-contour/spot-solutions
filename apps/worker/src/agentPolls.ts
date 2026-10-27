// What a vote on one of the agent's polls does. A tap is the same as typing the answer: the picked option becomes "yes", "no" or a
// number and goes through the same handlers as a message. A vote counts only while the question it belongs to is still waiting;
// anything else (answered, replaced, timed out) gets one "That question already closed", then silence. Dependencies are passed in
// so the tests wire fakes; agent.ts wires the real ones.
import { MIC_POLL_TTL_MS, logPoll, voteAnswer, type AskKind, type PollRecord } from "@spot/shared";
import type { AgentMemory } from "./agentOutbox.ts";

export interface VoteDeps {
  readMemory(): Promise<AgentMemory>;
  writeMemory(patch: Record<string, unknown>): Promise<unknown>;
  say(text: string): Promise<unknown>;
  now(): number;
  /** Handle the answer exactly as if the curator had typed `text` (for the kind of question the poll was). */
  answer(kind: AskKind, text: string): Promise<void>;
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
      return !rec.closed && now - rec.at < MIC_POLL_TTL_MS;
  }
}

/** One vote: `selected` is the option names the voter has ticked now (empty when they took their vote back). */
export async function applyVote(d: VoteDeps, pollId: string, selected: string[]): Promise<"answered" | "closed" | "ignored"> {
  const mem = await d.readMemory();
  const rec = mem.polls?.find((p) => p.id === pollId);
  if (!rec) return "ignored"; // not one of ours (or forgotten)
  const text = voteAnswer(rec, selected);
  if (text === null) return "ignored";
  if (!pollOpen(rec, mem, d.now())) {
    if (!rec.noted) {
      await d.writeMemory({ polls: logPoll(mem.polls, { ...rec, noted: true }) });
      await d.say(POLL_CLOSED);
    }
    return "closed";
  }
  await d.answer(rec.kind, text);
  return "answered";
}

/** A mic check was answered (by tap or by text): its polls stop counting. */
export async function closeMicPolls(d: Pick<VoteDeps, "readMemory" | "writeMemory">): Promise<void> {
  const mem = await d.readMemory();
  if (!mem.polls?.some((p) => p.kind === "mic" && !p.closed)) return;
  await d.writeMemory({ polls: mem.polls.map((p) => (p.kind === "mic" ? { ...p, closed: true } : p)) });
}
