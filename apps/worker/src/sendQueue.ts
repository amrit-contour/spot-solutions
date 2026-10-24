// Outgoing messages go through one queue per client with human-ish jitter,
// so a lineup blast of 20 confirmations doesn't look like a bot to WhatsApp.
import type WAWebJS from "whatsapp-web.js";

const queues = new WeakMap<WAWebJS.Client, Promise<unknown>>();
const MIN_MS = Number(process.env.SEND_JITTER_MIN_MS ?? 3000);
const MAX_MS = Number(process.env.SEND_JITTER_MAX_MS ?? 8000);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const jitter = () => MIN_MS + Math.random() * (MAX_MS - MIN_MS);

export function enqueueTask<T>(client: WAWebJS.Client, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(client) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(async () => {
    const out = await task();
    await sleep(jitter());
    return out;
  });
  queues.set(client, next);
  return next;
}

export function sendQueued(client: WAWebJS.Client, to: string, body: string) {
  return enqueueTask(client, async () => {
    const chat = await client.getChatById(to);
    await chat.sendStateTyping();
    await sleep(Math.min(4000, 600 + body.length * 25));
    return client.sendMessage(to, body);
  });
}
