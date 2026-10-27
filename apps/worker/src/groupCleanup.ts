// The day after a show: thank the group and clear it for next week (groupCleanup.ts in shared has the rules). Runs from the
// scheduler on the curator's own server. When the mic didn't happen, or the show is set to ask, it asks first: in the app
// (an Updates card) and, with the agent number linked, on WhatsApp ("yes" clears, "no" keeps them for next week).
import type WAWebJS from "whatsapp-web.js";
import { addDays, cleanupRemovals, cleanupStep, confirmPending, groupPostVars, localNow, messageRich, normalizeMessage, renderRich, shiftWeek, type Lineup, type LineupCleanup, type Show } from "@spot/shared";
import { col } from "./firebase.ts";
import { lidMap, loadComics, normaliseParticipants, notice } from "./commands.ts";
import { askCurator } from "./agentOutbox.ts";
import { deliverableId, enqueueTask } from "./sendQueue.ts";
import { sendRich } from "./sendRich.ts";
import { watchUser } from "./userData.ts";
import { listGroupMembers } from "./people.ts";

const running = new Set<string>();
/** The agent's question stays answerable this long (the curator may see it hours later). */
const ASK_TTL_MS = 12 * 3600_000;

/** POCs as WhatsApp tags: "@<id>" in the text and their ids for `mentions`. Unknown numbers are left out. */
export async function pocTags(uid: string, client: WAWebJS.Client, show: Pick<Show, "pocs">): Promise<{ text: string; mentions: string[] }> {
  const ids = show.pocs ?? [];
  if (!ids.length) return { text: "", mentions: [] };
  const comics = await loadComics(uid, ids);
  const mentions: string[] = [];
  for (const id of ids) {
    const c = comics.get(id);
    const target = await deliverableId(client, c?.chatId ?? id);
    if (target) mentions.push(target);
  }
  return { text: mentions.map((m) => `@${m.split("@")[0]}`).join(", "), mentions };
}

export async function runCleanups(uid: string, client: WAWebJS.Client | undefined) {
  const { settings, shows } = watchUser(uid);
  if (!shows.some((s) => s.cleanup?.enabled && s.groupId)) return;
  const now = localNow(new Date(), settings.timezone);
  const recent = await col(uid, "lineups").where("date", ">=", addDays(now.date, -4)).get();
  for (const doc of recent.docs) {
    const lineup = { ...(doc.data() as Lineup), id: doc.id };
    const show = shows.find((s) => s.id === lineup.showId);
    if (!show) continue;
    const step = cleanupStep(show, lineup, now, settings.micCheck.enabled);
    if (!step || (step === "run" && !client)) continue; // clearing needs the main WhatsApp; asking does not
    const key = `${uid}|${doc.id}`;
    if (running.has(key)) continue;
    running.add(key);
    try {
      if (step === "skip") await doc.ref.update({ cleanup: { status: "skipped", at: Date.now() } satisfies LineupCleanup });
      else if (step === "ask") await ask(uid, show, lineup);
      else if (client) await clearGroup(uid, client, show, lineup);
    } catch (e) {
      console.error(`[cleanup] ${uid} ${show.name}`, e);
      await doc.ref.update({ cleanup: { status: "skipped", at: Date.now() } satisfies LineupCleanup });
      await notice(uid, "warn", `${show.name}: couldn't clear the group (${(e as Error).message}). Check it by hand.`);
    } finally {
      running.delete(key);
    }
  }
}

export async function ask(uid: string, show: Show, lineup: Lineup & { id: string }) {
  const reason = lineup.outcome === "canned" || lineup.status === "canned" ? "canned" : "ask";
  await col(uid, "lineups").doc(lineup.id).update({ cleanup: { status: "asked", at: Date.now(), reason } satisfies LineupCleanup });
  const question =
    reason === "canned"
      ? `${show.name} on ${lineup.date} didn't happen. Should I still clear the group, or are the same comics repeating next week?`
      : `${show.name} on ${lineup.date} is done. Clear the group for next week?`;
  // The card above is the question. On the agent number too, as a yes/no it can act on (only when linked and on; a failed send
  // leaves the card standing). Never over something else it's waiting on.
  const pending = { ...confirmPending({ type: "cleanup", showId: show.id, lineupId: lineup.id }, question, Date.now()), expiresAt: Date.now() + ASK_TTL_MS };
  await askCurator(uid, `🧹 ${question}\nReply *yes* to clear it (POCs, regulars, co-hosts and admins stay), or *no* to keep everyone.`, pending);
}

/** Keep everyone: nothing changes in the group; the scheduled posts carry on for next week as usual. */
export async function keepGroup(uid: string, lineupId: string) {
  await col(uid, "lineups").doc(lineupId).update({ cleanup: { status: "kept", at: Date.now() } satisfies LineupCleanup });
}

/** Thank the group, then remove everyone who doesn't stay. Returns how many left and how many couldn't be removed. */
export async function clearGroup(uid: string, client: WAWebJS.Client, show: Show, lineup: Lineup & { id: string }): Promise<{ removed: number; failed: number }> {
  const { settings, venues } = watchUser(uid);
  const ref = col(uid, "lineups").doc(lineup.id);
  // Claimed first, so a restart halfway can't post the thank-you twice.
  await ref.update({ cleanup: { status: "done", at: Date.now() } satisfies LineupCleanup });
  const group = (await client.getChatById(show.groupId!)) as WAWebJS.GroupChat;
  const venue = venues.find((v) => v.id === show.venueId);

  const msg = show.cleanup?.message === "" ? null : normalizeMessage(show.cleanup?.message, messageRich(settings, "groupCleanup"));
  if (msg) await sendRich(client, show.groupId!, renderRich(msg, groupPostVars(show, venue, lineup.date)), {}, venue, { prerendered: true });

  // Anyone already placed on next week's show stays.
  const next = (await col(uid, "lineups").doc(`${shiftWeek(lineup.weekOf, 1)}_${show.id}`).get()).data() as Lineup | undefined;
  const nextWeek = next && next.status !== "cancelled" ? next.slots.map((s) => s.comicId) : [];
  const participants = (await normaliseParticipants(client, group)).filter((p) => p.id.endsWith("@c.us")); // never remove who we can't identify
  const toRemove = cleanupRemovals(participants, show, `${client.info.wid.user}@c.us`, nextWeek);
  const lidOf = await lidMap(client, group);
  let removed = 0;
  let failed = 0;
  for (const id of toRemove) {
    await enqueueTask(client, async () => {
      try {
        await group.removeParticipants([lidOf.get(id) ?? id]);
        removed++;
      } catch {
        failed++;
      }
    });
  }
  await ref.update({ cleanup: { status: "done", at: Date.now(), removed, failed } satisfies LineupCleanup });
  await listGroupMembers(uid, { showId: show.id }).catch(() => undefined);
  await notice(uid, failed ? "warn" : "info", `${show.name}: cleared the group for next week (${removed} removed${failed ? `, ${failed} couldn't be removed` : ""}).`, "lineup");
  console.log(`[cleanup] ${uid} ${show.name}: -${removed}${failed ? ` (${failed} failed)` : ""}`);
  return { removed, failed };
}
