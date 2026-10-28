// Agent questions as WhatsApp polls (docs/agent.md): the same yes/no and numbered questions, tappable. A vote is turned into the text
// the curator could have typed ("yes", "no", "2"), so a tap and a typed answer go through exactly the same code.
import { POLL_MAX_OPTIONS, POLL_OPTION_MAX, POLL_QUESTION_MAX } from "./messages.ts";

/** One poll the agent can send: the options as shown, and for each the answer text it stands for. */
export interface AgentPollSpec {
  question: string;
  options: string[];
  answers: string[];
}

/** Which kind of question a poll belongs to: decides what a vote on it means and whether it is still open. */
export type AskKind = "pending" | "comic" | "side" | "mic" | "command";

/** What the agent remembers about a poll it sent (users/{uid}/session/agent `polls`, newest last, capped). */
export interface PollRecord {
  id: string;
  kind: AskKind;
  options: string[];
  answers: string[];
  at: number;
  /** Mic checks and command polls aren't kept as a pending question; set once one is answered. */
  closed?: boolean;
  /** "That question already closed" was said for this poll already. */
  noted?: boolean;
}
export const POLL_LOG_MAX = 20;
/** A mic check poll stays answerable this long (the question itself stays in the app's Updates). */
export const MIC_POLL_TTL_MS = 24 * 3_600_000;

const clean = (s: string) => s.replace(/\*/g, "").replace(/\s+/g, " ").trim();

/** The question part of an agent message: the text before its "Reply *yes* …" instruction, without WhatsApp bold marks. */
export function pollQuestionOf(text: string): string {
  return clean(text.split(/\s*\n?\s*Reply \*/)[0] ?? text);
}

type PendingLike =
  | { stage: "confirm"; summary: string; plan?: { type: string } }
  | { stage: "choose"; prompt: string; choices: { label: string }[] };

/** A confirmation becomes Yes/No; a numbered list becomes one option per name (2 to 12). null: keep the plain text question. */
export function pollForPending(p: PendingLike): AgentPollSpec | null {
  if (p.stage === "confirm") {
    const question = clean(p.summary);
    if (!question || question.length > POLL_QUESTION_MAX) return null;
    const t = p.plan?.type;
    const [yes, no] = t === "cleanup" ? ["Yes, clear it", "No, keep everyone"] : t === "adhoc_pick" ? ["Yes, add them", "No, cancel"] : ["Yes, do it", "No, cancel"];
    return { question, options: [yes, no], answers: ["yes", "no"] };
  }
  const options = p.choices.map((c) => clean(c.label));
  const question = clean(p.prompt);
  if (!question || question.length > POLL_QUESTION_MAX) return null;
  if (options.length < 2 || options.length > POLL_MAX_OPTIONS) return null;
  if (options.some((o) => !o || o.length > POLL_OPTION_MAX) || new Set(options.map((o) => o.toLowerCase())).size !== options.length) return null;
  return { question, options, answers: options.map((_, i) => String(i + 1)) };
}

/** A plain yes/no question (a mic check, "Did the show happen?"). */
export const yesNoPoll = (text: string): AgentPollSpec | null => {
  const question = pollQuestionOf(text);
  return question && question.length <= POLL_QUESTION_MAX ? { question, options: ["Yes", "No"], answers: ["yes", "no"] } : null;
};

/** "Curate or Comedy?" */
export const SIDE_POLL: AgentPollSpec = { question: "Your lineup (Curate) or your own spots (Comedy)?", options: ["Curate", "Comedy", "Cancel"], answers: ["1", "2", "no"] };

/** The answer text for the first option a vote picked (an empty vote, someone taking theirs back, answers nothing). */
export function voteAnswer(rec: Pick<PollRecord, "options" | "answers">, selected: string[]): string | null {
  const name = selected[0];
  if (name === undefined) return null;
  const i = rec.options.indexOf(name);
  return i < 0 ? null : (rec.answers[i] ?? null);
}

/** Add a poll to the log (newest last, capped). */
export const logPoll = (log: PollRecord[] | undefined, rec: PollRecord): PollRecord[] => [...(log ?? []).filter((p) => p.id !== rec.id), rec].slice(-POLL_LOG_MAX);
