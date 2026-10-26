// Encrypted cloud copy of each account's WhatsApp login (docs/fleet.md, "Login vault").
// Storage and Firestore access are injectable (VaultDeps) so the logic is testable without Firebase.
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VAULT_OBJECT_MIN_AGE_MS, mayUpload, splitVaultId, pickLoginSource, resolveMarker, vaultObjectPath, vaultObjectPrefix, type VaultMeta } from "@spot/shared";
import { decrypt, encrypt, newKey, sha256 } from "./vault-crypto.ts";
import { packFolders, unpackInto } from "./vault-archive.ts";

/** The only parts of the Chromium profile that hold the login (what RemoteAuth copies too). */
const LOGIN_DIRS = ["Default/IndexedDB", "Default/Local Storage"];
const SKIP = /^(Singleton\w*|LOCK|lockfile)$/;

/**
 * Why a login restore failed. Everything except "io" is deterministic (retrying cannot help): the cloud copy is
 * corrupt, gone or undecryptable. Plain errors (network, disk, Firestore) carry no kind and count as "io": retry.
 */
export type VaultFailureKind = "sha" | "decrypt" | "missing" | "nokey" | "noobject";
export class VaultFailure extends Error {
  constructor(readonly kind: VaultFailureKind, message: string) {
    super(message);
  }
}

export interface VaultDeps {
  dataDir: string;
  getMeta(uid: string): Promise<VaultMeta | null>;
  /**
   * Transaction: succeeds only if the stored gen still equals `expectedGen` (0 = none) AND users/{uid}/fleet/lease is
   * still held by `lease.server` at `lease.epoch` (a holder that was fenced and replaced must not commit).
   * Returns false on either conflict.
   */
  commitMeta(uid: string, expectedGen: number, meta: VaultMeta, lease: { server: string; epoch: number }): Promise<boolean>;
  /** Transaction: replace the meta with a tombstone at gen + 1 (never deletes the doc, so gens never reset). */
  writeTombstone(uid: string, server: string): Promise<VaultMeta>;
  getKey(uid: string): Promise<Buffer | null>;
  /** Transaction: returns the existing key or creates one. */
  getOrCreateKey(uid: string): Promise<Buffer>;
  deleteKey(uid: string): Promise<void>;
  /** Create-only: returns false (and writes nothing) when the object already exists. */
  putObject(objectPath: string, data: Buffer): Promise<boolean>;
  getObject(objectPath: string): Promise<Buffer | null>;
  deleteObject(objectPath: string): Promise<void>;
  /** Objects under a prefix with their creation time (ms; Date.now() when unknown, so an unknown age counts as new). */
  listObjects(prefix: string): Promise<{ name: string; createdAt: number }[]>;
}

function firebaseDeps(): VaultDeps {
  // Lazy: importing firebase.ts initialises the admin app, which tests must not do.
  const fb = () => import("./firebase.ts");
  // The "uid" given to every function here is a vault id: an account's uid, or `{uid}_agent` for its agent number's login.
  // Both live under the same account: their own meta doc and key, but the one lease (the agent runs wherever the account does).
  const vaultDoc = async (vid: string) => {
    const { uid, agent } = splitVaultId(vid);
    return (await fb()).userRef(uid).collection("fleet").doc(agent ? "vault_agent" : "vault");
  };
  const keyDoc = async (uid: string) => (await fb()).db.collection("vaultKeys").doc(uid);
  const bucket = async () => (await import("firebase-admin/storage")).getStorage().bucket();
  return {
    dataDir: process.env.WWEBJS_DATA ?? path.resolve(".wwebjs_auth"),
    async getMeta(uid) {
      const s = await (await vaultDoc(uid)).get();
      return s.exists ? (s.data() as VaultMeta) : null;
    },
    async commitMeta(uid, expectedGen, meta, lease) {
      const { db, userRef } = await fb();
      const ref = await vaultDoc(uid);
      const leaseRef = userRef(splitVaultId(uid).uid).collection("fleet").doc("lease");
      return db.runTransaction(async (tx) => {
        const [curSnap, leaseSnap] = await Promise.all([tx.get(ref), tx.get(leaseRef)]);
        const cur = curSnap.data() as VaultMeta | undefined;
        const l = leaseSnap.data() as { server?: string | null; epoch?: number } | undefined;
        if (!l || l.server !== lease.server || l.epoch !== lease.epoch) return false;
        if ((cur?.gen ?? 0) !== expectedGen) return false;
        tx.set(ref, meta);
        return true;
      });
    },
    async writeTombstone(uid, server) {
      const { db } = await fb();
      const ref = await vaultDoc(uid);
      return db.runTransaction(async (tx) => {
        const cur = (await tx.get(ref)).data() as VaultMeta | undefined;
        const meta: VaultMeta = { gen: (cur?.gen ?? 0) + 1, wiped: true, object: null, bytes: 0, sha256: "", savedAt: Date.now(), server };
        tx.set(ref, meta);
        return meta;
      });
    },
    async getKey(uid) {
      const s = await (await keyDoc(uid)).get();
      return s.exists ? Buffer.from(s.data()!.key as string, "base64") : null;
    },
    async getOrCreateKey(uid) {
      const { db } = await fb();
      const ref = await keyDoc(uid);
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (s.exists) return Buffer.from(s.data()!.key as string, "base64");
        const k = newKey();
        tx.set(ref, { key: k.toString("base64"), createdAt: Date.now() });
        return k;
      });
    },
    async deleteKey(uid) {
      await (await keyDoc(uid)).delete();
    },
    async putObject(objectPath, data) {
      try {
        await (await bucket()).file(objectPath).save(data, { resumable: false, contentType: "application/octet-stream", preconditionOpts: { ifGenerationMatch: 0 } });
        return true;
      } catch (e) {
        if ((e as { code?: number }).code === 412) return false;
        throw e;
      }
    },
    async getObject(objectPath) {
      const f = (await bucket()).file(objectPath);
      const [exists] = await f.exists();
      return exists ? (await f.download())[0] : null;
    },
    async deleteObject(objectPath) {
      await (await bucket()).file(objectPath).delete({ ignoreNotFound: true });
    },
    async listObjects(prefix) {
      const [files] = await (await bucket()).getFiles({ prefix });
      return files.map((f) => ({ name: f.name, createdAt: Date.parse(String(f.metadata.timeCreated ?? "")) || Date.now() }));
    },
  };
}

/** `epoch` is the lease epoch this server claimed: the commit is refused unless that lease is still ours. */
export interface UploadOpts {
  sessionReady: boolean;
  epoch: number;
  /** This session reached ready from a fresh QR link: with no marker yet, the cloud's current gen is its base (resolveMarker). */
  freshLink?: boolean;
  /**
   * A timer-driven upload (not a clean stop or a handoff): skipped when the login folders look unchanged since this
   * server's last upload of the same cloud gen. Stops and handoffs always upload.
   */
  periodic?: boolean;
}

export interface PrepareOpts {
  /** Fall back to a stale local profile when the cloud copy can't be read (instead of throwing). */
  allowStaleLocal?: boolean;
}

/** Cheap change detector for the login folders: file count, total bytes and newest mtime (lock files ignored). */
export async function loginFingerprint(profile: string, dirs: string[] = LOGIN_DIRS): Promise<string> {
  let files = 0;
  let bytes = 0;
  let newest = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.test(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        const st = await stat(full).catch(() => null);
        if (!st) continue;
        files++;
        bytes += st.size;
        newest = Math.max(newest, st.mtimeMs);
      }
    }
  };
  for (const rel of dirs) await walk(path.join(profile, rel));
  return `${files}:${bytes}:${Math.floor(newest)}`;
}

export function createVault(deps: VaultDeps, o: { missingRecheckMs?: number } = {}) {
  const missingRecheckMs = o.missingRecheckMs ?? 1_000;
  const profileDir = (uid: string) => path.join(deps.dataDir, `session-${uid}`);
  const markerFile = (uid: string) => path.join(deps.dataDir, `vault-${uid}.json`);
  const exists = (p: string) => stat(p).then(() => true, () => false);

  async function readMarker(uid: string): Promise<number | null> {
    try {
      const g = JSON.parse(await readFile(markerFile(uid), "utf8")).gen;
      return typeof g === "number" ? g : null;
    } catch {
      return null;
    }
  }
  async function writeMarker(uid: string, gen: number) {
    const tmp = `${markerFile(uid)}.tmp`;
    await writeFile(tmp, JSON.stringify({ gen }));
    await rename(tmp, markerFile(uid));
  }

  /** A crash between the two renames of a swap leaves only `.prev`: put it back. */
  async function recoverSwap(uid: string) {
    const p = profileDir(uid);
    if (!(await exists(p)) && (await exists(`${p}.prev`))) await rename(`${p}.prev`, p);
  }

  async function localGen(uid: string): Promise<number | null> {
    await recoverSwap(uid);
    if (!(await exists(profileDir(uid)))) return null;
    return (await readMarker(uid)) ?? 0; // pre-vault login counts as gen 0
  }

  async function downloadVerified(uid: string, meta: VaultMeta): Promise<Buffer> {
    // The object is written before its meta commits, and never overwritten, so one read is enough.
    if (!meta.object) throw new VaultFailure("noobject", `vault download failed for ${uid}: meta has no object`);
    let obj = await deps.getObject(meta.object);
    if (!obj) {
      // Only "missing" once it is confirmed by a second read; a flaky listing must not look like a lost login.
      await new Promise((r) => setTimeout(r, missingRecheckMs));
      obj = await deps.getObject(meta.object);
    }
    if (!obj) throw new VaultFailure("missing", `vault download failed for ${uid}: missing object`);
    if (sha256(obj) !== meta.sha256) throw new VaultFailure("sha", `vault download failed for ${uid}: sha256 mismatch`);
    return obj;
  }

  /**
   * With no local profile, throws a VaultFailure when the cloud copy is unusable for good (the caller then starts fresh) and a
   * plain Error for anything transient (network, disk, Firestore) so the caller can retry. With a local profile, a permanent
   * failure keeps it, and a transient one throws unless `allowStaleLocal` (the caller has retried enough).
   */
  async function prepareLogin(uid: string, opts: PrepareOpts = {}): Promise<"local" | "cloud" | "fresh"> {
    const [local, meta] = await Promise.all([localGen(uid), deps.getMeta(uid)]);
    const pick = pickLoginSource(local, meta);
    if (pick === "fresh" && local !== null) {
      // Wiped in the cloud since this copy was made: start Chromium clean.
      await removeLocal(uid);
      return "fresh";
    }
    if (pick !== "cloud") return pick;
    const m = meta!;

    // The cloud copy is newer than our local one, so the local profile is stale. Two different failures:
    // - the cloud copy is gone or corrupt for good (VaultFailure: sha, missing, no object, no key): keep the local profile
    //   as before (the caller never gets a QR for a login that may still work);
    // - the cloud copy is only unreachable right now (anything else): never silently use the stale profile while the lease
    //   is ours. Throw so the caller retries, unless it says it has retried enough (`allowStaleLocal`).
    let object: Buffer;
    let key: Buffer | null;
    try {
      object = await downloadVerified(uid, m);
      key = await deps.getKey(uid);
      if (!key) throw new VaultFailure("nokey", `vault key missing for ${uid}`);
    } catch (e) {
      if (local !== null && (e instanceof VaultFailure || opts.allowStaleLocal)) return "local";
      throw e;
    }
    let plain: Buffer;
    try {
      plain = decrypt(object, key, uid);
    } catch (e) {
      // Newer cloud copy that can't be decrypted: the local profile is stale, so remove it and let the caller start fresh (a QR)
      // instead of running an old login that could be rejected or overwrite newer state.
      if (local !== null) await removeLocal(uid).catch(() => undefined);
      throw new VaultFailure("decrypt", `vault decrypt failed for ${uid}: ${(e as Error).message}`);
    }
    await restore(uid, plain, m.gen); // atomic swap: a disk error leaves the local profile intact and is retried as "io"
    return "cloud";
  }

  /** Unpack `gz` over the local profile (atomic swap) and record its gen. */
  async function restore(uid: string, gz: Buffer, gen: number) {
    const profile = profileDir(uid);
    const next = `${profile}.new`;
    await rm(next, { recursive: true, force: true });
    try {
      await mkdir(next, { recursive: true });
      await unpackInto(gz, next);
    } catch (e) {
      await rm(next, { recursive: true, force: true });
      throw e;
    }
    const prev = `${profile}.prev`;
    await rm(prev, { recursive: true, force: true });
    const hadOld = await exists(profile);
    if (hadOld) await rename(profile, prev);
    try {
      await rename(next, profile);
    } catch (e) {
      if (hadOld) await rename(prev, profile).catch(() => undefined);
      await rm(next, { recursive: true, force: true });
      throw e;
    }
    await writeMarker(uid, gen);
    await rm(prev, { recursive: true, force: true });
  }

  /** Persist the cloud's current gen as this profile's gen (a new link), so a restart keeps it and the first upload is gen + 1. */
  async function adoptCloudGen(uid: string): Promise<void> {
    await writeMarker(uid, (await deps.getMeta(uid))?.gen ?? 0);
  }

  /** Per uid, in memory: fingerprint of the login folders at the last committed upload, and the gen it produced. */
  const lastUpload = new Map<string, { fp: string; gen: number }>();
  const uploadChain = new Map<string, Promise<unknown>>();
  function uploadLogin(uid: string, server: string, opts: UploadOpts): Promise<VaultMeta | null> {
    const run = (uploadChain.get(uid) ?? Promise.resolve()).catch(() => undefined).then(() => doUpload(uid, server, opts));
    const tail = run.catch(() => undefined);
    uploadChain.set(uid, tail);
    void tail.then(() => {
      if (uploadChain.get(uid) === tail) uploadChain.delete(uid);
    });
    return run;
  }

  async function doUpload(uid: string, server: string, opts: UploadOpts): Promise<VaultMeta | null> {
    const profile = profileDir(uid);
    if (!(await exists(path.join(profile, LOGIN_DIRS[0])))) return null;
    const cloud = await deps.getMeta(uid);
    const stored = await readMarker(uid);
    // The marker can lag the cloud while we hold the lease (see resolveMarker): raise it, since the gen is provably ours.
    const resolved = resolveMarker({ marker: stored, cloud, server, epoch: opts.epoch, freshLink: opts.freshLink });
    const marker = resolved.gen;
    if (resolved.adopt) await writeMarker(uid, marker);
    if (!mayUpload({ sessionReady: opts.sessionReady, localGen: marker, cloudGen: cloud?.gen ?? null })) return null;
    const expected = cloud?.gen ?? 0;
    // Taken before the snapshot, so anything written while we copy still counts as a change next time.
    const fp = await loginFingerprint(profile);
    const last = lastUpload.get(uid);
    if (opts.periodic && last && last.fp === fp && last.gen === expected) return null; // nothing new to save
    const gen = expected + 1;
    const objectPath = vaultObjectPath(uid, gen, randomBytes(8).toString("hex")); // unique per attempt: never collides with another writer

    // Chromium may be running: snapshot the login folders, then archive the snapshot.
    const tmp = await mkdtemp(path.join(os.tmpdir(), "spot-vault-"));
    let wrote = false;
    try {
      for (const rel of LOGIN_DIRS) {
        const src = path.join(profile, rel);
        if (!(await exists(src))) continue;
        await cp(src, path.join(tmp, rel), { recursive: true, filter: (f) => !SKIP.test(path.basename(f)), errorOnExist: false });
      }
      // The snapshot took a while: a logout may have tombstoned the meta meanwhile. Check again before creating a key.
      const latest = await deps.getMeta(uid);
      if ((latest?.gen ?? 0) !== expected || !mayUpload({ sessionReady: opts.sessionReady, localGen: marker, cloudGen: latest?.gen ?? null })) return null;
      const key = await deps.getOrCreateKey(uid);
      const object = await encrypt(packFolders(tmp, LOGIN_DIRS), key, uid);

      try {
        wrote = await deps.putObject(objectPath, object);
        if (!wrote) return null; // names are random, so this is a storage anomaly: leave the object alone and retry next time
        const meta: VaultMeta = { gen, savedAt: Date.now(), server, object: objectPath, bytes: object.length, sha256: sha256(object), epoch: opts.epoch };
        let committed: boolean;
        try {
          // Also checked inside the transaction: this server must still hold the lease at `opts.epoch`, or a slow
          // upload that outlived a fence and a takeover would commit over the new holder's login.
          committed = await deps.commitMeta(uid, expected, meta, { server, epoch: opts.epoch });
        } catch (e) {
          // Ambiguous (timeout, dropped connection): the commit may have landed. Ask the cloud which object it points at.
          const cur = await deps.getMeta(uid).then((m) => ({ m }), () => undefined);
          if (!cur) {
            wrote = false; // can't tell: keep the object, the age-based cleanup will remove it if it was never referenced
            throw e;
          }
          if (cur.m?.object !== objectPath) throw e; // not ours: the outer catch deletes our object
          committed = true;
        }
        if (!committed) {
          await deps.deleteObject(objectPath).catch(() => undefined); // lost the race or the lease; ours is unreferenced
          wrote = false;
          return null;
        }
        wrote = false; // committed: now referenced, never delete it
        await writeMarker(uid, gen);
        lastUpload.set(uid, { fp, gen });
        await deleteStale(uid, objectPath);
        return meta;
      } catch (e) {
        if (wrote) await deps.deleteObject(objectPath).catch(() => undefined);
        throw e;
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /**
   * Best effort: drop login objects other than the committed one once they are old enough that no writer or reader can
   * still be using them (an unreferenced orphan, a superseded gen). A legacy `login.bin` is ignored.
   */
  async function deleteStale(uid: string, keep: string) {
    try {
      const cutoff = Date.now() - VAULT_OBJECT_MIN_AGE_MS;
      for (const o of await deps.listObjects(vaultObjectPrefix(uid))) {
        if (o.name !== keep && /\/login-[^/]+\.bin$/.test(o.name) && o.createdAt < cutoff) await deps.deleteObject(o.name).catch(() => undefined);
      }
    } catch {
      /* the next upload retries */
    }
  }

  async function removeLocal(uid: string) {
    const p = profileDir(uid);
    await Promise.all([p, `${p}.prev`, `${p}.new`, path.join(deps.dataDir, `backup-${uid}`), markerFile(uid)].map((f) => rm(f, { recursive: true, force: true })));
  }

  /**
   * Logout: tombstone the meta first (gen keeps rising), then remove every local and cloud copy and the key. If the
   * tombstone write fails nothing has been deleted yet, so the account is still recoverable.
   */
  async function wipeLogin(uid: string, server: string): Promise<void> {
    await deps.writeTombstone(uid, server);
    lastUpload.delete(uid);
    await removeLocal(uid);
    for (const o of await deps.listObjects(vaultObjectPrefix(uid))) await deps.deleteObject(o.name);
    await deps.deleteKey(uid);
  }

  return { localGen, prepareLogin, uploadLogin, adoptCloudGen, wipeLogin };
}

let shared: ReturnType<typeof createVault> | undefined;
const vault = () => (shared ??= createVault(firebaseDeps()));

/** Gen recorded next to the local profile, or null when there is no local profile. */
export const localGen = (uid: string): Promise<number | null> => vault().localGen(uid);

/** Make the local profile the newest available copy (download + decrypt if the cloud is newer). */
export const prepareLogin = (uid: string, opts?: PrepareOpts): Promise<"local" | "cloud" | "fresh"> => vault().prepareLogin(uid, opts);

/**
 * Upload the local login as gen+1. Call only while holding the lease (`epoch` is re-checked inside the commit).
 * Refused (null) unless the session is ready and the local copy is not behind the cloud, or the lease moved on.
 * Calls for one uid are serialized.
 */
export const uploadLogin = (uid: string, server: string, opts: UploadOpts): Promise<VaultMeta | null> => vault().uploadLogin(uid, server, opts);

/** Call when a fresh link becomes ready: record the current cloud gen as the local gen. */
export const adoptCloudGen = (uid: string): Promise<void> => vault().adoptCloudGen(uid);

/** Logout: tombstone the vault meta (gens never reset) and remove the local profile, cloud objects and key. */
export const wipeLogin = (uid: string, server: string): Promise<void> => vault().wipeLogin(uid, server);
