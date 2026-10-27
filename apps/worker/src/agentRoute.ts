// Which side of the agent number a message belongs to. An account that uses only Curate gets only curation work, only Comedy only
// comedy work, both gets both (packages/shared/src/agentScope.ts decides who is which). This is the order things happen in; the real
// handlers (agent.ts for Curate, comicAgentCore.ts for Comedy) are handed in, so the tests wire fakes.
//   1. an unanswered "Curate or Comedy?" question, then a side's own waiting question (only a side the account uses reads its own),
//   2. help and hello: the commands of the apps the account uses,
//   3. one side only: that side, with a pointer if the message is plainly the other app's,
//   4. both: words only one side uses decide it; else the side whose rules read it; else, when it could be either, ask once;
//      when neither reads it, the model (Curate first, then Comedy).
import {
  NOT_USING_COMEDY,
  NOT_USING_CURATE,
  SIDE_QUESTION,
  SIDE_TTL_MS,
  agentHelpText,
  chooseSide,
  cueSide,
  parseComicIntentByRules,
  parseIntentByRules,
  parseSideChoice,
  type AgentScope,
  type Side,
  type SideAsk,
} from "@spot/shared";

export interface RouteHandlers {
  say(text: string): Promise<unknown>;
  now(): number;
  /** Asks "Curate or Comedy?" (a poll when the agent uses them). Absent: said as plain text. */
  askSide?(a: SideAsk): Promise<unknown>;
  readSideAsk(): Promise<SideAsk | null>;
  /** Writing a question clears any waiting yes/number of either side: one question at a time. */
  writeSideAsk(a: SideAsk | null): Promise<void>;
  curate: {
    /** A waiting yes / number / no of the curator's own. True when this message answered it. */
    answerPending(text: string): Promise<boolean>;
    /** A plain yes/no to the latest open mic check. True when handled. */
    micAnswer(text: string): Promise<boolean>;
    /** Rules, then (when allowed) the model. "unknown" when unreadable; nothing is said for that. */
    run(text: string): Promise<"done" | "unknown">;
  };
  comic: {
    answerPending(text: string): Promise<boolean>;
    byRules(text: string): Promise<boolean>;
    /** quiet: say nothing when the message can't be read. */
    byModel(text: string, o?: { quiet?: boolean }): Promise<boolean>;
  };
}

const HELP = /^(?:help|\?|menu|commands|hi|hello|hey|what can (?:you|i) (?:do|say)|what do you do|what can you do for me|how do (?:i|you) (?:use|work))$/i;

/** Rules-only reading, no side effects, for the routing decision. */
export const curateReads = (text: string) => parseIntentByRules(text) !== null;
export const comedyReads = (text: string, now: number) => parseComicIntentByRules(text, { today: new Date(now).toISOString().slice(0, 10), nowHHMM: "12:00" }) !== null;

export async function dispatch(scope: AgentScope, text: string, h: RouteHandlers): Promise<void> {
  const both = scope.curate && scope.comedy;
  const now = h.now();

  // 1. The side question.
  const sa = await h.readSideAsk();
  if (sa) {
    await h.writeSideAsk(null);
    const c = both ? parseSideChoice(text) : null;
    if (c && now > sa.expiresAt) return void (await h.say("That one timed out after 10 minutes, so nothing was changed. Ask me again if you still want it."));
    if (c === "cancel") return void (await h.say("Okay, cancelled. Nothing changed."));
    if (c) return runSide(c, sa.text);
    // anything else is a new message: the old question is dropped
  }
  if (scope.comedy && (await h.comic.answerPending(text))) return;
  if (scope.curate && (await h.curate.answerPending(text))) return;
  if (scope.curate && (await h.curate.micAnswer(text))) return;

  // 2. Help.
  if (HELP.test(text.trim())) return void (await h.say(agentHelpText(scope)));

  // 3. One side.
  const cu = curateReads(text);
  const co = comedyReads(text, now);
  const cue = cueSide(text);
  if (!both) {
    if (scope.curate) {
      if ((co || cue === "comedy") && !cu && cue !== "curate") return void (await h.say(NOT_USING_COMEDY + agentHelpText(scope)));
      return runSide("curate", text);
    }
    if ((cu || cue === "curate") && !co && cue !== "comedy") return void (await h.say(NOT_USING_CURATE + agentHelpText(scope)));
    return runSide("comedy", text);
  }

  // 4. Both.
  const choice = chooseSide(text, { curate: cu, comedy: co });
  if (choice === "curate" || choice === "comedy") return runSide(choice, text);
  if (choice === "ask") {
    const ask = { text, createdAt: now, expiresAt: now + SIDE_TTL_MS };
    await h.writeSideAsk(ask);
    return void (await (h.askSide ? h.askSide(ask) : h.say(SIDE_QUESTION)));
  }
  // Neither side's rules read it: the model, Curate first, then Comedy.
  if ((await h.curate.run(text)) === "done") return;
  if (await h.comic.byModel(text, { quiet: true })) return;
  await h.say(`I didn't get that.\n\n${agentHelpText(scope)}`);

  async function runSide(side: Side, t: string) {
    if (side === "curate") {
      if ((await h.curate.run(t)) === "unknown") await h.say(`I didn't get that.\n\n${agentHelpText(scope)}`);
      return;
    }
    if (await h.comic.byRules(t)) return;
    if (!(await h.comic.byModel(t))) await h.say(`I didn't get that.\n\n${agentHelpText(scope)}`);
  }
}
