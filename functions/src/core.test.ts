import { beforeEach, describe, expect, it } from "vitest";
import { AppError, createJoinCode, redeemJoinCode, removeServer, type Deps } from "./core";
import { CODE_TTL_MS, hashCode, normaliseCode, serviceAccountEmail } from "./logic";
import type { Gcp, JoinCodeDoc, ServerInfo, ServerKeyDoc, Store } from "./ports";

const NOW = 1_700_000_000_000;

function makeFakes() {
  const accounts = new Map<string, { keys: string[]; project: Set<string>; bucket: Set<string> }>();
  const calls: string[] = [];
  const failOn = new Set<string>();
  let keySeq = 0;
  const gcp: Gcp = {
    async serviceAccountExists(e) {
      return accounts.has(e);
    },
    async createServiceAccount(id) {
      if (failOn.has("create")) throw new Error("boom");
      calls.push(`create ${id}`);
      accounts.set(serviceAccountEmail(id), { keys: [], project: new Set(), bucket: new Set() });
    },
    async createKey(e) {
      if (failOn.has("key")) throw new Error("boom");
      const id = `key${++keySeq}`;
      accounts.get(e)!.keys.push(id);
      return { keyId: id, json: { type: "service_account", project_id: "spot-solutions", client_email: e, private_key: "PK" } };
    },
    async listUserKeyIds(e) {
      return [...(accounts.get(e)?.keys ?? [])];
    },
    async deleteKey(e, k) {
      calls.push(`deleteKey ${e} ${k}`);
      const a = accounts.get(e)!;
      a.keys = a.keys.filter((x) => x !== k);
    },
    async deleteServiceAccount(e) {
      calls.push(`deleteAccount ${e}`);
      accounts.delete(e);
    },
    async setProjectRoles(e, mode, roles) {
      calls.push(`project ${mode} ${roles.join(",")}`);
      const a = accounts.get(e);
      if (!a) throw new Error("no account");
      roles.forEach((r) => (mode === "add" ? a.project.add(r) : a.project.delete(r)));
    },
    async setBucketRoles(e, mode, roles) {
      calls.push(`bucket ${mode} ${roles.join(",")}`);
      const a = accounts.get(e);
      if (!a) throw new Error("no account");
      roles.forEach((r) => (mode === "add" ? a.bucket.add(r) : a.bucket.delete(r)));
    },
  };

  const codes = new Map<string, JoinCodeDoc>();
  const serverKeys = new Map<string, ServerKeyDoc>();
  const servers = new Map<string, ServerInfo>();
  const leases = new Map<string, string[]>();
  const attempts = new Map<string, number>();
  let admins = ["admin@example.com"];
  const store: Store = {
    async isAdmin(e) {
      return admins.includes(e);
    },
    async putCode(h, d) {
      codes.set(h, d);
    },
    async claimCode(h, now) {
      const d = codes.get(h);
      if (!d || d.used || now >= d.expiresAt) return { ok: false };
      d.used = true;
      return { ok: true, code: { ...d } };
    },
    async releaseCode(h) {
      const d = codes.get(h);
      if (d) d.used = false;
    },
    async finishCode(h, sa) {
      codes.get(h)!.serviceAccount = sa;
    },
    async allowAttempt(k, _now, limit) {
      const n = (attempts.get(k) ?? 0) + 1;
      attempts.set(k, n);
      return n <= limit;
    },
    async putServerKey(e, d) {
      serverKeys.set(e, d);
    },
    async findServerKeys(slugs) {
      return [...serverKeys].filter(([, d]) => slugs.includes(d.deviceSlug)).map(([email, doc]) => ({ email, doc }));
    },
    async hasServerKey(e) {
      return serverKeys.has(e);
    },
    async deleteServerKey(e) {
      serverKeys.delete(e);
    },
    async getServer(id) {
      return servers.get(id) ?? null;
    },
    async leaseHolders(id) {
      return leases.get(id) ?? [];
    },
    async deleteServerDocs(id) {
      servers.delete(id);
      calls.push(`deleteDocs ${id}`);
    },
    async sweepCodes() {},
  };
  const deps: Deps = { gcp, store, now: () => NOW, sleep: async () => {}, log: () => {} };
  return { deps, accounts, codes, serverKeys, servers, leases, calls, failOn, setAdmins: (a: string[]) => (admins = a) };
}

const ADMIN = { email: "Admin@Example.com", verified: true };
let f: ReturnType<typeof makeFakes>;
beforeEach(() => (f = makeFakes()));

describe("createJoinCode", () => {
  it("makes a 15 minute code and stores only its hash", async () => {
    const r = await createJoinCode(f.deps, ADMIN, { deviceName: "  Studio Mac " });
    expect(r.code).toMatch(/^SPOT-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(r.expiresAt).toBe(NOW + CODE_TTL_MS);
    const stored = [...f.codes];
    expect(stored).toHaveLength(1);
    expect(stored[0]![0]).toBe(hashCode(r.code));
    expect(JSON.stringify(stored)).not.toContain(r.code);
    expect(stored[0]![1]).toMatchObject({ createdBy: "admin@example.com", createdAt: NOW, used: false, deviceName: "Studio Mac" });
  });

  it("refuses non-admins, unverified emails and signed-out callers", async () => {
    await expect(createJoinCode(f.deps, { email: "x@example.com", verified: true }, {})).rejects.toMatchObject({ code: "permission-denied" });
    await expect(createJoinCode(f.deps, { email: "admin@example.com", verified: false }, {})).rejects.toMatchObject({ code: "permission-denied" });
    await expect(createJoinCode(f.deps, {}, {})).rejects.toMatchObject({ code: "permission-denied" });
    expect(f.codes.size).toBe(0);
  });
});

describe("redeemJoinCode", () => {
  const redeem = (code: string, deviceName = "Studio Mac", ip = "1.1.1.1") => redeemJoinCode(f.deps, { code, deviceName, ip });

  it("creates the account with exactly the script's roles and returns the key once", async () => {
    const { code } = await createJoinCode(f.deps, ADMIN, {});
    const r = await redeem(code.toLowerCase());
    const email = "spot-studio-mac@spot-solutions.iam.gserviceaccount.com";
    expect(r.serviceAccount).toBe(email);
    expect(r.key).toMatchObject({ type: "service_account", client_email: email });
    const a = f.accounts.get(email)!;
    expect([...a.project].sort()).toEqual(["roles/datastore.user", "roles/firebasecloudmessaging.admin"]);
    expect([...a.bucket]).toEqual(["roles/storage.objectAdmin"]);
    expect(f.serverKeys.get(email)).toMatchObject({ deviceName: "Studio Mac", deviceSlug: "studio-mac", createdBy: "admin@example.com", keyId: "key1" });
    expect(f.codes.get(hashCode(normaliseCode(code)!))).toMatchObject({ used: true, serviceAccount: email });
  });

  it("works only once", async () => {
    const { code } = await createJoinCode(f.deps, ADMIN, {});
    await redeem(code);
    await expect(redeem(code)).rejects.toMatchObject({ code: "invalid-argument" });
    expect(f.accounts.size).toBe(1);
  });

  it("rejects expired, unknown and malformed codes with the same message", async () => {
    const { code } = await createJoinCode(f.deps, ADMIN, {});
    const late = { ...f.deps, now: () => NOW + CODE_TTL_MS + 1 };
    const msgs = await Promise.all([
      redeemJoinCode(late, { code, deviceName: "x", ip: "a" }).catch((e: AppError) => e.message),
      redeem("SPOT-AAAA-BBBB").catch((e: AppError) => e.message),
      redeem("nonsense").catch((e: AppError) => e.message),
    ]);
    expect(new Set(msgs).size).toBe(1);
    expect(f.accounts.size).toBe(0);
  });

  it("dedupes the account name", async () => {
    const a = await createJoinCode(f.deps, ADMIN, {});
    const b = await createJoinCode(f.deps, ADMIN, {});
    expect((await redeem(a.code)).serviceAccount).toBe("spot-studio-mac@spot-solutions.iam.gserviceaccount.com");
    expect((await redeem(b.code)).serviceAccount).toBe("spot-studio-mac-2@spot-solutions.iam.gserviceaccount.com");
  });

  it("falls back to the admin's name for the device, then to 'server'", async () => {
    const a = await createJoinCode(f.deps, ADMIN, { deviceName: "Front Desk" });
    expect((await redeem(a.code, "")).serviceAccount).toContain("spot-front-desk@");
    const b = await createJoinCode(f.deps, ADMIN, {});
    expect((await redeem(b.code, "")).serviceAccount).toContain("spot-server@");
  });

  it("rate limits per IP", async () => {
    for (let i = 0; i < 10; i++) await redeem("SPOT-AAAA-BBBB", "x", "9.9.9.9").catch(() => undefined);
    await expect(redeem("SPOT-AAAA-BBBB", "x", "9.9.9.9")).rejects.toMatchObject({ code: "resource-exhausted" });
    await expect(redeem("SPOT-AAAA-BBBB", "x", "8.8.8.8")).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("cleans up and gives the code back when a step fails", async () => {
    const { code } = await createJoinCode(f.deps, ADMIN, {});
    f.failOn.add("key");
    await expect(redeem(code)).rejects.toMatchObject({ code: "internal" });
    expect(f.accounts.size).toBe(0); // the half-made account is gone
    expect(f.serverKeys.size).toBe(0);
    f.failOn.delete("key");
    const r = await redeem(code); // same code works again
    expect(r.serviceAccount).toContain("spot-studio-mac@");
  });
});

describe("removeServer", () => {
  async function join(device: string) {
    const { code } = await createJoinCode(f.deps, ADMIN, {});
    return (await redeemJoinCode(f.deps, { code, deviceName: device, ip: "ip" })).serviceAccount;
  }

  it("revokes keys, roles and the account, then deletes the server docs", async () => {
    const email = await join("Studio Mac");
    f.servers.set("studio-mac", { hostname: "Studio-Mac", lastSeen: NOW - 3_600_000 });
    const r = await removeServer(f.deps, ADMIN, { serverId: "studio-mac" });
    expect(r).toEqual({ revoked: [email], keyNotRevoked: false });
    expect(f.accounts.size).toBe(0);
    expect(f.serverKeys.size).toBe(0);
    expect(f.servers.size).toBe(0);
    // keys go first, the account last
    const order = f.calls.filter((c) => /^(deleteKey|bucket remove|project remove|deleteAccount)/.test(c)).map((c) => c.split(" ")[0] + (c.startsWith("bucket") || c.startsWith("project") ? "-roles" : ""));
    expect(order[0]).toBe("deleteKey");
    expect(order.at(-1)).toBe("deleteAccount");
  });

  it("finds the account by hostname when the server id differs", async () => {
    await join("Studio Mac");
    f.servers.set("studio-mac-a1b2c3", { hostname: "Studio-Mac", lastSeen: 0 });
    expect((await removeServer(f.deps, ADMIN, { serverId: "studio-mac-a1b2c3" })).revoked).toHaveLength(1);
  });

  it("revokes exactly the account a server reports, even when its names don't match", async () => {
    const mine = await join("Windows Laptop");
    const other = await join("Studio Mac");
    f.servers.set("desktop-x9", { hostname: "DESKTOP-X9", lastSeen: 0, serviceAccount: mine });
    expect((await removeServer(f.deps, ADMIN, { serverId: "desktop-x9" })).revoked).toEqual([mine]);
    expect(f.serverKeys.has(other)).toBe(true);
  });

  it("never revokes a reported account Nothing BOT Curating didn't create", async () => {
    f.servers.set("old-mac", { hostname: "old-mac", lastSeen: 0, serviceAccount: "firebase-adminsdk-x@spot-solutions.iam.gserviceaccount.com" });
    expect(await removeServer(f.deps, ADMIN, { serverId: "old-mac" })).toEqual({ revoked: [], keyNotRevoked: true });
  });

  it("refuses an online server that holds accounts, unless forced", async () => {
    await join("Studio Mac");
    f.servers.set("studio-mac", { hostname: "Studio-Mac", lastSeen: NOW - 10_000 });
    f.leases.set("studio-mac", ["u1", "u2"]);
    await expect(removeServer(f.deps, ADMIN, { serverId: "studio-mac" })).rejects.toMatchObject({ code: "failed-precondition", message: expect.stringContaining("2 WhatsApp accounts") });
    expect(f.accounts.size).toBe(1);
    expect(f.servers.size).toBe(1);
    await removeServer(f.deps, ADMIN, { serverId: "studio-mac", force: true });
    expect(f.accounts.size).toBe(0);
  });

  it("removes an online server that holds nothing, and an offline one that does", async () => {
    f.servers.set("a", { hostname: "a", lastSeen: NOW - 5_000 });
    await removeServer(f.deps, ADMIN, { serverId: "a" });
    f.servers.set("b", { hostname: "b", lastSeen: NOW - 3_600_000 });
    f.leases.set("b", ["u1"]);
    await removeServer(f.deps, ADMIN, { serverId: "b" });
    expect(f.servers.size).toBe(0);
  });

  it("just deletes the docs for a server with no Nothing BOT Curating account (the default firebase-adminsdk key)", async () => {
    f.servers.set("old-mac", { hostname: "Old-Mac", lastSeen: 0 });
    const r = await removeServer(f.deps, ADMIN, { serverId: "old-mac" });
    expect(r).toEqual({ revoked: [], keyNotRevoked: true });
    expect(f.calls.filter((c) => c !== "deleteDocs old-mac")).toEqual([]);
  });

  it("never deletes an account that isn't spot-<device>", async () => {
    f.servers.set("evil", { hostname: "evil", lastSeen: 0 });
    f.serverKeys.set("firebase-adminsdk-x@spot-solutions.iam.gserviceaccount.com", { deviceName: "evil", deviceSlug: "evil", createdBy: "x", createdAt: 0, keyId: "k" });
    f.serverKeys.set("spot-enroller@spot-solutions.iam.gserviceaccount.com", { deviceName: "evil", deviceSlug: "evil", createdBy: "x", createdAt: 0, keyId: "k" });
    const r = await removeServer(f.deps, ADMIN, { serverId: "evil" });
    expect(r.revoked).toEqual([]);
    expect(f.calls.some((c) => c.startsWith("deleteAccount"))).toBe(false);
  });

  it("checks admin, input and existence", async () => {
    await expect(removeServer(f.deps, { email: "x@example.com", verified: true }, { serverId: "a" })).rejects.toMatchObject({ code: "permission-denied" });
    await expect(removeServer(f.deps, ADMIN, { serverId: "a/b" })).rejects.toMatchObject({ code: "invalid-argument" });
    await expect(removeServer(f.deps, ADMIN, { serverId: "ghost" })).rejects.toMatchObject({ code: "not-found" });
  });
});
