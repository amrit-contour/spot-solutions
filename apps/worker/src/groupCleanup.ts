// The day after a show: thank the group and clear it for next week (groupCleanup.ts in shared has the rules). Runs from the
// scheduler on the curator's own server. When the mic didn't happen, or the show is set to ask, it asks first: in the app
// (an Updates card) and, with the agent number linked, on WhatsApp ("yes" clears, "no" keeps them for next week).
import type WAWebJS from "whatsapp-web.js";
import { RETRY_WINDOW_MS, addDays, canClearNow, cleanupAlreadyStarted, cleanupNotice, cleanupStep, confirmPending, groupPostVars, localNow, messageRich, nextRetryAt, normalizeMessage, planCleanup, renderRich, shiftWeek, type CleanupMember, type Lineup, type LineupCleanup, type Show } from "@spot/shared";
import { col } from "./firebase.ts";
import { loadComics, notice } from "./commands.ts";
import { removalPass, toPending, type GroupPort } from "./cleanupPass.ts";
import { sessions } from "./sessions.ts";
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
    if (!step || ((step === "run" || step === "retry") && !client)) continue; // clearing needs the main WhatsApp; asking does not
    // Only when WhatsApp answers (health watchdog) and has been up a couple of minutes: a page that just loaded may list a partial group.
    if ((step === "run" || step === "retry") && !canClearNow({ healthy: sessions.healthy(uid), stableMs: sessions.stableMs(uid) })) continue;
    const key = `${uid}|${doc.id}`;
    if (running.has(key)) continue;
    running.add(key);
    try {
      if (step === "skip") await doc.ref.update({ cleanup: { status: "skipped", at: Date.now() } satisfies LineupCleanup });
      else if (step === "ask") await ask(uid, show, lineup);
      else if (client) await clearGroup(uid, client, show, lineup, { retry: step === "retry" });
    } catch (e) {
      console.error(`[cleanup] ${uid} ${show.name}`, e);
      sessions.noteWaError(uid, e);
      if (step === "retry") {
        // A failed retry leaves the cleanup partial and tries again later; it never drops what is still pending.
        const c = lineup.cleanup;
        const attempts = (c?.attempts ?? 1) + 1;
        const retryAt = nextRetryAt(attempts, Date.now(), c?.until ?? 0);
        await doc.ref.update({ "cleanup.attempts": attempts, "cleanup.retryAt": retryAt });
        if (retryAt === null) await notice(uid, "warn", `${show.name}: couldn't finish clearing the group (${(e as Error).message}). Remove the rest by hand in WhatsApp.`, "lineup");
      } else {
        await doc.ref.update({ cleanup: { status: "skipped", at: Date.now() } satisfies LineupCleanup });
        await notice(uid, "warn", `${show.name}: couldn't clear the group (${(e as Error).message}). Check it by hand.`);
      }
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
  await askCurator(uid, `🧹 ${question}\nReply *yes* to clear it (POCs, regulars, co-hosts and admins stay), or *no* to keep everyone.`, pending, `${show.name} ${lineup.date}`);
}

/**
 * The show's cleanup, started by the post it is set to follow (Shows > clear the group > "After the thank-you post goes out"). Never silent: with the show's cleanup on automatic it clears the
 * group (no second thank-you, the post was one); otherwise, or when WhatsApp isn't steady, it asks the curator first (the Updates
 * card and the agent number's yes/no), the same review as the day-after cleanup. Once a cleanup exists for the show, nothing more.
 */
export async function startRemoval(uid: string, client: WAWebJS.Client, show: Show, lineup: Lineup & { id: string }, what: string) {
  // Same lock as the timed pass, so the two triggers (the chosen post and the set time) can't both start one.
  const key = `${uid}|${lineup.id}`;
  if (running.has(key)) return;
  running.add(key);
  try {
    await removalAfterPost(uid, client, show, lineup, what);
  } finally {
    running.delete(key);
  }
}

async function removalAfterPost(uid: string, client: WAWebJS.Client, show: Show, lineup: Lineup & { id: string }, what: string) {
  const fresh = ((await col(uid, "lineups").doc(lineup.id).get()).data() as Lineup | undefined) ?? lineup;
  if (cleanupAlreadyStarted(fresh) || !show.groupId) return;
  const auto = show.cleanup?.enabled && show.cleanup.mode === "auto" && canClearNow({ healthy: sessions.healthy(uid), stableMs: sessions.stableMs(uid) });
  try {
    if (auto) await clearGroup(uid, client, show, { ...fresh, id: lineup.id }, { noThanks: true });
    else await ask(uid, show, { ...fresh, id: lineup.id });
  } catch (e) {
    console.error(`[group-post] ${uid} ${show.name}: removal after the ${what} failed`, e);
    await notice(uid, "warn", `${show.name}: the ${what} went out, but clearing this week's comics from the group didn't start (${(e as Error).message}). Do it from the show's group.`);
  }
}

/**
 * Keep everyone: nothing changes in the group; the scheduled posts carry on for next week as usual. When the show didn't happen,
 * "keep" is the answer to "are the same comics repeating next week?", so the lineup is marked as repeating (post criteria read it).
 */
export async function keepGroup(uid: string, lineupId: string) {
  const ref = col(uid, "lineups").doc(lineupId);
  const lineup = (await ref.get()).data() as Lineup | undefined;
  const didntHappen = lineup?.cleanup?.reason === "canned" || lineup?.status === "canned" || lineup?.outcome === "canned";
  await ref.update({ cleanup: { status: "kept", at: Date.now() } satisfies LineupCleanup, ...(didntHappen ? { repeatNext: true } : {}) });
}

const digitsOf = (id: string) => id.split("@")[0].split(":")[0].replace(/\D/g, "");

/** Everyone in the group with every id form WhatsApp gives for them and their phone number where it can be resolved. */
export async function readCleanupMembers(client: WAWebJS.Client, groupId: string): Promise<CleanupMember[]> {
  const group = (await client.getChatById(groupId)) as WAWebJS.GroupChat;
  const raw = group.participants.map((p) => ({ id: p.id._serialized, isLid: p.id.server === "lid", isAdmin: Boolean(p.isAdmin || p.isSuperAdmin) }));
  const other = new Map<string, string>(); // lid <-> phone id, both directions
  for (let i = 0; i < raw.length; i += 100) {
    try {
      for (const r of await client.getContactLidAndPhone(raw.slice(i, i + 100).map((p) => p.id))) {
        if (r.lid && r.pn) {
          other.set(r.lid, r.pn);
          other.set(r.pn, r.lid);
        }
      }
    } catch {
      /* no mapping for this batch: those members stay unidentified unless they are phone ids */
    }
  }
  return raw.map((p) => {
    const mapped = other.get(p.id);
    const lid = p.isLid ? p.id : mapped?.endsWith("@lid") ? mapped : undefined;
    const pn = !p.isLid ? p.id : mapped?.endsWith("@c.us") ? mapped : undefined;
    const ids = [lid, pn].filter((x): x is string => Boolean(x)); // @lid first: it is what current WhatsApp addresses members by
    return { ids, phone: pn ? digitsOf(pn) || null : null, isAdmin: p.isAdmin };
  });
}

/**
 * Thank the group (first pass only), then remove everyone who doesn't stay. Returns how many left and how many couldn't be removed.
 * People it couldn't remove are kept on the lineup's cleanup (`pending`, with why) and retried (2 min, 10 min, hourly, the rest of
 * the day); `retry` is that later pass: no thank-you, a fresh read of the group.
 */
export async function clearGroup(uid: string, client: WAWebJS.Client, show: Show, lineup: Lineup & { id: string }, opts: { retry?: boolean; noThanks?: boolean } = {}): Promise<{ removed: number; failed: number }> {
  const { settings, venues } = watchUser(uid);
  const ref = col(uid, "lineups").doc(lineup.id);
  const prior = lineup.cleanup;
  const retry = Boolean(opts.retry);
  const t0 = Date.now();
  const until = retry ? (prior?.until ?? t0 + RETRY_WINDOW_MS) : t0 + RETRY_WINDOW_MS;
  // Claimed first, so a restart halfway can't post the thank-you twice, and another server won't start a pass while this one runs.
  // "partial" with a retryAt a few minutes out: if this server dies mid-pass, the retry picks it up (it never thanks the group again).
  if (retry) await ref.update({ "cleanup.retryAt": t0 + 10 * 60_000 });
  else await ref.set({ cleanup: { status: "partial", at: t0, attempts: 0, until, retryAt: t0 + 10 * 60_000, pending: [], removed: 0, failed: 0 } satisfies LineupCleanup }, { merge: true });
  const venue = venues.find((v) => v.id === show.venueId);

  if (!retry && !opts.noThanks) {
    const msg = show.cleanup?.message === "" ? null : normalizeMessage(show.cleanup?.message, messageRich(settings, "groupCleanup"));
    if (msg) await sendRich(client, show.groupId!, renderRich(msg, groupPostVars(show, venue, lineup.date)), {}, venue, { prerendered: true, uid });
  }

  // Anyone already placed on next week's show stays.
  const next = (await col(uid, "lineups").doc(`${shiftWeek(lineup.weekOf, 1)}_${show.id}`).get()).data() as Lineup | undefined;
  const nextWeek = next && next.status !== "cancelled" ? next.slots.map((s) => s.comicId) : [];
  const stay = [...new Set([...(show.regulars ?? []), ...(show.protected ?? []), ...(show.pocs ?? []), ...nextWeek])];
  const comics = await loadComics(uid, stay);
  const info = client.info as { wid: { user: string; _serialized: string }; lid?: { _serialized?: string } };
  const self = [`${info.wid.user}@c.us`, info.wid._serialized, info.lid?._serialized ?? ""].filter(Boolean);

  const members = await readCleanupMembers(client, show.groupId!);
  const plan = planCleanup({ members, stay, comics: [...comics.entries()].map(([id, c]) => ({ id, chatId: c.chatId, phone: c.phone })), self });
  for (const m of plan.unknown) console.log(`[cleanup] ${uid} ${show.name}: skipped: unknown id ${m.ids.join(",")}`);
  const port: GroupPort = {
    read: () => readCleanupMembers(client, show.groupId!),
    remove: (id) =>
      enqueueTask(client, async () => {
        const group = (await client.getChatById(show.groupId!)) as WAWebJS.GroupChat;
        await group.removeParticipants([id]);
      }),
  };
  const pass = await removalPass(port, plan.remove, (m) => console.log(`[cleanup] ${uid} ${show.name}: ${m}`));
  const removed = (prior?.removed ?? 0) + pass.removed.length;

  const names = new Map<string, string>();
  const leftIds = pass.left.map((l) => l.member.phone && `${l.member.phone}@c.us`).filter((x): x is string => Boolean(x));
  for (const [id, c] of await loadComics(uid, leftIds)) names.set(id, c.name);
  const pending = toPending(pass.left, names);
  const attempts = (prior?.attempts ?? 0) + 1;
  const retryAt = pending.length ? nextRetryAt(attempts, Date.now(), until) : null;
  const state: LineupCleanup = pending.length
    ? { status: "partial", at: t0, removed, failed: pending.length, pending, retryAt, attempts, until, skipped: plan.unknown.length }
    : { status: "done", at: t0, removed, failed: 0, attempts, skipped: plan.unknown.length };
  await ref.update({ cleanup: state });
  await listGroupMembers(uid, { showId: show.id }).catch(() => undefined);
  const retryInMs = retryAt === null ? null : retryAt - Date.now();
  // A retry that removed nobody new and still has the same people says nothing (the first notice already did), until it gives up.
  const quiet = retry && !pass.removed.length && retryAt !== null;
  if (!quiet) await notice(uid, pending.length ? "warn" : "info", cleanupNotice({ show: show.name, removed: pass.removed.length, pending, skipped: plan.unknown.length, retryInMs, retry }), "lineup");
  console.log(`[cleanup] ${uid} ${show.name}: -${pass.removed.length}${pending.length ? ` (${pending.length} left: ${pending.map((p) => `${p.id} ${p.reason}`).join("; ")})` : ""}`);
  return { removed: pass.removed.length, failed: pending.length };
}
