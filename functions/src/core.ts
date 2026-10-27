// The handler logic, free of Firebase and googleapis imports: index.ts wires it to the real Gcp and Store.
import {
  BUCKET_ROLES,
  CODE_TTL_MS,
  PROJECT_ROLES,
  generateCode,
  hashCode,
  isManagedAccount,
  isOnline,
  normaliseCode,
  pickServiceAccountId,
  sanitiseDevice,
  serviceAccountEmail,
} from "./logic";
import type { Gcp, Store } from "./ports";

export type ErrorCode = "invalid-argument" | "permission-denied" | "not-found" | "failed-precondition" | "resource-exhausted" | "internal";

/** An error the caller may see. Anything else becomes a generic "internal". */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface Deps {
  gcp: Gcp;
  store: Store;
  now: () => number;
  /** Waits between retries; tests pass an instant one. */
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
}

export const ATTEMPT_LIMIT = 10;
export const ATTEMPT_WINDOW_MS = 15 * 60_000;
const BAD_CODE = "That code isn't valid, or it has expired or been used. Ask the admin for a new one.";

/** IAM is eventually consistent: a role can't be granted to an account for a moment after it is created. */
async function retry<T>(deps: Deps, fn: () => Promise<T>, tries = 5, delayMs = 2_000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      await deps.sleep(delayMs * i);
    }
  }
}

const cleanName = (v: unknown, max = 60) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "");

// ---------- 1. admin creates a code ----------

export async function createJoinCode(deps: Deps, caller: { email?: string; verified?: boolean }, input: { deviceName?: unknown }) {
  const email = caller.email?.toLowerCase();
  if (!email || !caller.verified) throw new AppError("permission-denied", "Sign in with a verified email first.");
  if (!(await deps.store.isAdmin(email))) throw new AppError("permission-denied", "Only admins can add a server.");
  const now = deps.now();
  const code = generateCode();
  const expiresAt = now + CODE_TTL_MS;
  await deps.store.putCode(hashCode(code), { createdBy: email, createdAt: now, expiresAt, used: false, deviceName: cleanName(input.deviceName) });
  await deps.store.sweepCodes(now).catch(() => undefined);
  return { code, expiresAt };
}

// ---------- 2. the new server redeems it ----------

export async function redeemJoinCode(deps: Deps, input: { code?: unknown; deviceName?: unknown; ip: string }) {
  const now = deps.now();
  if (!(await deps.store.allowAttempt(input.ip, now, ATTEMPT_LIMIT, ATTEMPT_WINDOW_MS))) {
    throw new AppError("resource-exhausted", "Too many attempts. Wait a few minutes and try again.");
  }
  const canonical = normaliseCode(input.code);
  if (!canonical) throw new AppError("invalid-argument", BAD_CODE);
  const hash = hashCode(canonical);
  const claimed = await deps.store.claimCode(hash, now);
  if (!claimed.ok) throw new AppError("invalid-argument", BAD_CODE);

  const deviceName = cleanName(input.deviceName) || claimed.code.deviceName || "server";
  return provision(
    deps,
    { finish: (email) => deps.store.finishCode(hash, email, deps.now()), release: () => deps.store.releaseCode(hash) },
    claimed.code.createdBy,
    deviceName,
  );
}

/** What provisioning does to whatever authorised it (a join code, a device link) on success and on failure. */
export interface ProvisionHooks {
  finish(serviceAccount: string): Promise<void>;
  /** Give the authorisation back so it can be tried again. */
  release(): Promise<void>;
}

/** Makes the per-server service account with its roles and one key. Used by join codes and device links. */
export async function provision(deps: Deps, hooks: ProvisionHooks, createdBy: string, deviceName: string) {
  const { gcp } = deps;
  // First free name: spot-<device>, then -2, -3, ...
  const taken = new Set<string>();
  let saId = "";
  for (let i = 0; i < 20; i++) {
    saId = pickServiceAccountId(deviceName, (x) => taken.has(x));
    if (!(await gcp.serviceAccountExists(serviceAccountEmail(saId)))) break;
    taken.add(saId);
    if (i === 19) {
      await hooks.release();
      throw new AppError("internal", "Couldn't find a free name for this server. Remove old servers and try again.");
    }
  }
  const email = serviceAccountEmail(saId);
  let created = false;
  try {
    await gcp.createServiceAccount(saId, `Spot server: ${deviceName}`.slice(0, 100), `Worker key for device '${deviceName}'. Joined by code; remove it from the Server page.`.slice(0, 256));
    created = true;
    await retry(deps, () => gcp.setProjectRoles(email, "add", PROJECT_ROLES));
    await retry(deps, () => gcp.setBucketRoles(email, "add", BUCKET_ROLES));
    const key = await retry(deps, () => gcp.createKey(email), 3, 1_000);
    const now = deps.now();
    await deps.store.putServerKey(email, { deviceName, deviceSlug: sanitiseDevice(deviceName), createdBy, createdAt: now, keyId: key.keyId });
    await hooks.finish(email);
    return { key: key.json, serviceAccount: email, deviceName };
  } catch (e) {
    deps.log(`join failed for ${email}: ${(e as Error).message}`);
    // Undo what we did and give the code back, so the admin doesn't have to make another.
    if (created) await revokeAccount(deps, email).catch((err) => deps.log(`cleanup of ${email} failed: ${(err as Error).message}`));
    await hooks.release().catch(() => undefined);
    throw new AppError("internal", "Couldn't set up this server's key. Try the code again in a minute.");
  }
}

// ---------- 3. admin removes a server ----------

/** Keys first (so access ends even if a later step fails), then the roles, then the account. Mirrors deploy/revoke-server-key.sh. */
export async function revokeAccount(deps: Deps, email: string) {
  const { gcp } = deps;
  if (!isManagedAccount(email)) throw new Error(`Refusing to touch ${email}`);
  for (const k of await gcp.listUserKeyIds(email).catch(() => [] as string[])) await gcp.deleteKey(email, k);
  await gcp.setBucketRoles(email, "remove", BUCKET_ROLES).catch((e) => deps.log(`bucket roles for ${email}: ${(e as Error).message}`));
  await gcp.setProjectRoles(email, "remove", PROJECT_ROLES).catch((e) => deps.log(`project roles for ${email}: ${(e as Error).message}`));
  await gcp.deleteServiceAccount(email);
}

export interface RemoveResult {
  revoked: string[];
  /** No Nothing BOT Curate account is linked to this server (for example the Mac using the project's default key). */
  keyNotRevoked: boolean;
}

export async function removeServer(deps: Deps, caller: { email?: string; verified?: boolean }, input: { serverId?: unknown; force?: unknown }): Promise<RemoveResult> {
  const email = caller.email?.toLowerCase();
  if (!email || !caller.verified) throw new AppError("permission-denied", "Sign in with a verified email first.");
  if (!(await deps.store.isAdmin(email))) throw new AppError("permission-denied", "Only admins can remove a server.");
  const id = typeof input.serverId === "string" ? input.serverId : "";
  if (!id || id.length > 200 || id.includes("/")) throw new AppError("invalid-argument", "Which server?");
  const server = await deps.store.getServer(id);
  if (!server) throw new AppError("not-found", "That server isn't listed any more.");

  const online = isOnline(server.lastSeen, deps.now());
  if (online && input.force !== true) {
    const holders = await deps.store.leaseHolders(id);
    if (holders.length) {
      throw new AppError(
        "failed-precondition",
        `This server is online and runs ${holders.length} WhatsApp account${holders.length === 1 ? "" : "s"}. Removing it cuts its access, and the accounts move to another server within a few minutes. Move them first, or remove it anyway.`,
      );
    }
  }

  // Exact: the server reports the account it runs as. Fallback for older servers: match by name.
  const reported = typeof server.serviceAccount === "string" ? server.serviceAccount : null;
  const slugs = [...new Set([sanitiseDevice(id), sanitiseDevice(server.hostname)].filter(Boolean))];
  const keys = reported
    ? (isManagedAccount(reported) && (await deps.store.hasServerKey(reported)) ? [{ email: reported }] : [])
    : (await deps.store.findServerKeys(slugs)).filter((k) => isManagedAccount(k.email));
  const revoked: string[] = [];
  for (const k of keys) {
    await revokeAccount(deps, k.email);
    await deps.store.deleteServerKey(k.email);
    revoked.push(k.email);
  }
  await deps.store.deleteServerDocs(id);
  deps.log(`${email} removed server ${id}; revoked ${revoked.join(", ") || "nothing"}`);
  return { revoked, keyNotRevoked: revoked.length === 0 };
}
