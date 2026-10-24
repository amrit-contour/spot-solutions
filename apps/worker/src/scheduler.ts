// Once a minute or two, run the show-day group update for any confirmed show happening today.
import { localNow, type Lineup } from "@spot/shared";
import { col } from "./firebase.ts";
import { notice, runShowDaySync } from "./commands.ts";
import { sessions } from "./sessions.ts";
import { watchUser } from "./userData.ts";
import { expireOffers, sendMicChecks } from "./replies.ts";

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
      const client = sessions.get(uid);
      if (!client) continue;
      void tick(uid).catch((e) => console.error("[scheduler]", e));
      void expireOffers(uid).catch((e) => console.error("[offers]", e));
      void sendMicChecks(uid, client).catch((e) => console.error("[mic-check]", e));
    }
  }, TICK_MS).unref();
}
