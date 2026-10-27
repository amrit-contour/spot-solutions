// Time budgets for the model calls a person is waiting on (Messages: "Summarise this chat", drafted replies). Pure, so the worker
// and the app agree and the numbers are tested. A slow local model (Gemma on a laptop) can need a minute or two on a long thread.
import type { ThreadMessage } from "./threads.ts";

/** One local-model attempt in the interactive path. Background work keeps its own, longer limit. */
export const AI_LOCAL_INTERACTIVE_MS = 150_000;
/** One cloud attempt. */
export const AI_CLOUD_INTERACTIVE_MS = 60_000;
/** The whole interactive job, queue wait included. When it runs out, the next route doesn't start. */
export const AI_INTERACTIVE_DEADLINE_MS = 240_000;
/** How long the app waits for that job: the deadline plus room for WhatsApp reads and the round trip. */
export const AI_APP_WAIT_MS = AI_INTERACTIVE_DEADLINE_MS + 60_000;
/** Never start a route with less than this left (it would only abort). */
export const AI_MIN_ATTEMPT_MS = 15_000;

/** The time one route may take, given when the job must finish. 0 means: don't start it. */
export function routeBudgetMs(provider: "ollama" | "gemini", deadlineAt: number, now: number): number {
  const cap = provider === "ollama" ? AI_LOCAL_INTERACTIVE_MS : AI_CLOUD_INTERACTIVE_MS;
  const left = deadlineAt - now;
  return left < AI_MIN_ATTEMPT_MS ? 0 : Math.min(cap, left);
}

/** Is this a timeout / abort (an AbortSignal.timeout firing, a fetch abort, a "timed out" message)? */
export function isTimeoutError(e: unknown): boolean {
  const x = e as { name?: string; message?: string; cause?: { name?: string } } | null;
  return Boolean(x && (x.name === "TimeoutError" || x.name === "AbortError" || x.cause?.name === "TimeoutError" || /abort|timed? ?out|too slow/i.test(x.message ?? "")));
}

/** What the curator reads when a model call fails: plain words, never "This operation was aborted". */
export function aiFailureMessage(provider: "ollama" | "gemini", e: unknown): string {
  if (isTimeoutError(e)) return provider === "ollama" ? "The local model took too long. Try again or use Gemini." : "Gemini took too long. Try again.";
  const msg = (e as Error)?.message ?? String(e);
  if (provider === "ollama" && /ECONNREFUSED|fetch failed/i.test(msg)) return "The local model isn't running. Start Ollama, or use Gemini.";
  return msg;
}

export const ASSIST_MAX_MESSAGES = 30;
export const ASSIST_MAX_CHARS = 6000;
export const ASSIST_MESSAGE_CHARS = 400;

/** The newest messages that fit: at most `maxMessages` and about `maxChars` of text, each message clipped. Oldest go first. */
export function trimForModel(messages: ThreadMessage[], { maxMessages = ASSIST_MAX_MESSAGES, maxChars = ASSIST_MAX_CHARS, perMessage = ASSIST_MESSAGE_CHARS } = {}): ThreadMessage[] {
  const out: ThreadMessage[] = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0 && out.length < maxMessages; i--) {
    const len = Math.min(messages[i].text.length, perMessage);
    if (out.length && chars + len > maxChars) break;
    chars += len;
    out.unshift(messages[i]);
  }
  return out;
}
