// Scheduled posts in show groups (lineup, venue pin, reminders). Runs on the curator's own server from the scheduler tick,
// so there's no cloud scheduler to pay for. Each post goes out at most once per show date: the marker is written before
// sending, so a crash mid-send can't post twice into a group of fifty people.
import type WAWebJS from "whatsapp-web.js";
import { POST_LABEL, addDays, duePosts, evaluatePost, groupPostMessage, groupPostVars, localNow, minutesOverdue, needsLineup, renderRich, usesVar, whenLabel, type GroupPost, type GroupPostStatus, type Lineup, type Show } from "@spot/shared";
import { col } from "./firebase.ts";
import { loadComics, notice } from "./commands.ts";
import { sendRich } from "./sendRich.ts";
import { watchUser } from "./userData.ts";
import { inVoice } from "./voice.ts";
import { pocTags, startRemoval } from "./groupCleanup.ts";
import { logActivity } from "./activity.ts";

const running = new Set<string>();

/** The lineup doc for a show date: keyed by that week's Monday. */
const lineupIdFor = (show: Pick<Show, "id" | "weekday">, showDate: string) => `${addDays(showDate, -((show.weekday + 6) % 7))}_${show.id}`;

export async function sendGroupPosts(uid: string, client: WAWebJS.Client) {
  const { settings, shows, venues } = watchUser(uid);
  const now = localNow(new Date(), settings.timezone);
  for (const show of shows) {
    if (!show.active || !show.groupId || !show.groupPosts?.length) continue;
    for (const { post, showDate } of duePosts(show, now)) {
      const key = `${uid}|${show.id}|${post.id}|${showDate}`;
      if (running.has(key)) continue;
      running.add(key);
      try {
        await sendOne(uid, client, show, post, showDate, now, venues.find((v) => v.id === show.venueId));
      } catch (e) {
        console.error(`[group-post] ${uid} ${show.name} ${post.id}`, e);
        await notice(uid, "warn", `${show.name}: the ${POST_LABEL[post.template]} didn't go out (${(e as Error).message}). Post it from Messages → Groups.`);
        await logActivity(uid, lineupIdFor(show, showDate), { kind: "post", tone: "failed", text: `The ${POST_LABEL[post.template]} didn't go out`, detail: [(e as Error).message], ref: post.id });
      } finally {
        running.delete(key);
      }
    }
  }
}

async function sendOne(uid: string, client: WAWebJS.Client, show: Show, post: GroupPost, showDate: string, now: { date: string; time: string }, venue: Parameters<typeof groupPostVars>[1] & Parameters<typeof sendRich>[4]) {
  const { settings } = watchUser(uid);
  const ref = col(uid, "shows").doc(show.id);
  // Re-read, since the cached show can lag our own write by a moment.
  const fresh = (await ref.get()).data() as Show | undefined;
  if (!fresh || fresh.groupPostsSent?.[post.id] === showDate) return;

  const lineup = (await col(uid, "lineups").doc(lineupIdFor(show, showDate)).get()).data() as Lineup | undefined;
  const when = `${whenLabel(post.daysBefore).toLowerCase()} (${showDate})`;
  const label = POST_LABEL[post.template];
  const lineupId = lineup?.id ?? lineupIdFor(show, showDate);
  const setStatus = (state: GroupPostStatus["state"], text: string) => ref.update({ [`groupPostStatus.${post.id}`]: { showDate, state, text, at: Date.now() } satisfies GroupPostStatus });

  // "Send only if…": decided at send time. An answer that isn't in yet holds the post (not claimed) until the wait runs out.
  if (!lineup?.backfilled) {
    const v = evaluatePost(post, { lineup: lineup ?? null, slotCount: show.slotCount, micCheckOn: settings.micCheck.enabled, overdueMin: minutesOverdue(post, now) });
    if (!v.go && v.hold) {
      const cur = fresh.groupPostStatus?.[post.id];
      if (cur?.state !== "waiting" || cur.showDate !== showDate || cur.text !== v.reason) await setStatus("waiting", v.reason);
      return;
    }
    if (!v.go) {
      await ref.update({ [`groupPostsSent.${post.id}`]: showDate });
      await setStatus("skipped", v.reason);
      if (lineup) await logActivity(uid, lineupId, { kind: "post", tone: "info", text: `The ${label} wasn't posted`, detail: [v.reason], ref: post.id });
      return void console.log(`[group-post] ${show.name} ${when}: ${v.reason}`);
    }
  }
  // Claim it (see the top of the file).
  await ref.update({ [`groupPostsSent.${post.id}`]: showDate });
  if (lineup?.backfilled) return;
  if (fresh.groupPostStatus?.[post.id]?.state === "waiting") await setStatus("sent", "");

  const msg = groupPostMessage(settings, post);
  let names: string[] | null = null;
  if (needsLineup(msg)) {
    if (!lineup || lineup.status !== "confirmed" || !lineup.slots.length) {
      await notice(uid, "warn", `${show.name}: the ${POST_LABEL[post.template]} for ${showDate} waits for a confirmed lineup, so it wasn't posted. Confirm the lineup and post it from Messages → Groups.`);
      if (lineup) await logActivity(uid, lineup.id ?? lineupIdFor(show, showDate), { kind: "post", tone: "failed", text: `The ${POST_LABEL[post.template]} wasn't posted`, detail: ["It waits for a confirmed lineup"], ref: post.id });
      return;
    }
    const comics = await loadComics(uid, lineup.slots.map((s) => s.comicId));
    names = lineup.slots.map((s) => comics.get(s.comicId)?.name ?? "TBA");
  }
  const tags = usesVar(msg, "pocs") ? await pocTags(uid, client, show) : { text: "", mentions: [] };
  const vars = groupPostVars(show, venue, showDate, names, tags.text);
  const rendered = renderRich(msg, vars);
  if (rendered.kind === "text" && !rendered.body.trim() && !rendered.attachLocation && !rendered.image) return;
  const voiced = post.voice && rendered.kind === "text" && rendered.body.trim() ? { ...rendered, body: await inVoice(uid, "reply", rendered.body, { ...vars, name: "everyone" } as unknown as Record<string, string>) } : rendered;
  await sendRich(client, show.groupId!, voiced, {}, venue, { prerendered: true, mentions: tags.mentions, uid, imageRequired: true });
  if (lineup) await logActivity(uid, lineupIdFor(show, showDate), { kind: "post", tone: "done", text: `Posted the ${POST_LABEL[post.template]} in the group`, ref: post.id });
  if (post.after?.removeComics && lineup) await startRemoval(uid, client, show, { ...lineup, id: lineupId }, label);
  console.log(`[group-post] ${uid} ${show.name}: ${POST_LABEL[post.template]} for ${showDate} sent`);
}
