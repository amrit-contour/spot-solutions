// "Scan past messages": the curator picks a number of days, we read their recent 1:1 chats with the local model and
// fill Requests with any spot asks from that period. Read-only toward WhatsApp: no acks, no drafts, no messages.
// Locked requests (placed, confirmed, closed, dismissed) are never touched. Progress and cancel go through the command doc.
import {
  burstGapMs,
  burstWeek,
  clampScanDays,
  isLockedRequest,
  planScanMerge,
  rolloverDayFor,
  scanHold,
  scanNeedsReading,
  splitBursts,
  type Comic,
  type InboundMessage,
  type SpotRequest,
} from "@spot/shared";
import { col, db } from "./firebase.ts";
import { classify } from "./gemma.ts";
import { classifyContext, countPriorRequests } from "./classifyContext.ts";
import { isDirectHumanMessage, resolveContact } from "./intake.ts";
import { AiPolicyError } from "./aiRouting.ts";
import { sessions } from "./sessions.ts";
import { watchUser } from "./userData.ts";
import { dropNeverRead } from "./neverRead.ts";
import { decideMembership } from "./membership.ts";

const MAX_CHATS = 300;
const MESSAGES_PER_CHAT = 150;
/** Breathing room between model calls: a 4B model on a laptop shouldn't be hammered. */
const PAUSE_MS = 400;
const DAY_MS = 86_400_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 1:1 chats with traffic since `cutoff`. Skips groups, your own chat, broadcast/status and newsletters. */
async function recentChats(uid: string, client: ReturnType<typeof sessions.require>, cutoff: number) {
  const me = client.info?.wid?._serialized;
  // Never read chats are dropped before any of their messages are fetched.
  return (await dropNeverRead(uid, client, await client.getChats()))
    .filter((c) => !c.isGroup && !c.isReadOnly && ["c.us", "lid"].includes(c.id.server) && c.id._serialized !== me && c.timestamp * 1000 >= cutoff)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_CHATS);
}

export async function scanHistory(uid: string, payload: Record<string, unknown>, commandId?: string) {
  const client = sessions.require(uid);
  const { settings, shows } = watchUser(uid);
  const days = clampScanDays(payload.days, clampScanDays(settings.scanDays));
  const cutoff = Date.now() - days * DAY_MS;

  // Cheap look for the sheet's estimate: when each chat last had traffic, nothing else.
  if (payload.preview) {
    const chats = await recentChats(uid, client, Date.now() - 21 * DAY_MS);
    return { chatTimes: chats.map((c) => c.timestamp * 1000) };
  }

  const cmdRef = commandId ? col(uid, "commands").doc(commandId) : null;
  const cancelled = async () => Boolean(cmdRef && (await cmdRef.get()).data()?.cancel === true);
  const writeProgress = (p: { chats: number; done: number; found: number }) => cmdRef?.update({ progress: p }).catch(() => undefined);

  const activeShows = shows.filter((s) => s.active);
  const rollover = rolloverDayFor(shows);
  const gap = burstGapMs(settings.debounceSeconds);
  const chats = await recentChats(uid, client, cutoff);

  const out = { chatsScanned: 0, burstsChecked: 0, requestsCreated: 0, requestsUpdated: 0, held: 0, failed: 0, cancelled: false };
  const progress = { chats: chats.length, done: 0, found: 0 };
  await writeProgress(progress);

  chats: for (const chat of chats) {
    if (await cancelled()) {
      out.cancelled = true;
      break;
    }
    try {
      const msgs = (await chat.fetchMessages({ limit: MESSAGES_PER_CHAT }).catch(() => [])).filter((m) => m.timestamp * 1000 >= cutoff && isDirectHumanMessage(m));
      out.chatsScanned++;
      if (msgs.length) {
        const contact = await resolveContact(client, msgs[0], uid);
        // Banks, telcos, delivery apps: never read as requests.
        if (!contact.isBusiness) {
          const inbound: InboundMessage[] = msgs.map((m) => ({ id: m.id._serialized, body: m.body.slice(0, 1000), at: m.timestamp * 1000 }));
          for (const burst of splitBursts(inbound, gap)) {
            if (await cancelled()) {
              out.cancelled = true;
              break chats;
            }
            out.burstsChecked++;
            const week = burstWeek(burst, settings.timezone, rollover);
            const reqRef = col(uid, "requests").doc(`${week}_${contact.id}`);
            const before = (await reqRef.get()).data() as SpotRequest | undefined;
            if (!scanNeedsReading(before, burst)) continue;

            const comicRef = col(uid, "comics").doc(contact.id);
            const known = (await comicRef.get()).data() as Comic | undefined;
            const prior = known ? await countPriorRequests(uid, contact.id, week) : 0;
            const intent = await classify(uid, burst.map((m) => m.body), activeShows, settings.ai, classifyContext(uid, known, week, prior));
            console.log(`[scan] ${contact.name}: spot=${intent.isSpotRequest} conf=${intent.confidence} (${intent.model})`);

            // Same membership decision as live intake: already on the lineup and in the group needs no request.
            const membership = isLockedRequest(before) ? null : await decideMembership(uid, intent, known, contact, week);
            if (membership?.kind === "confirmed") continue;

            const result = await db.runTransaction(async (tx) => {
              const [reqSnap, comicSnap] = await Promise.all([tx.get(reqRef), tx.get(comicRef)]);
              const existing = reqSnap.data() as SpotRequest | undefined;
              const comic = comicSnap.data() as Comic | undefined;
              const plan = planScanMerge({ existing, burst, intent });
              if (plan.action === "skip") return null;
              const now = Date.now();
              if (plan.action === "update") {
                tx.update(reqRef, { messages: plan.messages, intent: plan.intent, updatedAt: now });
                return { action: "update" as const, held: Boolean(existing?.hold && !existing.holdOverridden) };
              }
              const hold = scanHold({ comic, week, burst, rules: settings.rules, timeZone: settings.timezone, membership });
              if (!comic) {
                const c: Comic = { id: contact.id, chatId: contact.chatId, name: contact.name, nameSource: contact.nameSource, phone: contact.phone, lastPerformedWeek: null, regularOf: [] };
                tx.set(comicRef, c);
              }
              const request: SpotRequest = {
                id: reqRef.id,
                comicId: contact.id,
                comicName: contact.name,
                weekOf: week,
                messages: plan.messages,
                intent: plan.intent,
                status: "new",
                ackedAt: null,
                hold,
                holdOverridden: false,
                firstContact: !comic,
                priorRequests: prior,
                createdAt: now,
                updatedAt: now,
              };
              tx.set(reqRef, request);
              return { action: "create" as const, held: Boolean(hold) };
            });
            if (result) {
              if (result.action === "create") out.requestsCreated++;
              else out.requestsUpdated++;
              if (result.held) out.held++;
              progress.found++;
            }
            await sleep(PAUSE_MS);
          }
        }
      }
    } catch (e) {
      // No local model means every later burst would fail too: stop and tell the curator.
      if (e instanceof AiPolicyError) throw e;
      out.failed++;
      console.error(`[scan] ${uid} ${chat.id._serialized} failed`, e);
    }
    progress.done++;
    await writeProgress(progress);
  }
  await writeProgress(progress);
  console.log(`[scan] ${uid} ${days}d: ${JSON.stringify(out)}`);
  return out;
}
