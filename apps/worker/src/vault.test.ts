import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VaultMeta } from "@spot/shared";
import { VAULT_OBJECT_MIN_AGE_MS, vaultObjectPath } from "@spot/shared";
import { packFolders, unpackInto } from "./vault-archive.ts";
import { decrypt, encrypt, newKey, sha256 } from "./vault-crypto.ts";
import { VaultFailure, createVault, type VaultDeps } from "./vault.ts";

const DIRS = ["Default/IndexedDB", "Default/Local Storage"];
let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "vault-test-"));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

async function fakeProfile(dir: string, seed = "a") {
  const files: Record<string, Buffer> = {
    "Default/IndexedDB/https_web.whatsapp.com_0.indexeddb.leveldb/000005.ldb": randomBytes(300_000),
    "Default/IndexedDB/https_web.whatsapp.com_0.indexeddb.leveldb/CURRENT": Buffer.from(`MANIFEST-${seed}\n`),
    "Default/Local Storage/leveldb/000003.log": randomBytes(5000),
    "Default/Local Storage/leveldb/empty": Buffer.alloc(0),
  };
  for (const [rel, b] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), b);
  }
  // not part of the login
  await mkdir(path.join(dir, "Default/Cache"), { recursive: true });
  await writeFile(path.join(dir, "Default/Cache/junk"), "x");
  return files;
}

async function collect(it: AsyncIterable<Buffer>) {
  const out: Buffer[] = [];
  for await (const c of it) out.push(c);
  return Buffer.concat(out);
}

describe("archive + crypto", () => {
  it("round-trips archive -> encrypt -> decrypt -> extract", async () => {
    const src = path.join(tmp, "src");
    const files = await fakeProfile(src);
    const key = newKey();
    const obj = await encrypt(packFolders(src, DIRS), key, "u1");
    const dest = path.join(tmp, "dest");
    const n = await unpackInto(decrypt(obj, key, "u1"), dest);
    expect(n).toBe(Object.keys(files).length);
    for (const [rel, b] of Object.entries(files)) expect((await readFile(path.join(dest, rel))).equals(b)).toBe(true);
    await expect(stat(path.join(dest, "Default/Cache"))).rejects.toThrow();
  });

  it("uses a fresh IV per upload", async () => {
    const src = path.join(tmp, "src");
    await fakeProfile(src);
    const key = newKey();
    const a = await encrypt(packFolders(src, DIRS), key, "u1");
    const b = await encrypt(packFolders(src, DIRS), key, "u1");
    expect(a.subarray(5, 17).equals(b.subarray(5, 17))).toBe(false);
  });

  it("detects a flipped byte, a flipped tag, the wrong key and the wrong account", async () => {
    const src = path.join(tmp, "src");
    await fakeProfile(src);
    const key = newKey();
    const obj = await encrypt(packFolders(src, DIRS), key, "u1");
    for (const at of [obj.length - 1, 100, 20]) {
      const bad = Buffer.from(obj);
      bad[at] ^= 1;
      expect(() => decrypt(bad, key, "u1")).toThrow();
    }
    expect(() => decrypt(obj, newKey(), "u1")).toThrow();
    expect(() => decrypt(obj, key, "u2")).toThrow();
    expect(() => decrypt(obj.subarray(0, 10), key, "u1")).toThrow();
  });

  it("rejects archive paths that escape the destination", async () => {
    const { createGzip } = await import("node:zlib");
    const name = Buffer.from("../evil");
    const head = Buffer.alloc(2 + name.length + 8);
    head.writeUInt16BE(name.length, 0);
    name.copy(head, 2);
    head.writeBigUInt64BE(1n, 2 + name.length);
    const gz = createGzip();
    gz.end(Buffer.concat([head, Buffer.from("x")]));
    await expect(unpackInto(await collect(gz as unknown as AsyncIterable<Buffer>), path.join(tmp, "d"))).rejects.toThrow(/unsafe/);
  });

  it("reports size/time on a ~100 MB fake profile", async () => {
    const src = path.join(tmp, "big");
    await mkdir(path.join(src, DIRS[0]), { recursive: true });
    // half compressible (text-like), half random: roughly leveldb-like
    for (let i = 0; i < 10; i++) {
      const text = Buffer.alloc(5 * 1024 * 1024, `row-${i}-{"id":"abcdef","t":1}`);
      await writeFile(path.join(src, DIRS[0], `${i}.ldb`), Buffer.concat([text, randomBytes(5 * 1024 * 1024)]));
    }
    const t0 = Date.now();
    const key = newKey();
    const obj = await encrypt(packFolders(src, DIRS), key, "u1");
    const t1 = Date.now();
    await unpackInto(decrypt(obj, key, "u1"), path.join(tmp, "out"));
    console.log(`vault perf: 100 MB raw -> ${(obj.length / 1e6).toFixed(1)} MB, pack+encrypt ${t1 - t0} ms, decrypt+extract ${Date.now() - t1} ms`);
    expect(obj.length).toBeLessThan(100 * 1024 * 1024);
  }, 60_000);
});

/** In-memory Firestore + Storage. */
function mockDeps(dataDir: string) {
  const s = {
    meta: new Map<string, VaultMeta>(),
    keys: new Map<string, Buffer>(),
    objects: new Map<string, Buffer>(),
    created: new Map<string, number>(), // object creation times (ms); tests age objects by editing this
    lease: new Map<string, { server: string; epoch: number }>(), // users/{uid}/fleet/lease; no entry = not checked (see commitMeta)
  };
  const deps: VaultDeps = {
    dataDir,
    getMeta: async (u) => s.meta.get(u) ?? null,
    commitMeta: async (u, expected, m, fence) => {
      // The real transaction rejects a missing lease doc; the mock only checks when a test set one.
      const l = s.lease.get(u);
      if (l && (l.server !== fence.server || l.epoch !== fence.epoch)) return false;
      if ((s.meta.get(u)?.gen ?? 0) !== expected) return false;
      s.meta.set(u, m);
      return true;
    },
    writeTombstone: async (u, server) => {
      const m: VaultMeta = { gen: (s.meta.get(u)?.gen ?? 0) + 1, wiped: true, object: null, bytes: 0, sha256: "", savedAt: Date.now(), server };
      s.meta.set(u, m);
      return m;
    },
    getKey: async (u) => s.keys.get(u) ?? null,
    getOrCreateKey: async (u) => {
      if (!s.keys.has(u)) s.keys.set(u, newKey());
      return s.keys.get(u)!;
    },
    deleteKey: async (u) => void s.keys.delete(u),
    putObject: async (p, data) => {
      if (s.objects.has(p)) return false;
      s.objects.set(p, Buffer.from(data));
      s.created.set(p, Date.now());
      return true;
    },
    getObject: async (p) => s.objects.get(p) ?? null,
    deleteObject: async (p) => void s.objects.delete(p),
    listObjects: async (prefix) => [...s.objects.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name, createdAt: s.created.get(name) ?? Date.now() })),
  };
  return { s, deps };
}

const up = { sessionReady: true, epoch: 1 };
const NAME = (uid: string, gen: number) => new RegExp(`^vault/${uid}/login-${gen}-[0-9a-f]{16}\\.bin$`);
const objOf = (m: { s: { meta: Map<string, VaultMeta> } }, uid: string) => m.s.meta.get(uid)!.object!;
const old = (ms = VAULT_OBJECT_MIN_AGE_MS + 1_000) => Date.now() - ms;

describe("vault gen logic", () => {
  let A: string, B: string; // two servers' data dirs
  beforeEach(async () => {
    A = path.join(tmp, "A");
    B = path.join(tmp, "B");
    await mkdir(A);
    await mkdir(B);
  });

  it("fresh when nothing exists anywhere; migration counts a pre-vault login as local gen 0", async () => {
    const { deps } = mockDeps(A);
    const v = createVault(deps);
    expect(await v.localGen("u1")).toBeNull();
    expect(await v.prepareLogin("u1")).toBe("fresh");
    await fakeProfile(path.join(A, "session-u1"));
    expect(await v.localGen("u1")).toBe(0);
    expect(await v.prepareLogin("u1")).toBe("local");
  });

  it("uploads gen+1 each time and moves the account to a second server; newest copy wins", async () => {
    const mA = mockDeps(A);
    const vA = createVault(mA.deps);
    const files = await fakeProfile(path.join(A, "session-u1"), "one");

    const m1 = await vA.uploadLogin("u1", "serverA", up);
    expect(m1?.gen).toBe(1);
    expect(await vA.localGen("u1")).toBe(1);
    expect(m1?.object).toMatch(NAME("u1", 1));
    expect(mA.s.objects.has(m1!.object!)).toBe(true);
    mA.s.created.set(m1!.object!, old()); // the superseded gen is only removed once it is old enough
    expect((await vA.uploadLogin("u1", "serverA", up))?.gen).toBe(2);
    expect([...mA.s.objects.keys()]).toEqual([objOf(mA, "u1")]);
    expect(objOf(mA, "u1")).toMatch(NAME("u1", 2));

    // server B shares the same cloud
    const vB = createVault({ ...mA.deps, dataDir: B });
    expect(await vB.localGen("u1")).toBeNull();
    expect(await vB.prepareLogin("u1")).toBe("cloud");
    expect(await vB.localGen("u1")).toBe(2);
    for (const [rel, b] of Object.entries(files)) expect((await readFile(path.join(B, "session-u1", rel))).equals(b)).toBe(true);
    expect((await readdir(B)).filter((n) => n.endsWith(".prev") || n.endsWith(".new"))).toEqual([]);
    expect(await vB.prepareLogin("u1")).toBe("local"); // already current

    // B runs it, uploads gen 3; A's local copy (gen 2) is now stale
    expect((await vB.uploadLogin("u1", "serverB", up))?.gen).toBe(3);
    expect(await vA.prepareLogin("u1")).toBe("cloud");
    expect(await vA.localGen("u1")).toBe(3);
  });

  it("a stale local profile is replaced and the old one is not left behind", async () => {
    const m = mockDeps(A);
    const vA = createVault(m.deps);
    await fakeProfile(path.join(A, "session-u1"), "old");
    await vA.uploadLogin("u1", "A", up); // gen 1
    const vB = createVault({ ...m.deps, dataDir: B });
    await fakeProfile(path.join(B, "session-u1"), "ancient");
    expect(await vB.localGen("u1")).toBe(0);
    expect(await vB.prepareLogin("u1")).toBe("cloud");
    expect((await readFile(path.join(B, "session-u1", DIRS[0], "https_web.whatsapp.com_0.indexeddb.leveldb/CURRENT"), "utf8"))).toContain("old");
    expect((await readdir(B)).sort()).toEqual(["session-u1", "vault-u1.json"]);
  });

  it("a conflicting commit returns null, removes its own object and leaves the marker alone", async () => {
    const m = mockDeps(A);
    const v = createVault(m.deps);
    await fakeProfile(path.join(A, "session-u1"));
    const orig = m.deps.commitMeta;
    m.deps.commitMeta = async (u, _e, meta, f) => orig(u, 7, meta, f); // simulate a concurrent writer
    expect(await v.uploadLogin("u1", "A", up)).toBeNull();
    expect(await v.localGen("u1")).toBe(0);
    expect(m.s.objects.size).toBe(0);
  });

  it("falls back to local when the cloud object is corrupt, throws when there is no local copy", async () => {
    const m = mockDeps(A);
    const vA = createVault(m.deps);
    await fakeProfile(path.join(A, "session-u1"));
    await vA.uploadLogin("u1", "A", up);
    m.s.meta.set("u1", { ...m.s.meta.get("u1")!, gen: 5 });
    m.s.objects.get(objOf(m, "u1"))![50] ^= 1; // sha mismatch
    expect(await vA.prepareLogin("u1")).toBe("local");
    const vB = createVault({ ...m.deps, dataDir: B });
    await expect(vB.prepareLogin("u1")).rejects.toThrow(/sha256/);
    expect(await vB.localGen("u1")).toBeNull();
  });

  it("a failed cloud restore removes the stale local profile instead of keeping it", async () => {
    const m = mockDeps(A);
    const vA = createVault(m.deps);
    await fakeProfile(path.join(A, "session-u1"), "keepme");
    await vA.uploadLogin("u1", "A", up);
    const o = m.s.objects.get(objOf(m, "u1"))!;
    o[o.length - 1] ^= 1;
    m.s.meta.set("u1", { ...m.s.meta.get("u1")!, gen: 9, sha256: sha256(o) });
    const v2 = createVault({ ...m.deps, dataDir: A });
    expect(await v2.localGen("u1")).toBe(1); // stale: the cloud is at gen 9
    await expect(v2.prepareLogin("u1")).rejects.toThrow(); // vaultCalls turns this into "fresh"
    expect(await v2.localGen("u1")).toBeNull(); // the stale profile is gone, so the next start can't run it
    expect(await readdir(A)).toEqual([]);
  });

  it("recovers a profile left as .prev by a crash mid-swap", async () => {
    const { deps } = mockDeps(A);
    const v = createVault(deps);
    await fakeProfile(path.join(A, "session-u1.prev"));
    expect(await v.localGen("u1")).toBe(0);
    expect((await stat(path.join(A, "session-u1"))).isDirectory()).toBe(true);
  });

  it("wipeLogin leaves a tombstone, removes local profile, marker, objects and key", async () => {
    const m = mockDeps(A);
    const v = createVault(m.deps);
    await fakeProfile(path.join(A, "session-u1"));
    await v.uploadLogin("u1", "A", up);
    m.s.objects.set("vault/u1/login.bin", Buffer.from("legacy"));
    await v.wipeLogin("u1", "A");
    expect(await readdir(A)).toEqual([]);
    expect(m.s.objects.size + m.s.keys.size).toBe(0);
    expect(m.s.meta.get("u1")).toMatchObject({ gen: 2, wiped: true, object: null, bytes: 0, sha256: "", server: "A" });
    expect(await v.prepareLogin("u1")).toBe("fresh");
  });

  it("wipe then relink on A: B's stale higher-gen profile is dropped, never used", async () => {
    const m = mockDeps(A);
    const vA = createVault(m.deps);
    await fakeProfile(path.join(A, "session-u1"));
    for (let i = 0; i < 4; i++) await vA.uploadLogin("u1", "A", up); // gen 4
    const vB = createVault({ ...m.deps, dataDir: B });
    expect(await vB.prepareLogin("u1")).toBe("cloud"); // B holds gen 4
    await vA.wipeLogin("u1", "A"); // tombstone gen 5
    expect(await vB.prepareLogin("u1")).toBe("fresh");
    expect(await readdir(B)).toEqual([]);
    // relink on A, then B must not resurrect anything old
    await fakeProfile(path.join(A, "session-u1"), "relinked");
    await vA.adoptCloudGen("u1");
    expect((await vA.uploadLogin("u1", "A", up))?.gen).toBe(6);
    expect(await vB.prepareLogin("u1")).toBe("cloud");
    expect(await vB.localGen("u1")).toBe(6);
  });

  it("a stale profile behind a tombstone is removed even without a relink", async () => {
    const m = mockDeps(A);
    const v = createVault(m.deps);
    await fakeProfile(path.join(A, "session-u1"));
    await v.uploadLogin("u1", "A", up);
    await writeFile(path.join(A, "vault-u1.json"), JSON.stringify({ gen: 1 }));
    m.s.meta.set("u1", { gen: 2, wiped: true, object: null, bytes: 0, sha256: "", savedAt: 1, server: "Z" });
    expect(await v.prepareLogin("u1")).toBe("fresh");
    expect(await v.localGen("u1")).toBeNull();
    expect(await readdir(A)).toEqual([]);
  });

  it("refuses to upload when the session is not ready or the local gen is behind the cloud", async () => {
    const m = mockDeps(A);
    const vA = createVault(m.deps);
    await fakeProfile(path.join(A, "session-u1"));
    expect(await vA.uploadLogin("u1", "A", { sessionReady: false, epoch: 1 })).toBeNull();
    expect(m.s.objects.size).toBe(0);
    await vA.uploadLogin("u1", "A", up); // gen 1
    const vB = createVault({ ...m.deps, dataDir: B });
    await fakeProfile(path.join(B, "session-u1"), "stale"); // marker missing => gen 0, cloud gen 1
    expect(await vB.uploadLogin("u1", "B", up)).toBeNull();
    expect(m.s.meta.get("u1")?.gen).toBe(1);
  });

  it("adoptCloudGen, restart, then the profile counts as local; first upload is gen + 1", async () => {
    const m = mockDeps(A);
    const v = createVault(m.deps);
    m.s.meta.set("u1", { gen: 5, wiped: true, object: null, bytes: 0, sha256: "", savedAt: 1, server: "Z" });
    await fakeProfile(path.join(A, "session-u1"));
    await v.adoptCloudGen("u1");
    const restarted = createVault(m.deps); // fresh instance = restart
    expect(await restarted.localGen("u1")).toBe(5);
    expect(await restarted.prepareLogin("u1")).toBe("local");
    expect((await restarted.uploadLogin("u1", "A", up))?.gen).toBe(6);
    // no cloud meta at all adopts gen 0
    const m2 = mockDeps(B);
    await fakeProfile(path.join(B, "session-u2"));
    await createVault(m2.deps).adoptCloudGen("u2");
    expect(await createVault(m2.deps).localGen("u2")).toBe(0);
  });

  it("two racing uploads for one uid: one commit wins, its object verifies, no stray objects", async () => {
    const m = mockDeps(A);
    await fakeProfile(path.join(A, "session-u1"));
    // two vault instances = no shared chain, so the race reaches storage/Firestore
    const written: string[] = [];
    const put = m.deps.putObject;
    m.deps.putObject = async (p, d) => (written.push(p), put(p, d));
    const [r1, r2] = await Promise.all([createVault(m.deps).uploadLogin("u1", "A", up), createVault(m.deps).uploadLogin("u1", "A", up)]);
    expect([r1, r2].filter(Boolean)).toHaveLength(1);
    const meta = m.s.meta.get("u1")!;
    expect(meta.object).toMatch(NAME("u1", 1));
    expect(sha256(m.s.objects.get(meta.object!)!)).toBe(meta.sha256);
    // the loser's object is not deleted by the winner and not collided with: it removed only its own (or is still there, fresh)
    expect([...m.s.objects.keys()].filter((k) => k === meta.object)).toEqual([meta.object]);
    expect(new Set(written).size).toBe(written.length); // every attempt used its own object name
    expect(written).toHaveLength(2);
  });

  it("same-instance calls are serialized: both succeed with gens 1 and 2", async () => {
    const m = mockDeps(A);
    const v = createVault(m.deps);
    await fakeProfile(path.join(A, "session-u1"));
    const r = await Promise.all([v.uploadLogin("u1", "A", up), v.uploadLogin("u1", "A", up)]);
    expect(r.map((x) => x?.gen)).toEqual([1, 2]);
  });

  it("a loser whose commit fails removes only its own object", async () => {
    const m = mockDeps(A);
    const v = createVault(m.deps);
    await fakeProfile(path.join(A, "session-u1"));
    const orig = m.deps.commitMeta;
    m.deps.commitMeta = async (u, e, meta, f) => {
      // another server commits gen 1 (its own object) between our object write and our commit
      const theirs = vaultObjectPath(u, 2, "theirs");
      m.s.objects.set(theirs, Buffer.from("theirs"));
      m.s.meta.set(u, { gen: 2, savedAt: 1, server: "Z", object: theirs, bytes: 6, sha256: sha256(Buffer.from("theirs")) });
      return orig(u, e, meta, f);
    };
    expect(await v.uploadLogin("u1", "A", up)).toBeNull();
    expect([...m.s.objects.keys()]).toEqual([vaultObjectPath("u1", 2, "theirs")]);
  });

  it("a crash between object write and meta commit leaves the previous meta valid", async () => {
    const m = mockDeps(A);
    const v = createVault(m.deps);
    await fakeProfile(path.join(A, "session-u1"));
    await v.uploadLogin("u1", "A", up); // gen 1
    const before = m.s.meta.get("u1")!;
    m.deps.commitMeta = async () => {
      throw new Error("crash");
    };
    await expect(v.uploadLogin("u1", "A", up)).rejects.toThrow("crash");
    expect(m.s.meta.get("u1")).toEqual(before);
    expect(sha256(m.s.objects.get(before.object!)!)).toBe(before.sha256);
    const vB = createVault({ ...m.deps, dataDir: B });
    expect(await vB.prepareLogin("u1")).toBe("cloud");
  });

  it("a crash orphan at the next gen does not block the next upload, and is cleaned up only once old", async () => {
    const m = mockDeps(A);
    const v = createVault(m.deps);
    await fakeProfile(path.join(A, "session-u1"));
    const orphan = vaultObjectPath("u1", 1, "orphan");
    m.s.objects.set(orphan, Buffer.from("orphan"));
    m.s.created.set(orphan, Date.now());
    expect((await v.uploadLogin("u1", "A", up))?.gen).toBe(1);
    const meta = m.s.meta.get("u1")!;
    expect(meta.object).not.toBe(orphan);
    expect(sha256(m.s.objects.get(meta.object!)!)).toBe(meta.sha256);
    expect(m.s.objects.has(orphan)).toBe(true); // fresh: it could be another writer's in-flight upload
    m.s.created.set(orphan, old());
    expect((await v.uploadLogin("u1", "A", up))?.gen).toBe(2);
    expect(m.s.objects.has(orphan)).toBe(false);
  });

  it("cleanup after a commit deletes only login-* objects older than 10 minutes, never the committed one", async () => {
    const m = mockDeps(A);
    const v = createVault(m.deps);
    await fakeProfile(path.join(A, "session-u1"));
    const put = (name: string, age: number) => (m.s.objects.set(name, Buffer.from("x")), m.s.created.set(name, Date.now() - age));
    put("vault/u1/login-7-aaaa.bin", VAULT_OBJECT_MIN_AGE_MS + 1_000);
    put("vault/u1/login-8-bbbb.bin", VAULT_OBJECT_MIN_AGE_MS - 60_000);
    put("vault/u1/login.bin", VAULT_OBJECT_MIN_AGE_MS * 5); // legacy name: left alone
    put("vault/u2/login-1-cccc.bin", VAULT_OBJECT_MIN_AGE_MS * 5); // another account
    const meta = (await v.uploadLogin("u1", "A", up))!;
    expect([...m.s.objects.keys()].sort()).toEqual([meta.object!, "vault/u1/login-8-bbbb.bin", "vault/u1/login.bin", "vault/u2/login-1-cccc.bin"].sort());
  });

  it("a holder that lost its lease (fenced, then taken over) cannot commit; only its own object is removed", async () => {
    const m = mockDeps(A);
    const v = createVault(m.deps);
    await fakeProfile(path.join(A, "session-u1"));
    // the new holder already claimed at epoch 3 and restored/uploaded gen 1 meanwhile
    const theirs = vaultObjectPath("u1", 1, "theirs");
    m.s.objects.set(theirs, Buffer.from("theirs"));
    m.s.lease.set("u1", { server: "B", epoch: 3 });
    expect(await v.uploadLogin("u1", "A", { sessionReady: true, epoch: 2 })).toBeNull();
    expect(m.s.meta.has("u1")).toBe(false);
    expect([...m.s.objects.keys()]).toEqual([theirs]);
    expect(await v.localGen("u1")).toBe(0); // marker untouched
    // same server but an older epoch is refused too; the current holder succeeds
    m.s.lease.set("u1", { server: "A", epoch: 4 });
    expect(await v.uploadLogin("u1", "A", { sessionReady: true, epoch: 3 })).toBeNull();
    expect((await v.uploadLogin("u1", "A", { sessionReady: true, epoch: 4 }))?.gen).toBe(1);
  });

  it("an ambiguous commit error that actually landed keeps the object and writes the marker", async () => {
    const m = mockDeps(A);
    const v = createVault(m.deps);
    await fakeProfile(path.join(A, "session-u1"));
    const orig = m.deps.commitMeta;
    m.deps.commitMeta = async (u, e, meta, f) => {
      await orig(u, e, meta, f);
      throw new Error("deadline exceeded"); // the write went through, the reply was lost
    };
    const meta = await v.uploadLogin("u1", "A", up);
    expect(meta?.gen).toBe(1);
    expect(m.s.meta.get("u1")?.object).toBe(meta!.object);
    expect(m.s.objects.has(meta!.object!)).toBe(true);
    expect(await v.localGen("u1")).toBe(1);
  });

  it("an ambiguous commit error that did not land removes its object; one we can't verify keeps it", async () => {
    const m = mockDeps(A);
    const v = createVault(m.deps);
    await fakeProfile(path.join(A, "session-u1"));
    m.deps.commitMeta = async () => {
      throw new Error("deadline exceeded");
    };
    await expect(v.uploadLogin("u1", "A", up)).rejects.toThrow("deadline");
    expect(m.s.objects.size).toBe(0);
    // can't re-read the meta either: unknown, so the object stays (the age-based cleanup handles it later)
    const get = m.deps.getMeta;
    let calls = 0;
    m.deps.getMeta = async (u) => {
      if (++calls > 2) throw new Error("offline"); // doUpload's two reads succeed, the verification read fails
      return get(u);
    };
    await expect(v.uploadLogin("u1", "A", up)).rejects.toThrow("deadline");
    expect(m.s.objects.size).toBe(1);
  });

  it("never creates a vault key once a tombstone newer than its marker exists", async () => {
    const m = mockDeps(A);
    const v = createVault(m.deps);
    await fakeProfile(path.join(A, "session-u1"));
    m.s.meta.set("u1", { gen: 3, wiped: true, object: null, bytes: 0, sha256: "", savedAt: 1, server: "Z" });
    expect(await v.uploadLogin("u1", "A", up)).toBeNull(); // marker 0 < tombstone gen 3
    expect(m.s.keys.size).toBe(0);
    // a logout lands while the snapshot is being taken: the re-check before the key still refuses
    const m2 = mockDeps(B);
    await fakeProfile(path.join(B, "session-u2"));
    const get = m2.deps.getMeta;
    let calls = 0;
    m2.deps.getMeta = async (u) => {
      if (++calls === 2) m2.s.meta.set(u, { gen: 1, wiped: true, object: null, bytes: 0, sha256: "", savedAt: 1, server: "Z" });
      return get(u);
    };
    expect(await createVault(m2.deps).uploadLogin("u2", "A", up)).toBeNull();
    expect(m2.s.keys.size).toBe(0);
    expect(m2.s.objects.size).toBe(0);
  });

  it("wipeLogin writes the tombstone first: if that fails, nothing local or in the cloud was deleted", async () => {
    const m = mockDeps(A);
    const v = createVault(m.deps);
    await fakeProfile(path.join(A, "session-u1"));
    await v.uploadLogin("u1", "A", up);
    m.deps.writeTombstone = async () => {
      throw new Error("firestore down");
    };
    await expect(v.wipeLogin("u1", "A")).rejects.toThrow("firestore down");
    expect(await v.localGen("u1")).toBe(1);
    expect(m.s.objects.size).toBe(1);
    expect(m.s.keys.size).toBe(1);
  });

  it("an archive read error rejects instead of hanging", async () => {
    const src = path.join(tmp, "src");
    await fakeProfile(src);
    await chmod(path.join(src, DIRS[1], "leveldb/000003.log"), 0o000); // stat works, open fails
    try {
      await expect(Promise.race([encrypt(packFolders(src, DIRS), newKey(), "u1"), new Promise((_, rej) => setTimeout(() => rej(new Error("hung")), 5000))])).rejects.toThrow(/EACCES/);
    } finally {
      await chmod(path.join(src, DIRS[1], "leveldb/000003.log"), 0o600);
    }
  });

  it("uploadLogin returns null when there is no local login", async () => {
    const { deps } = mockDeps(A);
    expect(await createVault(deps).uploadLogin("nobody", "A", up)).toBeNull();
  });
});

describe("vault: marker lag, transient errors, fresh links", () => {
  let A: string, B: string;
  beforeEach(async () => {
    A = path.join(tmp, "A");
    B = path.join(tmp, "B");
    await mkdir(A);
    await mkdir(B);
  });

  it("a marker that lags the cloud is adopted when the cloud meta is ours under this epoch; other epochs stay blocked", async () => {
    const m = mockDeps(A);
    const v = createVault(m.deps);
    await fakeProfile(path.join(A, "session-u1"));
    expect((await v.uploadLogin("u1", "A", { sessionReady: true, epoch: 3 }))?.epoch).toBe(3);
    await writeFile(path.join(A, "vault-u1.json"), JSON.stringify({ gen: 0 })); // the marker write after the commit was lost
    expect(await v.uploadLogin("u1", "A", { sessionReady: true, epoch: 4 })).toBeNull(); // a different lease epoch: not provably ours
    expect((await v.uploadLogin("u1", "A", { sessionReady: true, epoch: 3 }))?.gen).toBe(2);
    expect(await v.localGen("u1")).toBe(2);
  });

  it("a fresh link with no marker uploads over a tombstone without adoptCloudGen; a plain session does not", async () => {
    const m = mockDeps(A);
    const v = createVault(m.deps);
    await m.deps.writeTombstone("u1", "x");
    await fakeProfile(path.join(A, "session-u1"));
    await rm(path.join(A, "vault-u1.json"), { force: true });
    expect(await v.uploadLogin("u1", "A", { sessionReady: true, epoch: 1 })).toBeNull();
    expect((await v.uploadLogin("u1", "A", { sessionReady: true, epoch: 1, freshLink: true }))?.gen).toBe(2);
  });

  it("a transient download error with a local copy throws (no silent stale start) until allowStaleLocal", async () => {
    const m = mockDeps(A);
    const vA = createVault(m.deps);
    await fakeProfile(path.join(A, "session-u1"));
    await vA.uploadLogin("u1", "A", up);
    m.s.meta.set("u1", { ...m.s.meta.get("u1")!, gen: 5 }); // another server is ahead
    const flaky = createVault({ ...m.deps, getObject: async () => { throw new Error("ETIMEDOUT"); } });
    await expect(flaky.prepareLogin("u1")).rejects.toThrow(/ETIMEDOUT/);
    expect(await flaky.prepareLogin("u1", { allowStaleLocal: true })).toBe("local");
    expect(await vA.localGen("u1")).toBe(1); // untouched
  });

  it("an object is only 'missing' after a second read; the failure is a deterministic VaultFailure", async () => {
    const m = mockDeps(A);
    const vA = createVault(m.deps);
    await fakeProfile(path.join(A, "session-u1"));
    await vA.uploadLogin("u1", "A", up);
    let reads = 0;
    const vB = createVault({ ...m.deps, dataDir: B, getObject: async (p) => (++reads === 1 ? null : m.s.objects.get(p) ?? null) }, { missingRecheckMs: 0 });
    expect(await vB.prepareLogin("u1")).toBe("cloud"); // the first read was a blip
    m.s.objects.clear();
    reads = 10;
    await expect(createVault({ ...m.deps, dataDir: path.join(tmp, "C") }, { missingRecheckMs: 0 }).prepareLogin("u1")).rejects.toBeInstanceOf(VaultFailure);
  });
});
