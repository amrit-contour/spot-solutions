// Outgoing messages go through one queue per client with human-ish jitter,
// so a lineup blast of 20 confirmations doesn't look like a bot to WhatsApp.
import type WAWebJS from "whatsapp-web.js";
import { counters, live } from "./stats.ts";

const queues = new WeakMap<WAWebJS.Client, Promise<unknown>>();
const MIN_MS = Number(process.env.SEND_JITTER_MIN_MS ?? 3000);
const MAX_MS = Number(process.env.SEND_JITTER_MAX_MS ?? 8000);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const jitter = () => MIN_MS + Math.random() * (MAX_MS - MIN_MS);

export function enqueueTask<T>(client: WAWebJS.Client, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(client) ?? Promise.resolve();
  live.queueDelta(1); // waiting to go out; the console shows how many are pending
  const next = prev.catch(() => undefined).then(async () => {
    let out: T;
    try {
      out = await task();
    } finally {
      live.queueDelta(-1);
    }
    await sleep(jitter());
    return out;
  });
  queues.set(client, next);
  return next;
}

/** Current WhatsApp addresses most people by @lid; phone-based ids throw "No LID for user". */
export async function deliverableId(client: WAWebJS.Client, to: string) {
  if (!to.endsWith("@c.us")) return to;
  try {
    const [r] = await client.getContactLidAndPhone([to]);
    return r?.lid ?? to;
  } catch {
    return to;
  }
}

export type Sendable = string | WAWebJS.Poll | WAWebJS.Location;

/** Send one message (text, poll or pin) through the queue: typing pause, id fallbacks, counters. */
export function sendContent(client: WAWebJS.Client, to: string, content: Sendable, typeMs = 0, options?: WAWebJS.MessageSendOptions) {
  return enqueueTask(client, async () => {
    const target = await deliverableId(client, to);
    if (typeMs > 0) {
      const chat = await client.getChatById(target).catch(() => null);
      await chat?.sendStateTyping().catch(() => undefined);
      await sleep(Math.min(4000, 600 + typeMs * 25));
    }
    // Try the resolved id, then the raw id, then the raw digits as a lid (older records stored lids as @c.us).
    const candidates = [...new Set([target, to, to.replace(/@c\.us$/, "@lid")])];
    let last: unknown;
    for (const id of candidates) {
      try {
        const m = await client.sendMessage(id, content, options);
        counters.sent++;
        live.noteSent(client);
        return m;
      } catch (e) {
        last = e;
      }
    }
    live.noteError(client);
    throw last;
  });
}

export function sendQueued(client: WAWebJS.Client, to: string, body: string) {
  return sendContent(client, to, body, body.length);
}
