// Spot Solutions Cloud Functions (2nd gen, asia-south1). Join codes and server removal: docs/multi-server.md.
import { initializeApp } from "firebase-admin/app";
import { setGlobalOptions } from "firebase-functions/v2";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { AppError, createJoinCode as createCode, redeemJoinCode as redeemCode, removeServer as removeOne, type Deps } from "./core";
import { googleGcp } from "./gcp";
import { ENROLLER_ID, PROJECT_ID, REGION, ipHash, serviceAccountEmail } from "./logic";
import { firestoreStore } from "./store";

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
