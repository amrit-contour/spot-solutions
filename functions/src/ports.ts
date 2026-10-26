// The two things the handlers talk to, as small interfaces: Google Cloud (gcp.ts) and Firestore (store.ts).
// The handler logic in core.ts only sees these, so it is tested with in-memory fakes.

export interface KeyResult {
  keyId: string;
  /** The service-account key file, parsed. */
  json: Record<string, unknown>;
}

export interface Gcp {
  serviceAccountExists(email: string): Promise<boolean>;
  createServiceAccount(id: string, displayName: string, description: string): Promise<void>;
  createKey(email: string): Promise<KeyResult>;
  /** Ids of the keys a person created (not Google-managed ones). */
  listUserKeyIds(email: string): Promise<string[]>;
  deleteKey(email: string, keyId: string): Promise<void>;
  /** Succeeds if it is already gone. */
  deleteServiceAccount(email: string): Promise<void>;
  /** Add or remove `serviceAccount:<email>` on each project role. */
  setProjectRoles(email: string, mode: "add" | "remove", roles: readonly string[]): Promise<void>;
  /** Same, on the default bucket only. */
  setBucketRoles(email: string, mode: "add" | "remove", roles: readonly string[]): Promise<void>;
}

export interface JoinCodeDoc {
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
  deviceName: string;
  usedAt?: number;
  serviceAccount?: string;
}

export type ClaimResult = { ok: true; code: JoinCodeDoc } | { ok: false };

export interface ServerKeyDoc {
  deviceName: string;
  /** sanitiseDevice(deviceName): how removeServer finds the account for a server. */
  deviceSlug: string;
  createdBy: string;
  createdAt: number;
  keyId: string;
}

export interface ServerInfo {
  hostname?: string;
  lastSeen?: number;
  /** client_email the server reports running as (newer servers). */
  serviceAccount?: string | null;
}

export interface Store {
  isAdmin(email: string): Promise<boolean>;
  putCode(hash: string, doc: JoinCodeDoc): Promise<void>;
  /** Unused and unexpired codes only. Marks it used in one transaction. */
  claimCode(hash: string, now: number): Promise<ClaimResult>;
  /** Provisioning failed: make the code usable again (if it hasn't expired). */
  releaseCode(hash: string): Promise<void>;
  finishCode(hash: string, serviceAccount: string, now: number): Promise<void>;
  /** Counts one attempt for `key`; false once over the limit. */
  allowAttempt(key: string, now: number, limit: number, windowMs: number): Promise<boolean>;
  putServerKey(email: string, doc: ServerKeyDoc): Promise<void>;
  /** serverKeys whose deviceSlug is one of `slugs`. */
  findServerKeys(slugs: string[]): Promise<{ email: string; doc: ServerKeyDoc }[]>;
  /** A serverKeys record exists for this account (it was created by a join code). */
  hasServerKey(email: string): Promise<boolean>;
  deleteServerKey(email: string): Promise<void>;
  /** The server, from servers/{id} or fleetServers/{id}; null if neither exists. */
  getServer(id: string): Promise<ServerInfo | null>;
  /** uids whose account lease is running on this server. */
  leaseHolders(serverId: string): Promise<string[]>;
  deleteServerDocs(id: string): Promise<void>;
  /** Housekeeping: delete codes that expired over a day ago. */
  sweepCodes(now: number): Promise<void>;
}
