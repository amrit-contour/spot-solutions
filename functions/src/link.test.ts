import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Deps } from "./core";
import { LINK_TTL_MS, approveDeviceLink, generateLinkCode, getDeviceLink, hashLinkCode, normaliseLinkCode, pollDeviceLink, secretMatches, startDeviceLink, verifyCode, type LinkDeps } from "./link";
import { serviceAccountEmail } from "./logic";
import type { ClaimLinkResult, Gcp, LinkDoc, LinkStore, Store } from "./ports";

const NOW = 1_700_000_000_000;
const SECRET = "s".repeat(43);
const CHALLENGE = createHash("sha256").update(SECRET).digest("hex");
const ADMIN = { email: "Admin@Example.com", verified: true };
const NOT_ADMIN = { email: "curator@example.com", verified: true };

function fakes() {
  let now = NOW;
  const accounts = new Map<string, { keys: string[] }>();
  let keySeq = 0;
  const failKey = { on: false };
  const gcp: Gcp = {
    async serviceAccountExists(e) { return accounts.has(e); },
    async createServiceAccount(id) { accounts.set(serviceAccountEmail(id), { keys: [] }); },
    async createKey(e) {
      if (failKey.on) throw new Error("boom");
      const id = `key${++keySeq}`;
      accounts.get(e)!.keys.push(id);
      return { keyId: id, json: { type: "service_account", project_id: "spot-solutions", client_email: e, private_key: "PK" } };
    },
    async listUserKeyIds(e) { return [...(accounts.get(e)?.keys ?? [])]; },
    async deleteKey(e, k) { const a = accounts.get(e)!; a.keys = a.keys.filter((x) => x !== k); },
    async deleteServiceAccount(e) { accounts.delete(e); },
    async setProjectRoles() {},
    async setBucketRoles() {},
  };
  const serverKeys = new Set<string>();
  const attempts = new Map<string, number>();
  const store = {
    async isAdmin(e: string) { return e === "admin@example.com"; },
    async allowAttempt(k: string, _n: number, limit: number) { const n = (attempts.get(k) ?? 0) + 1; attempts.set(k, n); return n <= limit; },
    async putServerKey(e: string) { serverKeys.add(e); },
    async deleteServerKey(e: string) { serverKeys.delete(e); },
  } as unknown as Store;

  const docs = new Map<string, LinkDoc>();
  const links: LinkStore = {
    async putLink(h, d) { docs.set(h, d); },
    async getLink(h) { return docs.get(h) ?? null; },
    async approveLink(h, email, n) {
      const d = docs.get(h);
      if (!d) return "missing";
      if (n >= d.expiresAt) return "expired";
      if (d.status !== "pending") return "already";
      Object.assign(d, { status: "approved", approvedBy: email, approvedAt: n });
      return "ok";
    },
    async claimLink(h, n): Promise<ClaimLinkResult> {
      const d = docs.get(h);
      if (!d) return { ok: false, reason: "missing" };
      if (d.status === "pending") return { ok: false, reason: "pending" };
      if (d.status === "redeeming" && n - (d.claimedAt ?? 0) < 120_000) return { ok: false, reason: "busy" };
      if (d.status === "done" && !(n - (d.doneAt ?? 0) < 600_000 && (d.deliveries ?? 0) < 3)) return { ok: false, reason: "done" };
      const before = { ...d };
      Object.assign(d, { status: "redeeming", claimedAt: n });
      return { ok: true, link: before };
    },
    async finishLink(h, sa, n) { const d = docs.get(h)!; Object.assign(d, { status: "done", serviceAccount: sa, doneAt: n, deliveries: (d.deliveries ?? 0) + 1 }); },
    async releaseLink(h) { docs.get(h)!.status = "approved"; },
    async sweepLinks() {},
  };
  const deps: LinkDeps = { gcp, store, links, now: () => now, sleep: async () => {}, log: () => {} } as Deps & { links: LinkStore };
  return { deps, docs, accounts, serverKeys, failKey, advance: (ms: number) => (now += ms) };
}

let f: ReturnType<typeof fakes>;
beforeEach(() => (f = fakes()));
const start = (ip = "1.1.1.1") => startDeviceLink(f.deps, { deviceName: " Studio Mac ", challenge: CHALLENGE, ip });

describe("codes and secrets", () => {
  it("makes link codes that normalise back and reject lookalike characters", () => {
    const c = generateLinkCode();
    expect(c).toMatch(/^[2-9A-HJKMNP-Z]{12}$/);
    expect(normaliseLinkCode(c.toLowerCase())).toBe(c);
    expect(normaliseLinkCode("0O1ILAAAAAAA")).toBeNull();
    expect(normaliseLinkCode("short")).toBeNull();
  });
  it("matches the secret that made the challenge, and nothing else", () => {
    expect(secretMatches(SECRET, CHALLENGE)).toBe(true);
    expect(secretMatches("x".repeat(43), CHALLENGE)).toBe(false);
    expect(secretMatches("", CHALLENGE)).toBe(false);
    expect(secretMatches(undefined, CHALLENGE)).toBe(false);
  });
});

describe("startDeviceLink", () => {
  it("stores only hashes and returns a code with a check value", async () => {
    const r = await start();
    expect(r.expiresAt).toBe(NOW + LINK_TTL_MS);
    expect(r.verify).toBe(verifyCode(r.code, CHALLENGE));
    const [[hash, doc]] = [...f.docs];
    expect(hash).toBe(hashLinkCode(r.code));
    expect(JSON.stringify([...f.docs])).not.toContain(r.code);
    expect(JSON.stringify(doc)).not.toContain(SECRET);
    expect(doc).toMatchObject({ deviceName: "Studio Mac", status: "pending", challenge: CHALLENGE });
  });
  it("refuses a bad challenge and rate limits per IP", async () => {
    await expect(startDeviceLink(f.deps, { challenge: "nope", ip: "a" })).rejects.toMatchObject({ code: "invalid-argument" });
    for (let i = 0; i < 10; i++) await start("9.9.9.9").catch(() => undefined);
    await expect(start("9.9.9.9")).rejects.toMatchObject({ code: "resource-exhausted" });
  });
});

describe("approve and collect", () => {
  it("only admins approve; anyone signed in can look", async () => {
    const { code } = await start();
    expect(await getDeviceLink(f.deps, NOT_ADMIN, { code })).toMatchObject({ deviceName: "Studio Mac", canApprove: false });
    expect(await getDeviceLink(f.deps, ADMIN, { code })).toMatchObject({ canApprove: true });
    await expect(approveDeviceLink(f.deps, NOT_ADMIN, { code })).rejects.toMatchObject({ code: "permission-denied" });
    await expect(approveDeviceLink(f.deps, { email: "admin@example.com", verified: false }, { code })).rejects.toMatchObject({ code: "permission-denied" });
    await expect(approveDeviceLink(f.deps, {}, { code })).rejects.toMatchObject({ code: "permission-denied" });
    await expect(getDeviceLink(f.deps, {}, { code })).rejects.toMatchObject({ code: "permission-denied" });
    expect([...f.docs.values()][0]!.status).toBe("pending");
  });

  it("hands the key to the holder of the secret, once, with the approver's email", async () => {
    const { code } = await start();
    expect(await pollDeviceLink(f.deps, { code, secret: SECRET })).toEqual({ status: "pending" });
    await approveDeviceLink(f.deps, ADMIN, { code });
    expect(await pollDeviceLink(f.deps, { code, secret: "w".repeat(43) })).toEqual({ status: "expired" }); // wrong secret learns nothing
    const r = await pollDeviceLink(f.deps, { code, secret: SECRET });
    expect(r).toMatchObject({ status: "approved", approvedBy: "admin@example.com", deviceName: "Studio Mac", serviceAccount: "spot-studio-mac@spot-solutions.iam.gserviceaccount.com" });
    expect((r as { key: { type: string } }).key.type).toBe("service_account");
    expect(JSON.stringify([...f.docs])).not.toContain("PK"); // the key is never stored
  });

  it("is single use: a second approval is refused, and the key is not handed out again after the grace period", async () => {
    const { code } = await start();
    await approveDeviceLink(f.deps, ADMIN, { code });
    await expect(approveDeviceLink(f.deps, ADMIN, { code })).rejects.toMatchObject({ code: "failed-precondition" });
    await pollDeviceLink(f.deps, { code, secret: SECRET });
    f.advance(11 * 60_000 - 1); // still inside the 15 min code window, but past the re-issue window
    expect(await pollDeviceLink(f.deps, { code, secret: SECRET })).toEqual({ status: "done" });
  });

  it("re-issues once if the first reply was lost, revoking the first account", async () => {
    const { code } = await start();
    await approveDeviceLink(f.deps, ADMIN, { code });
    const a = (await pollDeviceLink(f.deps, { code, secret: SECRET })) as { serviceAccount: string };
    f.advance(1000);
    const b = (await pollDeviceLink(f.deps, { code, secret: SECRET })) as { status: string; serviceAccount: string };
    expect(b.status).toBe("approved");
    expect(f.accounts.size).toBe(1); // the first account was retired, the name reused for the new one
    expect(f.accounts.get(a.serviceAccount)!.keys).toEqual(["key2"]);
  });

  it("expires, and a failed provisioning gives the approval back", async () => {
    const { code } = await start();
    await approveDeviceLink(f.deps, ADMIN, { code });
    f.failKey.on = true;
    await expect(pollDeviceLink(f.deps, { code, secret: SECRET })).rejects.toMatchObject({ code: "internal" });
    expect(f.accounts.size).toBe(0);
    f.failKey.on = false;
    expect((await pollDeviceLink(f.deps, { code, secret: SECRET })).status).toBe("approved");
    const other = await start("2.2.2.2");
    f.advance(LINK_TTL_MS + 1);
    expect(await pollDeviceLink(f.deps, { code: other.code, secret: SECRET })).toEqual({ status: "expired" });
    await expect(approveDeviceLink(f.deps, ADMIN, { code: other.code })).rejects.toMatchObject({ code: "not-found" });
  });
});
