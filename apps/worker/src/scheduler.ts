// Every two minutes, on the curator's own server: the show-day group update, scheduled group posts, offers, mic checks.
// Everything time-based lives here rather than in a cloud scheduler, so it costs nothing to run.
import { localNow, type Lineup } from "@spot/shared";
import { col } from "./firebase.ts";
import { notice, runShowDaySync } from "./commands.ts";
import { logActivity } from "./activity.ts";
import { sessions } from "./sessions.ts";
import { agentSessions } from "./agentSession.ts";
import { agentTick } from "./agent.ts";
import { fleet } from "./fleet.ts";
import { watchUser } from "./userData.ts";
import { expireOffers, sendMicChecks } from "./replies.ts";
import { maybeCheckFollowUps } from "./followUp.ts";
import { sendGroupPosts } from "./groupPosts.ts";
import { runCleanups } from "./groupCleanup.ts";
import { startGroupWatch } from "./groupWatch.ts";
import { maybeTickAsks } from "./asks.ts";
import { maybePhotoSweep } from "./profilePics.ts";

const TICK_MS = 2 * 60_000;
const running = new Set<string>();

async function tick(uid: string) {
  const { settings, shows } = watchUser(uid);
  const now = localNow(new Date(), settings.timezone);
  const today = await col(uid, "lineups").where("date", "==", now.date).where("status", "==", "confirmed").get();
  for (const doc of today.docs) {
    const lineup = doc.data() as Lineup;
    const show = shows.find((s) => s.id === lineup.showId);
    if (lineup.backfilled) continue; // a recorded past show: history only
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
      await logActivity(uid, doc.id, { kind: "sync", tone: "failed", text: "The show-day group update failed", detail: [(e as Error).message] });
      await notice(uid, "warn", `${show.name}: the show-day group update failed (${(e as Error).message}). Check the group by hand.`);
    } finally {
      running.delete(key);
    }
  }
}

export function startScheduler(uids: () => Iterable<string>) {
  // Nothing BOT Comedy: spot alerts from the groups a comic watches (its own listener on each ready WhatsApp session).
  startGroupWatch(uids);
  setInterval(() => {
    for (const uid of uids()) {
      // The agent number's own notices and morning digest (it runs wherever the account's lease is held).
      if (agentSessions.get(uid)) void agentTick(uid).catch((e) => console.error("[agent]", e));
      const client = sessions.get(uid);
      // Questions for the curator (mic check, day-after cleanup ask) go to Updates and the agent even when the main WhatsApp is down.
      // Only on the server that holds the account, so two servers never ask twice.
      if (client || fleet.holds(uid)) {
        void sendMicChecks(uid, client).catch((e) => console.error("[mic-check]", e));
        void runCleanups(uid, client).catch((e) => console.error("[cleanup]", e));
      }
      if (!client) continue;
      void tick(uid).catch((e) => console.error("[scheduler]", e));
      void expireOffers(uid).catch((e) => console.error("[offers]", e));
      void maybeCheckFollowUps(uid, client).catch((e) => console.error("[follow-up]", e));
      void sendGroupPosts(uid, client).catch((e) => console.error("[group-post]", e));
      void maybeTickAsks(uid, client).catch((e) => console.error("[asks]", e));
      void maybePhotoSweep(uid).catch((e) => console.error("[pics-sweep]", e.message));
    }
  }, TICK_MS).unref();
}
