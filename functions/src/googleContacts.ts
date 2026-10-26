// Always-on Google Contacts: the handlers behind connectGoogleContacts / disconnectGoogleContacts / planGoogleContacts /
// runGoogleContacts, the Firestore trigger that queues comic edits, and the Cloud Task (plus a rare safety sweep) that writes them.
// Only sees the ports below (GcStore, fetch, token verifier), so it is tested with fakes. Wiring is in index.ts.
import { AppError } from "./core";
import type { SyncComic, ContactPlan } from "./contactsShared";
import { decryptToken, encryptToken } from "./gcrypto";
import { GoogleApiError, GrantRevokedError, People, exchangeCode, mintAccessToken, revokeToken, type Fetch, type OAuthClient, type SyncResult } from "./googleApi";
import { checkAccountEmail, hasContactsScope, isBulk, requireCode, shouldQueueComic, type ComicBits, type QueueDoc } from "./googleLogic";

export interface LinkRecord {
  /** The refresh token, encrypted (gcrypto.ts). Never sent to a client. */
  enc: string;
  email: string;
  since: number;
}

export interface GcStore {
  getLink(uid: string): Promise<LinkRecord | null>;
  /** Writes the server-only token document and the owner-readable status ("connected", email, since). */
  putLink(uid: string, rec: LinkRecord): Promise<void>;
  /** Deletes the token and any queued work; status becomes "disconnected" (reason) or is removed when the curator did it. */
  removeLink(uid: string, why: "user" | "revoked"): Promise<void>;
  /** The link exists and the curator's switch is on. */
  autoSyncOn(uid: string): Promise<boolean>;
  /** All comics (ids undefined) or just these. Missing ones are left out. */
  getComics(uid: string, ids?: string[]): Promise<SyncComic[]>;
  notice(uid: string, level: "info" | "warn", text: string): Promise<void>;
  enqueue(uid: string, id: string, now: number): Promise<void>;
  /** Entries that are due and not leased; each is leased to this run before it is returned. */
  claimDue(now: number, limit: number): Promise<{ uid: string; q: QueueDoc }[]>;
  /** One curator's entry, leased to this run, if it is due and free. */
  claimOne(uid: string, now: number): Promise<QueueDoc | null>;
  /** Record that a task is (about to be) scheduled: returns its time, or null when none is needed (see nextTaskAt). */
  armTask(uid: string, now: number, force?: boolean): Promise<number | null>;
  /** Remove what was written from the entry (edits that arrived meanwhile stay queued). `clearOverflow` for the bulk notice. */
  finish(uid: string, processed: string[], now: number, clearOverflow?: boolean): Promise<void>;
  /** A run failed: back off, or give up (returns true). */
  fail(uid: string, now: number): Promise<boolean>;
  drop(uid: string): Promise<void>;
}

export interface GcDeps {
  store: GcStore;
  fetch: Fetch;
  key: Buffer;
  oauth: OAuthClient;
  /** Checks the signature and audience; returns the claims. */
  verifyIdToken(idToken: string): Promise<{ email?: string; email_verified?: boolean }>;
  now(): number;
  sleep?(ms: number): Promise<void>;
  log(m: string): void;
  /** Run flushGoogleContacts for this curator at `at` (a Cloud Task). Missing in tests that don't care. */
  schedule?(uid: string, at: number): Promise<void>;
}

/** Make sure a task will pick this entry up. Only one is pending per curator, so a burst of edits costs one run. */
async function arm(d: Pick<GcDeps, "store" | "now" | "schedule">, uid: string, force = false) {
  if (!d.schedule) return;
  const at = await d.store.armTask(uid, d.now(), force);
  if (at !== null) await d.schedule(uid, at);
}

export interface Caller {
  uid?: string;
  email?: string;
  verified: boolean;
  anonymous: boolean;
}

function who(c: Caller): string {
  if (!c.uid || c.anonymous) throw new AppError("permission-denied", "Sign in with Google first.");
  return c.uid;
}

/** The curator picked a Google account in the popup and got a one-time code: keep long-lived access, server side. */
export async function connect(d: GcDeps, caller: Caller, data: { code?: unknown }): Promise<{ email: string; since: number }> {
  const uid = who(caller);
  const code = requireCode(data.code);
  let grant;
  try {
    grant = await exchangeCode(d.fetch, d.oauth, code);
  } catch (e) {
    d.log(`code exchange failed: ${(e as Error).message}`);
    throw new AppError("invalid-argument", "Google didn't accept that sign-in. Try again.");
  }
  const refresh = grant.refreshToken;
  // From here on, a refresh token exists at Google. Any refusal below revokes it so nothing is left dangling.
  const refuse = async (message: string, code: "permission-denied" | "failed-precondition" = "permission-denied"): Promise<never> => {
    if (refresh) await revokeToken(d.fetch, refresh);
    throw new AppError(code, message);
  };
  if (!refresh) return refuse("Google didn't give lasting access. Remove Spot Solutions at myaccount.google.com/permissions, then try again.", "failed-precondition");
  if (!hasContactsScope(grant.scope)) return refuse("Contacts access wasn't ticked. Try again and leave the Contacts box ticked.", "failed-precondition");
  if (!grant.idToken) return refuse("Google didn't say which account this is. Try again.", "failed-precondition");
  let claims;
  try {
    claims = await d.verifyIdToken(grant.idToken);
  } catch {
    return refuse("Couldn't check which Google account this is. Try again.", "failed-precondition");
  }
  const ok = checkAccountEmail({ email: claims.email, verified: claims.email_verified }, { email: caller.email, verified: caller.verified });
  if (!ok.ok) return refuse(ok.message);
  const rec: LinkRecord = { enc: encryptToken(d.key, uid, refresh), email: ok.email, since: d.now() };
  await d.store.putLink(uid, rec);
  d.log(`connected ${uid}`);
  return { email: rec.email, since: rec.since };
}

/** Revoke at Google (best effort) and forget everything. Safe to call when nothing is connected. */
export async function disconnect(d: GcDeps, caller: Caller): Promise<{ revoked: boolean }> {
  const uid = who(caller);
  const link = await d.store.getLink(uid);
  let revoked = false;
  if (link) {
    try {
      revoked = await revokeToken(d.fetch, decryptToken(d.key, uid, link.enc));
    } catch {
      revoked = false;
    }
  }
  await d.store.removeLink(uid, "user");
  return { revoked };
}

const REVOKED_TEXT = "Google Contacts was disconnected because access was removed from your Google account. Open Settings, Google Contacts and press Keep connected to turn it back on.";

/** Runs `fn` with a People client. A dead refresh token disconnects the link and tells the curator. */
async function withPeople<T>(d: GcDeps, uid: string, fn: (p: People) => Promise<T>): Promise<T> {
  const link = await d.store.getLink(uid);
  if (!link) throw new AppError("failed-precondition", "Google Contacts isn't connected.");
  try {
    const access = await mintAccessToken(d.fetch, d.oauth, decryptToken(d.key, uid, link.enc));
    return await fn(new People(d.fetch, access, d.sleep));
  } catch (e) {
    if (e instanceof GrantRevokedError) {
      await d.store.removeLink(uid, "revoked");
      await d.store.notice(uid, "warn", REVOKED_TEXT);
      throw new AppError("failed-precondition", "Google access was removed. Press Keep connected to turn it back on.");
    }
    throw e;
  }
}

const googleMessage = (e: unknown) => (e instanceof GoogleApiError ? new AppError("failed-precondition", `Google Contacts said: ${e.message}`) : e);

const MAX_IDS = 5000;
const idList = (v: unknown): string[] | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > MAX_IDS || v.some((x) => typeof x !== "string" || x.length > 200)) throw new AppError("invalid-argument", "That list of comics isn't valid.");
  return v as string[];
};

/** Review dialog, step one: read Google Contacts and say what would change. Writes nothing. */
export async function planContacts(d: GcDeps, caller: Caller, data: { ids?: unknown }): Promise<ContactPlan> {
  const uid = who(caller);
  const comics = await d.store.getComics(uid, idList(data.ids));
  try {
    return await withPeople(d, uid, (p) => p.plan(comics));
  } catch (e) {
    throw googleMessage(e);
  }
}

/** Step two: the plan is made again from the comics' current data (the browser sends only which comics), then run. */
export async function runContacts(d: GcDeps, caller: Caller, data: { ids?: unknown }): Promise<SyncResult> {
  const uid = who(caller);
  const comics = await d.store.getComics(uid, idList(data.ids));
  try {
    return await withPeople(d, uid, async (p) => p.apply(await p.plan(comics)));
  } catch (e) {
    throw googleMessage(e);
  }
}

/** Firestore trigger body: a comic changed. Cheap checks first; the write itself happens later, in a batch. */
export async function onComicWritten(d: Pick<GcDeps, "store" | "now" | "schedule">, uid: string, id: string, before: ComicBits | undefined, after: ComicBits | undefined): Promise<boolean> {
  if (!shouldQueueComic(before, after)) return false;
  if (!(await d.store.autoSyncOn(uid))) return false;
  await d.store.enqueue(uid, id, d.now());
  await arm(d, uid);
  return true;
}

/** Write one claimed entry. Returns how many contacts were saved. Never throws, so one curator can't stop the others. */
async function runOne(d: GcDeps, uid: string, q: QueueDoc): Promise<number> {
  try {
    if (!(await d.store.autoSyncOn(uid))) {
      await d.store.drop(uid);
      return 0;
    }
    if (isBulk(q)) {
      await d.store.notice(uid, "info", "A lot of comics changed at once, so Google Contacts wasn't updated automatically. Open Settings, Google Contacts and press Sync all comics now to review them.");
      await d.store.finish(uid, q.ids, d.now(), true);
      return 0;
    }
    const comics = await d.store.getComics(uid, q.ids);
    let saved = 0;
    if (comics.length) {
      const r = await withPeople(d, uid, async (p) => p.apply(await p.plan(comics)));
      saved = r.created + r.updated;
      if (r.failed) d.log(`${uid}: ${r.failed} contacts failed`);
    }
    await d.store.finish(uid, q.ids, d.now());
    return saved;
  } catch (e) {
    if (e instanceof AppError) {
      // Disconnected (revoked) or not connected any more: nothing left to retry.
      await d.store.drop(uid);
      return 0;
    }
    d.log(`${uid}: ${(e as Error).message}`);
    if (await d.store.fail(uid, d.now())) await d.store.notice(uid, "warn", "Couldn't save the latest comic names to Google Contacts. Open Settings, Google Contacts and press Sync all comics now.");
    return 0;
  }
}

/**
 * The Cloud Task for one curator: write their batch if it's due, then schedule one more task only if work is left
 * (edits that arrived meanwhile, a retry, or a due time pushed back by a later edit).
 */
export async function processUser(d: GcDeps, uid: string): Promise<{ saved: number }> {
  const q = await d.store.claimOne(uid, d.now());
  const saved = q ? await runOne(d, uid, q) : 0;
  await arm(d, uid, true);
  return { saved };
}

/** Safety sweep (a few times a day): anything due that a lost task left behind. One user failing never stops the others. */
export async function processDue(d: GcDeps, limit = 20): Promise<{ users: number; saved: number }> {
  const due = await d.store.claimDue(d.now(), limit);
  let saved = 0;
  for (const { uid, q } of due) {
    saved += await runOne(d, uid, q);
    await arm(d, uid);
  }
  return { users: due.length, saved };
}
