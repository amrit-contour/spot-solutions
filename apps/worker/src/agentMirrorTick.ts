// The app → WhatsApp half of the mirror (shared/agentMirror.ts): look at the questions the agent has asked, see which the curator
// already answered in the app, react ✅ to each original message and send ONE short quoted reply for all that happened within a
// minute of each other. Runs every 30 s from the scheduler. A poll can't be edited or voted on by the number that sent it, so the
// reaction plus the quoted reply is how "already done" shows. Never touches what was answered on WhatsApp itself.
import { MIRROR_REACTION, MIRROR_TTL_MS, closeByApp, composeDoneReply, findResolved, replyDue, type MirrorAsk, type MirrorFacts } from "@spot/shared";
import { col } from "./firebase.ts";
import { agentSessions } from "./agentSession.ts";
import { agentOn, quoteReplyToCurator, reactToCurator, readMemory, writeMemory } from "./agentOutbox.ts";
import { mirrorOfPending, mutateAsks, readAsks } from "./agentMirror.ts";

const running = new Set<string>();

/** What the app's state is now for the asks still open. Reads only what they point at. */
export async function gatherFacts(uid: string, open: MirrorAsk[]): Promise<MirrorFacts> {
  const facts: MirrorFacts = { lineups: {}, handled: {} };
  for (const id of new Set(open.flatMap((a) => (a.lineupId ? [a.lineupId] : [])))) facts.lineups[id] = (await col(uid, "lineups").doc(id).get()).data() as MirrorFacts["lineups"][string];
  if (open.some((a) => a.kind === "adhoc")) {
    const interested = await col(uid, "offers").where("status", "==", "interested").get();
    facts.openRounds = new Set(interested.docs.flatMap((d) => ((d.data() as { round?: { id: string } }).round?.id ? [(d.data() as { round: { id: string } }).round.id] : [])));
  }
  for (const r of open.flatMap((a) => a.refs ?? [])) {
    const d = (await col(uid, r.c).doc(r.id).get()).data() as { read?: boolean; status?: string; dismissedAt?: number } | undefined;
    if (!d) continue;
    facts.handled![`${r.c}:${r.id}`] = r.c === "notices" ? d.read === true || Boolean(d.dismissedAt) : d.status !== "pending" || Boolean(d.dismissedAt);
  }
  return facts;
}

export async function mirrorTick(uid: string): Promise<void> {
  if (!agentSessions.get(uid) || running.has(uid)) return;
  running.add(uid);
  try {
    const now = Date.now();
    const asks = await readAsks(uid);
    if (!asks.length) return;
    // 1. Which open questions has the app answered since the last look?
    const open = asks.filter((a) => !a.closed && now - a.at < MIRROR_TTL_MS);
    if (open.length) {
      const found = findResolved(open, await gatherFacts(uid, open), now);
      if (found.length) {
        await mutateAsks(uid, (list, t) => closeByApp(list, found, t));
        // A "yes/no" the agent was waiting on for exactly this is dropped, so a later "yes" can't act twice.
        const pending = (await readMemory(uid)).pending;
        const key = pending ? mirrorOfPending(pending)?.key : undefined;
        if (key && found.some((f) => f.ask.key === key)) await writeMemory(uid, { pending: null });
      }
    }
    if (!(await agentOn(uid, "notify"))) return;
    // 2. A ✅ on each original message.
    for (const a of (await readAsks(uid)).filter((x) => x.closed?.by === "app" && !x.reacted && now - x.at < MIRROR_TTL_MS)) {
      await reactToCurator(uid, a.msgId, MIRROR_REACTION);
      await mutateAsks(uid, (list) => list.map((x) => (x.key === a.key ? { ...x, reacted: true } : x)));
    }
    // 3. One quoted reply for everything answered in the app within the last minute.
    const due = replyDue(await readAsks(uid), Date.now());
    if (due.length) {
      const { text, quoteMsgId } = composeDoneReply(due);
      if (await quoteReplyToCurator(uid, quoteMsgId, text)) {
        const keys = new Set(due.map((a) => a.key));
        await mutateAsks(uid, (list) => list.map((x) => (keys.has(x.key) ? { ...x, replied: true } : x)));
      }
    }
  } catch (e) {
    console.warn(`[agent] ${uid} app-answer mirror failed:`, (e as Error).message);
  } finally {
    running.delete(uid);
  }
}
