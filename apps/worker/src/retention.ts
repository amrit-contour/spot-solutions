// Daily housekeeping, so Firestore doesn't grow without bound (TTL policies cover the short-lived collections;
// this covers what needs the curator's settings or a check first):
// - closed requests older than settings.retention.closedRequestsWeeks, for the accounts THIS server holds
//   (each account has exactly one holder, so each is handled once per day);
// - demo sandboxes older than 7 days, by exactly one server per day (a date lock in config/demoCleanup).
// Lineups and comics are never touched.
import { DEFAULT_SETTINGS, DEMO_SANDBOX_MAX_AGE_DAYS, closedRequestsWeeks, requestsToExpire, rolloverDayFor, weekOf, type Settings, type Show, type SpotRequest } from "@spot/shared";
import { col, db, userRef } from "./firebase.ts";
import { SERVER_ID } from "./serverIdentity.ts";
import { demoSandboxUids, userData } from "./adminData.ts";
import { fleet } from "./fleet.ts";

const TICK_MS = 60 * 60_000;
const START_DELAY_MS = 10 * 60_000;
const BATCH = 450;
let lastDay = "";

/** Delete this account's expired requests. Returns how many. */
export async function expireRequests(uid: string, now = new Date()): Promise<number> {
  // Read the settings fresh: a cache that hasn't loaded would fall back to the 8-week default over a curator's "keep forever".
  const settings = (await userRef(uid).get()).data()?.settings as Partial<Settings> | undefined;
  const weeks = closedRequestsWeeks(settings);
  if (weeks === 0) return 0;
  const shows = (await col(uid, "shows").get()).docs.map((d) => d.data() as Show);
  const current = weekOf(now, settings?.timezone ?? DEFAULT_SETTINGS.timezone, rolloverDayFor(shows));
  // Same week arithmetic as requestsToExpire; the query narrows by week, the shared function picks by status.
  const snap = await col(uid, "requests").where("weekOf", "<", current).get();
  const docs = snap.docs.map((d) => ({ ref: d.ref, ...(d.data() as Pick<SpotRequest, "weekOf" | "status">) }));
  const gone = requestsToExpire(docs, current, weeks);
  for (let i = 0; i < gone.length; i += BATCH) {
    const batch = db.batch();
    gone.slice(i, i + BATCH).forEach((r) => batch.delete(r.ref));
    await batch.commit();
  }
  return gone.length;
}

/** True for the one server that wins today's lock. */
async function claimDay(name: string, day: string): Promise<boolean> {
  const ref = db.collection("config").doc(name);
  return db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).data()?.date === day) return false;
    tx.set(ref, { date: day, by: SERVER_ID, at: Date.now() });
    return true;
  });
}

export async function cleanDemoSandboxes(day: string): Promise<number> {
  if (!(await claimDay("demoCleanup", day))) return 0;
  try {
    const uids = await demoSandboxUids(DEMO_SANDBOX_MAX_AGE_DAYS);
    for (const uid of uids) await userData(uid, "everything", false);
    if (uids.length) console.log(`[retention] deleted ${uids.length} demo sandbox(es) older than ${DEMO_SANDBOX_MAX_AGE_DAYS} days`);
    return uids.length;
  } catch (e) {
    await db.collection("config").doc("demoCleanup").delete().catch(() => undefined); // let another tick retry
    throw e;
  }
}

async function runDaily() {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (day === lastDay) return;
  lastDay = day;
  for (const uid of fleet.heldUids()) {
    try {
      const n = await expireRequests(uid, now);
      if (n) console.log(`[retention] ${uid}: deleted ${n} old closed request(s)`);
    } catch (e) {
      console.warn(`[retention] ${uid} requests failed:`, (e as Error).message);
    }
  }
  await cleanDemoSandboxes(day).catch((e) => console.warn("[retention] demo sandboxes failed:", (e as Error).message));
}

export function startRetention() {
  const tick = () => void runDaily().catch((e) => console.error("[retention]", e));
  setTimeout(tick, START_DELAY_MS).unref(); // after startup: leases settle and the settings caches fill
  setInterval(tick, TICK_MS).unref();
}
