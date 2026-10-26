// Every two minutes, on the curator's own server: the show-day group update, scheduled group posts, offers, mic checks.
// Everything time-based lives here rather than in a cloud scheduler, so it costs nothing to run.
import { localNow, type Lineup } from "@spot/shared";
import { col } from "./firebase.ts";
import { notice, runShowDaySync } from "./commands.ts";
import { sessions } from "./sessions.ts";
import { agentSessions } from "./agentSession.ts";
import { agentTick } from "./agent.ts";
import { watchUser } from "./userData.ts";
import { expireOffers, sendMicChecks } from "./replies.ts";
import { maybeCheckFollowUps } from "./followUp.ts";
import { sendGroupPosts } from "./groupPosts.ts";
import { runCleanups } from "./groupCleanup.ts";

const TICK_MS = 2 * 60_000;
const running = new Set<string>();

async function tick(uid: string) {
  const { settings, shows } = watchUser(uid);
  const now = localNow(new Date(), settings.timezone);
  const today = await col(uid, "lineups").where("date", "==", now.date).where("status", "==", "confirmed").get();
  for (const doc of today.docs) {
    const lineup = doc.data() as Lineup;
    const show = shows.find((s) => s.id === lineup.showId);
    if (!show?.active || !show.groupId || show.groupMode !== "show_day") continue;
    if (lineup.showDaySyncedOn === now.date || now.time < (show.showDaySyncTime ?? "12:00")) continue;
    const key = `${uid}|${doc.id}`;
    if (running.has(key)) continue;
    running.add(key);
    try {
      await runShowDaySync(uid, doc.id);
    } catch (e) {
      console.error(`[show-day] ${uid} ${show.name} failed`, e);
      await doc.ref.update({ showDaySyncedOn: now.date });
      await notice(uid, "warn", `${show.name}: the show-day group update failed (${(e as Error).message}). Check the group by hand.`);
    } finally {
      running.delete(key);
    }
  }
}

export function startScheduler(uids: () => Iterable<string>) {
  setInterval(() => {
    for (const uid of uids()) {
      // The agent number's own notices and morning digest (it runs wherever the account's lease is held).
      if (agentSessions.get(uid)) void agentTick(uid).catch((e) => console.error("[agent]", e));
      const client = sessions.get(uid);
      if (!client) continue;
      void tick(uid).catch((e) => console.error("[scheduler]", e));
      void expireOffers(uid).catch((e) => console.error("[offers]", e));
      void sendMicChecks(uid, client).catch((e) => console.error("[mic-check]", e));
      void maybeCheckFollowUps(uid, client).catch((e) => console.error("[follow-up]", e));
      void sendGroupPosts(uid, client).catch((e) => console.error("[group-post]", e));
      void runCleanups(uid, client).catch((e) => console.error("[cleanup]", e));
    }
  }, TICK_MS).unref();
}
