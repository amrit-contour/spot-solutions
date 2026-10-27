// What a curator message means, rules first (instant, free, works when the AI is down); the model only when the rules can't classify
// it. Which path was used is logged per message ("rules" or "model"), never the message itself.
import { ACTION_INTENTS, isQuestion, parseIntentByRules, type AgentIntent } from "@spot/shared";

export type IntentPath = "rules" | "model" | "none";

export const QUESTION_NOT_COMMAND = "I read that as a question, but I couldn't answer it. To change something, say it as an instruction, like \"mark Monday didn't happen\".";

/**
 * `model` is called only when no rule matches (and the agent may use it). A question is never turned into a change, whoever read it:
 * if the model picks an action for a question, it becomes "unknown" with a note instead.
 */
export async function curateIntent(text: string, model: (() => Promise<AgentIntent>) | null, log: (path: IntentPath, name: string) => void = () => undefined): Promise<{ intent: AgentIntent; questionNote?: boolean }> {
  const byRules = parseIntentByRules(text);
  if (byRules) {
    log("rules", byRules.name);
    // The rules refuse to make a change out of a question ("unknown" here means: it was a question shaped like a command).
    return byRules.name === "unknown" && isQuestion(text) ? { intent: byRules, questionNote: true } : { intent: byRules };
  }
  if (!model) {
    log("none", "unknown");
    return { intent: { name: "unknown" } };
  }
  const intent = await model();
  log("model", intent.name);
  if (isQuestion(text) && ACTION_INTENTS.includes(intent.name)) return { intent: { name: "unknown" }, questionNote: true };
  return { intent };
}
