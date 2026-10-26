// The server fleet: any number of servers share one Firebase project; each WhatsApp account runs on
// exactly one of them at a time, and moves (with its encrypted login) when that server dies or is asked to.
// Protocol: docs/fleet.md. Everything here is pure so the worker and the app agree on the rules.

/** How a curator's messages may be read by AI. Both are offered; "local_first" is the default. */
export type AiPolicy =
  | "local_only" // only servers running a local model (Ollama) may host this account; chats never leave the server
  | "local_first"; // prefer a local model; a Gemini-only server may host it, and Gemini may answer when local is down

export const DEFAULT_AI_POLICY: AiPolicy = "local_first";

/** Timings (ms). A holder that can't renew fences itself well before anyone may take over. */
export const LEASE_RENEW_MS = 30_000;
export const LEASE_FENCE_MS = 90_000; // holder stops its own WhatsApp if it hasn't renewed for this long
export const LEASE_EXPIRE_MS = 150_000; // others may claim after this long without a renewal
export const SERVER_ONLINE_MS = 75_000; // servers/{id}.lastSeen fresher than this counts as online
export const CLAIM_STAGGER_MS = 20_000; // the Nth-ranked candidate waits N × this before trying to claim
export const VAULT_UPLOAD_EVERY_MS = 10 * 60_000;

/** users/{uid}/fleet/lease: who runs this account's WhatsApp right now. Written only by servers (admin SDK). */
export interface Lease {
  server: string | null; // servers/{id}; null when released
  /** Increments on every claim. A server only acts while the epoch it claimed is still current. */
  epoch: number;
  state: "running" | "handing_off" | "released";
  renewedAt: number;
  claimedAt: number;
  /** Set by the app ("Move here") or by a server shedding load; the holder hands off to it. */
  moveTo?: string | null;
  reason?: "failover" | "move" | "rebalance" | "first_start" | null;
  /** Last server that held it; kept when released so the next holder can say where the account came from. */
  from?: string | null;
}

/** users/{uid}/fleet/prefs: what the curator (or an admin) chose. Written by the app. */
export interface FleetPrefs {
  /** Keep this account on this server whenever it is online. */
  pinned?: string | null;
}

/** users/{uid}/fleet/vault: metadata of the encrypted login copy in Cloud Storage. Written only by servers. */
export interface VaultMeta {
  /**
   * Increments on every upload and on every wipe, and never resets: a logout leaves a tombstone with a higher
   * gen, so an old profile left on another server can never count as newer than a later link.
   */
  gen: number;
  savedAt: number;
  server: string;
  /** Logged out / deleted: no object; any local copy with a lower gen is dead. */
  wiped?: boolean;
  /** Exact Storage path of this gen's object (vaultObjectPath(uid, gen, nonce)); null when wiped. */
  object: string | null;
  bytes: number;
  sha256: string; // of the encrypted object; "" when wiped
  /** Lease epoch of the uploader (not set on tombstones or on metas written by older servers). */
  epoch?: number;
}

/**
 * The local gen to use for an upload decision. The marker file (vault-{uid}.json) can lag the cloud while this server
 * holds the lease: an upload committed but the marker write failed, or a fresh link never managed to adopt the cloud
 * gen. Two cases where the cloud's gen is provably ours, so the marker is raised to it (`adopt`: write it back):
 * - the cloud meta was written by this server under this very lease epoch;
 * - there is no marker, and this session reached ready from a fresh QR link (its profile is newer than any tombstone).
 */
export function resolveMarker(o: {
  marker: number | null;
  cloud: Pick<VaultMeta, "gen" | "server" | "epoch" | "wiped"> | null;
  server: string;
  epoch: number;
  freshLink?: boolean;
}): { gen: number; adopt: boolean } {
  const cur = o.marker ?? 0;
  if (o.cloud && !o.cloud.wiped && o.cloud.server === o.server && o.cloud.epoch === o.epoch && o.cloud.gen > cur) return { gen: o.cloud.gen, adopt: true };
  if (o.marker === null && o.freshLink) return { gen: o.cloud?.gen ?? 0, adopt: true };
  return { gen: cur, adopt: false };
}

/** servers/{id} fields the pre-fleet guard looks at. */
export interface ServerBeat {
  id: string;
  lastSeen?: number;
  fleet?: unknown;
  hostname?: string;
}

/**
 * Servers running a release without fleet logic: they heartbeat (lastSeen fresh) but write no `fleet` field. Such a
 * server starts every approved account and ignores leases, so no fleet server may claim or start anything while one is online.
 */
export const preFleetServers = (servers: ServerBeat[], me: string, now: number) =>
  servers.filter((s) => s.id !== me && !s.fleet && typeof s.lastSeen === "number" && now - s.lastSeen < SERVER_ONLINE_MS);

/**
 * Cloud Storage object holding the encrypted login (IndexedDB + Local Storage), AES-256-GCM. Every upload attempt
 * writes its own uniquely named object (`nonce` is random), so no writer can ever collide with, overwrite or delete
 * another writer's object; meta.object records the exact path of the committed one. Uncommitted and superseded
 * objects are deleted once they are older than VAULT_OBJECT_MIN_AGE_MS.
 */
export const vaultObjectPath = (uid: string, gen: number, nonce: string) => `vault/${uid}/login-${gen}-${nonce}.bin`;
/** Prefix under which all of an account's vault objects live. */
export const vaultObjectPrefix = (uid: string) => `vault/${uid}/`;
/** An object that isn't the committed one is only deleted after this long, so a slow writer or reader is never cut off. */
export const VAULT_OBJECT_MIN_AGE_MS = 10 * 60_000;

/** Capacity fields every server adds to servers/{id} (ServerStatus). */
export interface FleetCapacity {
  /** First time this server ever ran (persisted on disk); newer installs rank higher on ties. */
  installedAt: number;
  /** Accounts this server will host at most (memory-derived, overridable by SPOT_MAX_ACCOUNTS). */
  maxAccounts: number;
  /** Accounts whose lease this server currently holds. */
  hosting: number;
  /** A local model is reachable and has at least one model pulled. */
  localModel: boolean;
  /** Not taking new accounts (draining for a graceful shutdown). */
  draining: boolean;
}

export interface CandidateServer extends FleetCapacity {
  id: string;
  lastSeen: number;
}

/**
 * Servers allowed to host an account, best first. Every server computes the same list from the same
 * Firestore data, so they agree on who should claim without talking to each other.
 * Order: the pinned server; then servers with a local model (for local_first); then least loaded
 * (hosting / maxAccounts); then newest install; then id for a stable tie-break.
 */
export function rankCandidates(servers: CandidateServer[], opts: { policy: AiPolicy; pinned?: string | null; now: number }): CandidateServer[] {
  const ok = servers.filter(
    (s) => opts.now - s.lastSeen < SERVER_ONLINE_MS && !s.draining && s.hosting < s.maxAccounts && (opts.policy !== "local_only" || s.localModel),
  );
  const load = (s: CandidateServer) => s.hosting / Math.max(1, s.maxAccounts);
  return ok.sort(
    (a, b) =>
      Number(b.id === opts.pinned) - Number(a.id === opts.pinned) ||
      Number(b.localModel) - Number(a.localModel) ||
      load(a) - load(b) ||
      b.installedAt - a.installedAt ||
      a.id.localeCompare(b.id),
  );
}

/** May a server claim this lease now? */
export function leaseClaimable(lease: Lease | null | undefined, now: number) {
  if (!lease || !lease.server || lease.state === "released") return true;
  return now - lease.renewedAt > LEASE_EXPIRE_MS;
}

/**
 * Which login copy to start from. `localGen` is the vault gen the local profile was last synced with
 * (null when there is no local profile). The newest copy wins:
 * - no local profile: download the cloud copy (or start fresh for a QR if there is none);
 * - local gen is behind the cloud: another server ran this account since, so local is stale;
 * - otherwise local is the same or newer than the cloud: keep it and upload it soon.
 * A wiped (tombstone) cloud meta that is newer than the local copy means "fresh": the local copy is dead.
 * A new link adopts the current cloud gen as its local gen when it becomes ready (so a restart before its
 * first upload keeps it), and its first upload goes out as gen + 1.
 */
export function pickLoginSource(localGen: number | null, cloud: Pick<VaultMeta, "gen" | "wiped"> | null): "local" | "cloud" | "fresh" {
  if (localGen === null) return cloud && !cloud.wiped ? "cloud" : "fresh";
  if (cloud && cloud.gen > localGen) return cloud.wiped ? "fresh" : "cloud";
  return "local";
}

/**
 * May this profile be uploaded? Only a session that reached "ready" (a working login), and never a local copy
 * that is behind the cloud: a stale profile must not become the newest gen.
 */
export function mayUpload(o: { sessionReady: boolean; localGen: number | null; cloudGen: number | null }) {
  return o.sessionReady && (o.cloudGen === null || (o.localGen ?? 0) >= o.cloudGen);
}

/** Memory-based default for maxAccounts: ~450 MB per WhatsApp browser, keeping 1.5 GB (+4 GB with a local model) for the rest. */
export function defaultMaxAccounts(totalMemBytes: number, localModel: boolean) {
  const reserve = (1.5 + (localModel ? 4 : 0)) * 1024 ** 3;
  return Math.max(1, Math.floor((totalMemBytes - reserve) / (450 * 1024 ** 2)));
}

/**
 * fleetServers/{id}: what any approved curator may see about a server (servers/{id} has logs and admin
 * emails, so it stays admin-only). Written by each server alongside its heartbeat.
 */
export interface FleetServerSummary extends CandidateServer {
  hostname: string;
  platform: string; // "linux", "win32", "darwin"
}

/** Push notification kinds the worker sends (users/{uid}/devices/{token}). */
export type PushKind = "account_moved" | "scan_needed" | "server_offline" | "new_request";
