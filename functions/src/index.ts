// Spot Solutions Cloud Functions (2nd gen, asia-south1). Join codes and server removal: docs/multi-server.md.
import { initializeApp } from "firebase-admin/app";
import { setGlobalOptions } from "firebase-functions/v2";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { AppError, createJoinCode as createCode, redeemJoinCode as redeemCode, removeServer as removeOne, type Deps } from "./core";
import { googleGcp } from "./gcp";
import { ENROLLER_ID, PROJECT_ID, REGION, ipHash, serviceAccountEmail } from "./logic";
import { approveDeviceLink as approveLink, getDeviceLink as getLink, pollDeviceLink as pollLink, startDeviceLink as startLink, type LinkDeps } from "./link";
import { firestoreLinkStore, firestoreStore } from "./store";

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

/** Admin: remove a server, revoke its key if Spot Solutions made it. */
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
