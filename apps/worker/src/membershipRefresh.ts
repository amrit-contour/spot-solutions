// Keeps each show's cached group member list fresh, so the membership check on spot pings never has to ask WhatsApp.
// Runs from the scheduler tick: every ~12h per group (with jitter), again 3h before a show on show day. One group at a time, spaced out.
import { groupRefreshDue, jitterOf, localNow, minutesToShowStart, type Show } from "@spot/shared";
import { col } from "./firebase.ts";
import { sessions } from "./sessions.ts";
import { watchUser } from "./userData.ts";
import { listGroupMembers } from "./people.ts";

const SPACING_MS = 5_000;
const SETTLE_MS = 60_000;
const running = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function refreshGroups(uid: string) {
  if (running.has(uid) || !sessions.stableFor(uid, SETTLE_MS)) return;
  running.add(uid);
  try {
    const { settings, shows } = watchUser(uid);
    const now = localNow(new Date(), settings.timezone);
    const today = new Date(`${now.date}T00:00:00Z`).getUTCDay() as Show["weekday"];
    for (const s of shows.filter((x) => x.active && x.groupId)) {
      if (!sessions.stableFor(uid, SETTLE_MS)) return;
      const cache = ((await col(uid, "shows").doc(s.id).get()).data() as Show | undefined)?.groupMembers;
      if (!groupRefreshDue({ cache, groupId: s.groupId!, now: Date.now(), jitter: jitterOf(s.groupId!), minutesToStart: minutesToShowStart(s, today, now.time) })) continue;
      try {
        await listGroupMembers(uid, { showId: s.id });
      } catch (e) {
        console.error(`[members] ${uid} refresh of ${s.name} failed`, (e as Error).message);
      }
      await sleep(SPACING_MS);
    }
  } finally {
    running.delete(uid);
  }
}
