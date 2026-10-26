// Nothing BOT Curating Cloud Functions (2nd gen, asia-south1). Join codes and server removal: docs/multi-server.md.
import { initializeApp } from "firebase-admin/app";
import { setGlobalOptions } from "firebase-functions/v2";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { AppError, createJoinCode as createCode, redeemJoinCode as redeemCode, removeServer as removeOne, type Deps } from "./core";
import { googleGcp } from "./gcp";
import { ENROLLER_ID, PROJECT_ID, REGION, ipHash, serviceAccountEmail } from "./logic";
import { approveDeviceLink as approveLink, getDeviceLink as getLink, pollDeviceLink as pollLink, startDeviceLink as startLink, type LinkDeps } from "./link";
import { firestoreLinkStore, firestoreStore } from "./store";
import { OAuth2Client } from "google-auth-library";
import { defineSecret, defineString } from "firebase-functions/params";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { getFunctions } from "firebase-admin/functions";
import { parseKey } from "./gcrypto";
import { connect as gcConnect, disconnect as gcDisconnect, onComicWritten as gcOnComic, planContacts as gcPlan, processDue as gcProcess, processUser as gcProcessUser, runContacts as gcRun, type Caller as GcCaller, type GcDeps } from "./googleContacts";
import { firestoreGcStore } from "./googleStore";
import type { ComicBits } from "./googleLogic";

initializeApp();
// A dedicated identity (deploy/setup-functions-iam.sh), not the default compute account.
setGlobalOptions({ region: REGION, serviceAccount: serviceAccountEmail(ENROLLER_ID, PROJECT_ID), maxInstances: 5 });

const deps = (): Deps => ({
  gcp: googleGcp(),
  store: firestoreStore(),
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (m) => console.log(`[enroll] ${m}`),
});

const linkDeps = (): LinkDeps => ({ ...deps(), links: firestoreLinkStore() });

/** Real errors stay in the log; the caller only sees messages written for them. */
function rethrow(e: unknown): never {
  if (e instanceof AppError) throw new HttpsError(e.code, e.message);
  console.error("[enroll]", e);
  throw new HttpsError("internal", "Something went wrong. Try again.");
}

const caller = (auth: { token: { email?: string; email_verified?: boolean } } | undefined) => ({ email: auth?.token.email, verified: auth?.token.email_verified === true });

/** Admin: make a join code (valid 15 minutes). */
export const createJoinCode = onCall(async (req) => {
  try {
    return await createCode(deps(), caller(req.auth), (req.data ?? {}) as { deviceName?: unknown });
  } catch (e) {
    return rethrow(e);
  }
});

/** Admin: remove a server, revoke its key if Nothing BOT Curating made it. */
export const removeServer = onCall({ timeoutSeconds: 120 }, async (req) => {
  try {
    return await removeOne(deps(), caller(req.auth), (req.data ?? {}) as { serverId?: unknown; force?: unknown });
  } catch (e) {
    return rethrow(e);
  }
});

const HTTP_STATUS: Record<string, number> = { "invalid-argument": 400, "permission-denied": 403, "not-found": 404, "failed-precondition": 412, "resource-exhausted": 429, internal: 500 };

function sendError(res: { status(n: number): { json(b: unknown): void } }, e: unknown) {
  if (e instanceof AppError) {
    res.status(HTTP_STATUS[e.code] ?? 500).json({ error: e.message });
    return;
  }
  console.error("[enroll]", e);
  res.status(500).json({ error: "Something went wrong. Try again." });
}

/**
 * A new server trades a join code for its key. No sign-in: the code is the credential (15 minutes, one use, 8 random
 * characters, hashed at rest) and attempts are limited per IP.
 */
export const redeemJoinCode = onRequest({ invoker: "public", cors: false, timeoutSeconds: 120 }, async (req, res) => {
  res.set("cache-control", "no-store");
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  // The last X-Forwarded-For entry is the one Google's front end adds; earlier ones can be made up by the sender.
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const ip = forwarded[forwarded.length - 1] || req.ip || "unknown";
  try {
    const body = (typeof req.body === "object" && req.body ? req.body : {}) as { code?: unknown; deviceName?: unknown };
    const r = await redeemCode(deps(), { code: body.code, deviceName: body.deviceName, ip: ipHash(ip) });
    res.status(200).json({ ok: true, key: r.key, serviceAccount: r.serviceAccount, deviceName: r.deviceName });
  } catch (e) {
    if (e instanceof AppError) {
      res.status(HTTP_STATUS[e.code] ?? 500).json({ error: e.message });
      return;
    }
    console.error("[enroll]", e);
    res.status(500).json({ error: "Something went wrong. Try again." });
  }
});

// ---------- device link: sign in first, then the console gets its own key (functions/src/link.ts) ----------

const clientIp = (req: { headers: Record<string, unknown>; ip?: string }) => {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return ipHash(forwarded[forwarded.length - 1] || req.ip || "unknown");
};

/** The server console asks for a link (public; limited per IP). Nothing here is a credential yet. */
export const startDeviceLink = onRequest({ invoker: "public", cors: false }, async (req, res) => {
  res.set("cache-control", "no-store");
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  try {
    const b = (typeof req.body === "object" && req.body ? req.body : {}) as { deviceName?: unknown; challenge?: unknown };
    res.status(200).json({ ok: true, ...(await startLink(linkDeps(), { deviceName: b.deviceName, challenge: b.challenge, ip: clientIp(req) })) });
  } catch (e) {
    sendError(res, e);
  }
});

/** The console polls with the code and its secret. Once an admin approved, the reply carries the key, once. */
export const pollDeviceLink = onRequest({ invoker: "public", cors: false, timeoutSeconds: 120 }, async (req, res) => {
  res.set("cache-control", "no-store");
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  try {
    const b = (typeof req.body === "object" && req.body ? req.body : {}) as { code?: unknown; secret?: unknown };
    res.status(200).json({ ok: true, ...(await pollLink(linkDeps(), { code: b.code, secret: b.secret })) });
  } catch (e) {
    sendError(res, e);
  }
});

/** Web app: what is this link? (any signed-in user; says whether they may approve it). */
export const getDeviceLink = onCall(async (req) => {
  try {
    return await getLink(linkDeps(), caller(req.auth), (req.data ?? {}) as { code?: unknown });
  } catch (e) {
    return rethrow(e);
  }
});

/** Web app: an admin approves. */
export const approveDeviceLink = onCall(async (req) => {
  try {
    return await approveLink(linkDeps(), caller(req.auth), (req.data ?? {}) as { code?: unknown });
  } catch (e) {
    return rethrow(e);
  }
});

// ---------- Google Contacts, always on (functions/src/googleContacts.ts) ----------
// The curator consents once (offline); the refresh token is kept encrypted, server side, and these functions write
// names to their Google Contacts whether or not the app is open. Secrets: set by the project owner, never in the repo.

const GOOGLE_OAUTH_CLIENT_ID = defineString("GOOGLE_OAUTH_CLIENT_ID");
const GOOGLE_OAUTH_CLIENT_SECRET = defineSecret("GOOGLE_OAUTH_CLIENT_SECRET");
const GOOGLE_TOKEN_KEY = defineSecret("GOOGLE_TOKEN_KEY");
const GC_SECRETS = [GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_TOKEN_KEY];

const gcDeps = (): GcDeps => {
  const clientId = GOOGLE_OAUTH_CLIENT_ID.value();
  return {
    store: firestoreGcStore(),
    fetch: (url, init) => fetch(url, init),
    key: parseKey(GOOGLE_TOKEN_KEY.value()),
    oauth: { clientId, clientSecret: GOOGLE_OAUTH_CLIENT_SECRET.value() },
    verifyIdToken: async (idToken) => (await new OAuth2Client().verifyIdToken({ idToken, audience: clientId })).getPayload() ?? {},
    now: Date.now,
    log: (m) => console.log(`[google-contacts] ${m}`),
    schedule: scheduleFlush,
  };
};

/** One Cloud Task per curator per batch; the id makes a repeated schedule for the same moment a no-op. */
async function scheduleFlush(uid: string, at: number) {
  try {
    await getFunctions().taskQueue(`locations/${REGION}/functions/flushGoogleContacts`).enqueue({ uid }, { scheduleTime: new Date(at), id: `${uid}-${at}` });
  } catch (e) {
    // Already scheduled (same id), or Tasks is briefly unavailable: the safety sweep picks the batch up.
    if ((e as { code?: string }).code !== "functions/task-already-exists") console.warn("[google-contacts] schedule", e);
  }
}

const gcCaller = (auth: { uid: string; token: { email?: string; email_verified?: boolean; firebase?: { sign_in_provider?: string } } } | undefined): GcCaller => ({
  uid: auth?.uid,
  email: auth?.token.email,
  verified: auth?.token.email_verified === true,
  anonymous: !auth || auth.token.firebase?.sign_in_provider === "anonymous",
});

function gcRethrow(e: unknown): never {
  if (e instanceof AppError) throw new HttpsError(e.code, e.message);
  console.error("[google-contacts]", e);
  throw new HttpsError("internal", "Something went wrong. Try again.");
}

/** Web app: trade the one-time code from Google's popup for lasting access (stored encrypted; never returned). */
export const connectGoogleContacts = onCall({ secrets: GC_SECRETS }, async (req) => {
  try {
    return await gcConnect(gcDeps(), gcCaller(req.auth), (req.data ?? {}) as { code?: unknown });
  } catch (e) {
    return gcRethrow(e);
  }
});

/** Web app: revoke at Google and forget the token. */
export const disconnectGoogleContacts = onCall({ secrets: GC_SECRETS }, async (req) => {
  try {
    return await gcDisconnect(gcDeps(), gcCaller(req.auth));
  } catch (e) {
    return gcRethrow(e);
  }
});

/** Web app: "Sync all comics now", step one. Says what would change; writes nothing. */
export const planGoogleContacts = onCall({ secrets: GC_SECRETS, timeoutSeconds: 120 }, async (req) => {
  try {
    return await gcPlan(gcDeps(), gcCaller(req.auth), (req.data ?? {}) as { ids?: unknown });
  } catch (e) {
    return gcRethrow(e);
  }
});

/** Web app: step two, after the curator confirmed. */
export const runGoogleContacts = onCall({ secrets: GC_SECRETS, timeoutSeconds: 540, memory: "512MiB" }, async (req) => {
  try {
    return await gcRun(gcDeps(), gcCaller(req.auth), (req.data ?? {}) as { ids?: unknown });
  } catch (e) {
    return gcRethrow(e);
  }
});

/** A comic was added or renamed: queue it and, if none is pending, schedule one task to write it after a quiet minute. */
export const queueGoogleContact = onDocumentWritten({ document: "users/{uid}/comics/{id}" }, async (event) => {
  const { uid, id } = event.params;
  try {
    await gcOnComic({ store: firestoreGcStore(), now: Date.now, schedule: scheduleFlush }, uid, id, event.data?.before.data() as ComicBits | undefined, event.data?.after.data() as ComicBits | undefined);
  } catch (e) {
    console.error("[google-contacts] queue", e);
  }
});

/** The task scheduled above: writes one curator's batch. Runs only when there's something to write. */
export const flushGoogleContacts = onTaskDispatched({ invoker: serviceAccountEmail(ENROLLER_ID, PROJECT_ID), secrets: GC_SECRETS, timeoutSeconds: 300, retryConfig: { maxAttempts: 3, minBackoffSeconds: 60 }, rateLimits: { maxConcurrentDispatches: 5 } }, async (req) => {
  const uid = String((req.data as { uid?: unknown })?.uid ?? "");
  if (!uid) return;
  const r = await gcProcessUser(gcDeps(), uid);
  if (r.saved) console.log(`[google-contacts] ${uid}: ${r.saved} contacts saved`);
});

/** Safety sweep, 4 times a day: a batch whose task was lost. The tasks do the real work (this used to run every 2 minutes). */
export const syncGoogleContacts = onSchedule({ schedule: "every 6 hours", secrets: GC_SECRETS, timeoutSeconds: 300, maxInstances: 1 }, async () => {
  const r = await gcProcess(gcDeps());
  if (r.users) console.log(`[google-contacts] ${r.users} curators, ${r.saved} contacts saved`);
});
