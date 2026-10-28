// The agent's questions remembered by WhatsApp message id (shared/agentMirror.ts has the rules). Everything that changes the list
// goes through one queue per account, so a tick, a vote and a send can't overwrite each other's writes.
import { addAsk, claimAsks, mirrorKey, type ActionPlan, type MirrorAsk, type MirrorClosed, type PendingAction } from "@spot/shared";
import { agentRef } from "./agentSession.ts";
import { col } from "./firebase.ts";

const chains = new Map<string, Promise<unknown>>();

/** Change the account's list of remembered asks. `f` gets the current list and returns the new one (or null: no change). */
export function mutateAsks(uid: string, f: (list: MirrorAsk[], now: number) => MirrorAsk[] | null): Promise<MirrorAsk[]> {
  const run = (chains.get(uid) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const cur = (((await agentRef(uid).get()).data() as { asks?: MirrorAsk[] } | undefined)?.asks ?? []) as MirrorAsk[];
    const next = f(cur, Date.now());
    if (!next) return cur;
    await agentRef(uid).set({ asks: next }, { merge: true });
    return next;
  });
  const tail = run.catch(() => undefined);
  chains.set(uid, tail);
  void tail.then(() => chains.get(uid) === tail && chains.delete(uid));
  return run;
}

export const readAsks = async (uid: string): Promise<MirrorAsk[]> => (((await agentRef(uid).get()).data() as { asks?: MirrorAsk[] } | undefined)?.asks ?? []) as MirrorAsk[];

/** Remember a question the agent just sent. Never throws: the question itself already went out. */
export async function registerAsk(uid: string, ask: Omit<MirrorAsk, "at">): Promise<void> {
  try {
    await mutateAsks(uid, (list, now) => addAsk(list, { ...ask, at: now }, now));
  } catch (e) {
    console.warn(`[agent] ${uid} couldn't remember a question for the app mirror:`, (e as Error).message);
  }
}

/**
 * The curator answered on WhatsApp: the matching asks are closed as answered there, so the app's later state change never
 * earns a reaction or a "done in the app" reply. Call BEFORE the answer is written to the lineup. Never throws.
 */
export async function claimOnWhatsApp(uid: string, match: (a: MirrorAsk) => boolean, result?: Pick<MirrorClosed, "result" | "what" | "verb">): Promise<void> {
  try {
    await mutateAsks(uid, (list, now) => (list.some((a) => !a.closed && match(a)) ? claimAsks(list, match, now, result) : null));
  } catch (e) {
    console.warn(`[agent] ${uid} couldn't mark a question answered on WhatsApp:`, (e as Error).message);
  }
}

/** The ask for this WhatsApp message id, if one is remembered. */
export const askByMsg = (list: MirrorAsk[] | undefined, msgId: string) => list?.find((a) => a.msgId === msgId);

/** What a plan being confirmed is mirrored as: the group cleanup, an ad hoc pick, marking the show, confirming the lineup. Other plans have no Updates counterpart. */
export function mirrorOfPlan(p: ActionPlan): Omit<MirrorAsk, "msgId" | "at"> | null {
  switch (p.type) {
    case "cleanup":
      return { key: mirrorKey.cleanup(p.lineupId), kind: "cleanup", lineupId: p.lineupId };
    case "adhoc_pick":
      return { key: mirrorKey.adhoc(p.roundId), kind: "adhoc", roundId: p.roundId, label: p.comicName };
    case "outcome":
      return { key: mirrorKey.plan("outcome", p.lineupId), kind: "plan", lineupId: p.lineupId };
    case "confirm":
      return { key: mirrorKey.plan("confirm", p.lineupId), kind: "confirm", lineupId: p.lineupId };
    default:
      return null;
  }
}

/** The mirror entry for a yes/no confirmation (a numbered list is not mirrored until a choice turns it into one). */
export const mirrorOfPending = (p: PendingAction) => (p.stage === "confirm" ? mirrorOfPlan(p.plan) : null);

/**
 * A ✅ from the curator on a message that forwarded notices: dismiss those notices in the app (read + dismissedAt, the fields the app's
 * Dismiss writes). Only notices: follow-ups and requests are decisions, not news. True when it was one of ours and something was dismissed.
 */
export async function dismissForwarded(uid: string, msgId: string): Promise<boolean> {
  const ask = askByMsg(await readAsks(uid), msgId);
  const notices = ask?.kind === "batch" && !ask.closed ? (ask.refs ?? []).filter((x) => x.c === "notices") : [];
  if (!ask || !notices.length) return false;
  // Answered here: close it first, so the app's change is not echoed back as a reaction.
  if (notices.length === ask.refs!.length) await claimOnWhatsApp(uid, (a) => a.key === ask.key, { result: "dismissed", what: "dismissed", verb: "Done" });
  const at = Date.now();
  for (const x of notices) await col(uid, "notices").doc(x.id).update({ read: true, dismissedAt: at });
  return true;
}
