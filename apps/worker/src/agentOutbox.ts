// Everything the agent number sends goes through here: one place that checks it is linked, switched on, has the curator's number,
// stays inside the rate limits, and uses the send queue (typing, jitter). It only ever addresses the curator's own number.
import WAWebJS from "whatsapp-web.js";
import { logPoll, pollForPending, yesNoPoll, resolvePlaceholders, type AgentPollSpec, type AskKind, type PollRecord, AGENT_BATCH_MAX_MS, AGENT_BATCH_QUIET_MS, AGENT_REPLIES_PER_HOUR, AGENT_UNPROMPTED_PER_HOUR, composeNotifyRich, rateCheck, type AgentSettings, type NotifyItem, type ActionPlan, type PendingAction, type SideAsk, type Settings } from "@spot/shared";
import { sessionRef, userRef } from "./firebase.ts";
import { agentRef, agentSessions } from "./agentSession.ts";
import { deliverableId, sendContent, sendQueued } from "./sendQueue.ts";
import { settingsFromDoc } from "./userData.ts";

/** What the agent remembers between messages, in users/{uid}/session/agent (owner-readable, worker-written). */
export interface AgentMemory {
  pending?: PendingAction | null;
  /** "Curate or Comedy?", asked of an account that uses both when a message could mean either. */
  sideAsk?: SideAsk | null;
  /** Polls the agent sent (newest last): what a vote on each one means. See agentPolls.ts. */
  polls?: PollRecord[];
  lastDigestOn?: string | null;
  /** How far the new-request, follow-up and notice scans have got (epoch ms). Moves only after a successful send. */
  cursor?: { requests?: number; actions?: number; notices?: number };
}

export async function readMemory(uid: string): Promise<AgentMemory> {
  return ((await agentRef(uid).get()).data() ?? {}) as AgentMemory;
}
export const writeMemory = (uid: string, patch: Record<string, unknown>) => agentRef(uid).set(patch, { merge: true });

const memo = new Map<string, { at: number; s: Settings }>();
/** The account's settings read fresh (30 s cache): the agent must not depend on the per-session cache, which restarts with the main WhatsApp. */
export async function readSettings(uid: string): Promise<Settings> {
  const hit = memo.get(uid);
  if (hit && Date.now() - hit.at < 30_000) return hit.s;
  const s = settingsFromDoc((await userRef(uid).get()).data()?.settings);
  memo.set(uid, { at: Date.now(), s });
  return s;
}
export const forgetSettings = (uid: string) => void memo.delete(uid);

/** The curator's own number: the account's linked WhatsApp (never anything the agent was told in a message). */
export async function curatorPhone(uid: string): Promise<string | null> {
  const p = (await sessionRef(uid).get()).data()?.phone;
  return typeof p === "string" && p ? p : null;
}

/** Is the agent linked and ready on this server, and has the curator left it on? */
export async function agentOn(uid: string, part?: keyof Pick<AgentSettings, "notify" | "answer" | "actions" | "digest">): Promise<boolean> {
  if (!agentSessions.get(uid)) return false;
  const a = (await readSettings(uid)).agent;
  return Boolean(a?.enabled && (!part || a[part]));
}

const sentAt = new Map<string, number[]>();
/** One reservation per send, so concurrent callers can't both slip under the cap. */
function reserve(uid: string, unprompted: boolean) {
  const key = `${uid}:${unprompted ? "u" : "r"}`;
  const r = rateCheck(sentAt.get(key) ?? [], Date.now(), unprompted ? AGENT_UNPROMPTED_PER_HOUR : AGENT_REPLIES_PER_HOUR);
  if (!r.ok) {
    sentAt.set(key, r.sent);
    return false;
  }
  sentAt.set(key, [...r.sent, Date.now()]);
  return true;
}

/**
 * Send one message to the curator's own number from the agent. False when it can't or mustn't (not linked, switched off, no
 * number, rate limit): callers decide whether that matters. `unprompted` is for things the agent starts (notices, digest);
 * replies to the curator have a higher cap.
 */
export async function sendToCurator(uid: string, text: string, o: { unprompted?: boolean; ignoreSwitch?: boolean; /** Real WhatsApp mentions: raw ids behind the "@<number>" placeholders in `text`, and the same reply as plain first names. */ mentions?: { ids: string[]; plain: string } } = {}): Promise<boolean> {
  const client = agentSessions.get(uid);
  if (!client) return false;
  if (!o.ignoreSwitch && !(await readSettings(uid)).agent?.enabled) return false;
  const phone = await curatorPhone(uid);
  if (!phone) return false;
  if (!reserve(uid, Boolean(o.unprompted))) {
    console.warn(`[agent] ${uid} rate limit reached; dropped a ${o.unprompted ? "notice" : "reply"}`);
    return false;
  }
  const to = `${phone}@c.us`;
  const tag = o.mentions?.ids.length && (await readSettings(uid)).agent?.agentTagPeople !== false ? o.mentions : null;
  if (tag) {
    try {
      const map = await Promise.all(tag.ids.map(async (raw) => ({ raw, resolved: await deliverableId(client, raw) })));
      await sendContent(client, to, resolvePlaceholders(text, map), text.length, { mentions: map.map((m) => m.resolved) });
      return true;
    } catch (e) {
      // Mentions can fail in a 1:1 chat; the same answer goes once more as plain first names.
      console.warn(`[agent] ${uid} send with mentions failed, resending plain:`, (e as Error).message);
      await sendQueued(client, to, tag.plain);
      return true;
    }
  }
  await sendQueued(client, to, o.mentions?.plain ?? text);
  return true;
}

/**
 * Ask a question: as a one-answer poll when `poll` is given and the account hasn't turned polls off, otherwise (or when the poll
 * can't be sent) as the plain text, which always works too. Returns the poll's message id when a poll went out, null when the text did,
 * and undefined when nothing was sent (not linked, off, rate limit). A poll is remembered so a vote can be matched to its question.
 */
export async function sendQuestion(uid: string, text: string, o: { poll: AgentPollSpec | null; kind: AskKind; unprompted?: boolean }): Promise<string | null | undefined> {
  if (o.poll && (await readSettings(uid)).agent?.agentPolls !== false) {
    const id = await sendPoll(uid, o.poll, Boolean(o.unprompted)).catch((e) => {
      console.warn(`[agent] ${uid} poll failed, asking in text instead:`, (e as Error).message);
      return null;
    });
    if (id) {
      const mem = await readMemory(uid);
      await writeMemory(uid, { polls: logPoll(mem.polls, { id, kind: o.kind, options: o.poll.options, answers: o.poll.answers, at: Date.now() }) });
      return id;
    }
  }
  return (await sendToCurator(uid, text, { unprompted: o.unprompted })) ? null : undefined;
}

/** The poll message id, or null when it can't go out here (the caller then sends text). Throws when WhatsApp refuses it. */
async function sendPoll(uid: string, spec: AgentPollSpec, unprompted: boolean): Promise<string | null> {
  const client = agentSessions.get(uid);
  if (!client) return null;
  if (!(await readSettings(uid)).agent?.enabled) return null;
  const phone = await curatorPhone(uid);
  if (!phone || !reserve(uid, unprompted)) return null;
  const m = await sendContent(client, `${phone}@c.us`, new WAWebJS.Poll(spec.question, spec.options, { allowMultipleAnswers: false, messageSecret: undefined }), spec.question.length);
  return (m as { id?: { _serialized?: string } } | undefined)?.id?._serialized ?? null;
}

// ---- batching: several things that happen close together become one message ----
interface Batch {
  items: NotifyItem[];
  firstAt: number;
  lastAt: number;
  /** Cursors to persist once this batch is sent. */
  cursor: NonNullable<AgentMemory["cursor"]>;
}
const batches = new Map<string, Batch>();

export function queueNotify(uid: string, item: NotifyItem, cursor: NonNullable<AgentMemory["cursor"]> = {}) {
  const now = Date.now();
  const b = batches.get(uid) ?? { items: [], firstAt: now, lastAt: now, cursor: {} };
  b.items.push(item);
  b.lastAt = now;
  b.cursor = { ...b.cursor, ...cursor };
  batches.set(uid, b);
}
/** Items still waiting to be sent (so a rescan doesn't queue the same thing twice). */
export const queuedCount = (uid: string) => batches.get(uid)?.items.length ?? 0;

/** Send the batch if it has been quiet for a while (or has waited long enough). Call from the scheduler tick. */
export async function flushNotify(uid: string, force = false): Promise<"none" | "waiting" | "sent" | "failed"> {
  const b = batches.get(uid);
  if (!b?.items.length) return "none";
  const now = Date.now();
  if (!force && now - b.lastAt < AGENT_BATCH_QUIET_MS && now - b.firstAt < AGENT_BATCH_MAX_MS) return "waiting";
  const rich = composeNotifyRich(b.items);
  batches.delete(uid);
  if (!rich) return "none";
  const ok = await sendToCurator(uid, rich.text, { unprompted: true, mentions: { ids: rich.mentions, plain: rich.plain } }).catch((e) => {
    console.warn(`[agent] ${uid} notice failed:`, (e as Error).message);
    return false;
  });
  // Advance the scans only when it went out (or was deliberately dropped by a switch), so a failed send is retried from the cursor.
  if (ok) await writeMemory(uid, { cursor: b.cursor });
  return ok ? "sent" : "failed";
}

/**
 * Route a mic check to the agent when it is linked with notices on. Returns true when the agent sent it, so the caller skips
 * the old "Message yourself" chat. Mic checks go out alone (the curator answers yes/no to this exact message).
 */
export async function sendMicCheck(uid: string, text: string): Promise<boolean> {
  if (!(await agentOn(uid, "notify"))) return false;
  const r = await sendQuestion(uid, text, { poll: yesNoPoll(text), kind: "mic", unprompted: true }).catch(() => undefined);
  return r !== undefined;
}

// ---- questions: the app's Updates item is the source of truth, the agent just asks the same thing ----

/**
 * Ask the curator a question on the agent number as well. The Updates item (state in Firestore) is written by the caller FIRST and
 * never depends on this: it does nothing when the agent isn't linked or is off, never throws when the send fails, and never talks
 * over a question the agent is already waiting on. `pending` is stored only once the message actually went out.
 */
export async function askCurator(uid: string, text: string, pending?: PendingAction): Promise<boolean> {
  try {
    if (!(await agentOn(uid, "notify"))) return false;
    if (pending) {
      const mem = await readMemory(uid);
      if (mem.pending && mem.pending.expiresAt > Date.now()) return false;
    }
    const pollId = await sendQuestion(uid, text, { poll: pending ? pollForPending(pending) : null, kind: "pending", unprompted: true });
    if (pollId === undefined) return false;
    if (pending) await writeMemory(uid, { pending: pollId ? { ...pending, pollId } : pending });
    return true;
  } catch (e) {
    console.warn(`[agent] ${uid} couldn't ask on WhatsApp (the question stays in Updates):`, (e as Error).message);
    return false;
  }
}

const plansOf = (p: PendingAction) => (p.stage === "confirm" ? [p.plan] : p.choices.map((c) => c.plan));

/**
 * The curator answered in the app. If the agent was waiting on exactly that question, clear it (a later "yes" must not redo it) and,
 * only then, say so in the agent chat. Anything else the agent is waiting on is left alone. Never throws.
 */
export async function resolvedInApp(uid: string, matches: (plan: ActionPlan) => boolean, text = "Done in the app, so I'm no longer waiting on that one."): Promise<boolean> {
  try {
    const p = (await readMemory(uid)).pending;
    if (!p || !plansOf(p).some(matches)) return false;
    await writeMemory(uid, { pending: null });
    if (p.expiresAt > Date.now() && (await agentOn(uid, "notify"))) await sendToCurator(uid, text, { unprompted: true }).catch(() => false);
    return true;
  } catch (e) {
    console.warn(`[agent] ${uid} couldn't clear a pending question:`, (e as Error).message);
    return false;
  }
}
