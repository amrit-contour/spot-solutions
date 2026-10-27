// Scheduled posts in show groups (lineup, venue pin, reminders). Runs on the curator's own server from the scheduler tick,
// so there's no cloud scheduler to pay for. Each post goes out at most once per show date: the marker is written before
// sending, so a crash mid-send can't post twice into a group of fifty people.
import type WAWebJS from "whatsapp-web.js";
import { POST_LABEL, addDays, duePosts, groupPostMessage, groupPostVars, localNow, needsLineup, renderRich, usesVar, whenLabel, type GroupPost, type Lineup, type Show } from "@spot/shared";
import { col } from "./firebase.ts";
import { loadComics, notice } from "./commands.ts";
import { sendRich } from "./sendRich.ts";
import { watchUser } from "./userData.ts";
import { inVoice } from "./voice.ts";
import { pocTags } from "./groupCleanup.ts";
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
        await sendOne(uid, client, show, post, showDate, venues.find((v) => v.id === show.venueId));
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

async function sendOne(uid: string, client: WAWebJS.Client, show: Show, post: GroupPost, showDate: string, venue: Parameters<typeof groupPostVars>[1] & Parameters<typeof sendRich>[4]) {
  const { settings } = watchUser(uid);
  const ref = col(uid, "shows").doc(show.id);
  // Claim it first (see the top of the file). Re-read, since the cached show can lag our own write by a moment.
  const fresh = (await ref.get()).data() as Show | undefined;
  if (!fresh || fresh.groupPostsSent?.[post.id] === showDate) return;
  await ref.update({ [`groupPostsSent.${post.id}`]: showDate });

  const lineup = (await col(uid, "lineups").doc(lineupIdFor(show, showDate)).get()).data() as Lineup | undefined;
  const when = `${whenLabel(post.daysBefore).toLowerCase()} (${showDate})`;
  if (lineup?.backfilled) return;
  if (lineup && (lineup.status === "cancelled" || lineup.status === "canned")) return void console.log(`[group-post] ${show.name} ${when}: show is off, skipped`);

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
  console.log(`[group-post] ${uid} ${show.name}: ${POST_LABEL[post.template]} for ${showDate} sent`);
}
