import { describe, expect, it } from "vitest";
import {
  CLAIM_STAGGER_MS, LEASE_EXPIRE_MS, SERVER_ONLINE_MS, defaultMaxAccounts, leaseClaimable, mayUpload, pickLoginSource, rankCandidates,
  type CandidateServer, type Lease,
} from "./fleet.ts";

const NOW = 10_000_000;
const srv = (id: string, o: Partial<CandidateServer> = {}): CandidateServer => ({ id, lastSeen: NOW - 1000, installedAt: 100, maxAccounts: 4, hosting: 0, localModel: false, draining: false, ...o });
const ids = (l: CandidateServer[]) => l.map((s) => s.id);

describe("rankCandidates", () => {
  it("drops offline, draining and full servers", () => {
    const l = rankCandidates([srv("a", { lastSeen: NOW - SERVER_ONLINE_MS - 1 }), srv("b", { draining: true }), srv("c", { hosting: 4 }), srv("d")], { policy: "local_first", now: NOW });
    expect(ids(l)).toEqual(["d"]);
  });
  it("local_only needs a local model; local_first merely prefers one", () => {
    const s = [srv("a"), srv("b", { localModel: true })];
    expect(ids(rankCandidates(s, { policy: "local_only", now: NOW }))).toEqual(["b"]);
    expect(ids(rankCandidates(s, { policy: "local_first", now: NOW }))).toEqual(["b", "a"]);
  });
  it("pinned first, even over a local model, but not when it is unavailable", () => {
    const s = [srv("a", { localModel: true }), srv("b")];
    expect(ids(rankCandidates(s, { policy: "local_first", pinned: "b", now: NOW }))).toEqual(["b", "a"]);
    expect(ids(rankCandidates([srv("a"), srv("b", { draining: true })], { policy: "local_first", pinned: "b", now: NOW }))).toEqual(["a"]);
  });
  it("pinned to a server without a model cannot beat local_only", () => {
    expect(ids(rankCandidates([srv("a", { localModel: true }), srv("b")], { policy: "local_only", pinned: "b", now: NOW }))).toEqual(["a"]);
  });
  it("least loaded next, then newest install, then id", () => {
    const l = rankCandidates([srv("a", { hosting: 2 }), srv("b", { hosting: 1, maxAccounts: 8 }), srv("c", { hosting: 2, installedAt: 200 }), srv("d", { hosting: 2, installedAt: 200 })], { policy: "local_first", now: NOW });
    expect(ids(l)).toEqual(["b", "c", "d", "a"]);
  });
  it("load is relative to capacity", () => {
    const l = rankCandidates([srv("small", { hosting: 1, maxAccounts: 2 }), srv("big", { hosting: 2, maxAccounts: 10 })], { policy: "local_first", now: NOW });
    expect(ids(l)).toEqual(["big", "small"]);
  });
  it("does not mutate its input", () => {
    const s = [srv("b"), srv("a")];
    rankCandidates(s, { policy: "local_first", now: NOW });
    expect(ids(s)).toEqual(["b", "a"]);
    expect(CLAIM_STAGGER_MS).toBeGreaterThan(0);
  });
});

describe("leaseClaimable", () => {
  const l = (o: Partial<Lease> = {}): Lease => ({ server: "a", epoch: 1, state: "running", renewedAt: NOW, claimedAt: NOW, ...o });
  it("missing, null server or released", () => {
    expect(leaseClaimable(null, NOW)).toBe(true);
    expect(leaseClaimable(l({ server: null }), NOW)).toBe(true);
    expect(leaseClaimable(l({ state: "released" }), NOW)).toBe(true);
  });
  it("running lease expires after LEASE_EXPIRE_MS, handing_off too", () => {
    expect(leaseClaimable(l(), NOW + LEASE_EXPIRE_MS)).toBe(false);
    expect(leaseClaimable(l(), NOW + LEASE_EXPIRE_MS + 1)).toBe(true);
    expect(leaseClaimable(l({ state: "handing_off" }), NOW + 1000)).toBe(false);
  });
});

describe("pickLoginSource", () => {
  const wiped = (gen: number) => ({ gen, wiped: true });
  it.each([
    [null, null, "fresh"],
    [null, { gen: 3 }, "cloud"],
    [null, wiped(3), "fresh"],
    [2, { gen: 3 }, "cloud"],
    [2, wiped(3), "fresh"],
    [3, { gen: 3 }, "local"],
    [3, wiped(3), "local"], // a new link adopted the tombstone gen
    [4, { gen: 3 }, "local"],
    [4, wiped(3), "local"],
    [0, null, "local"],
    [0, wiped(1), "fresh"],
  ] as const)("local %s cloud %j -> %s", (local, cloud, want) => {
    expect(pickLoginSource(local, cloud)).toBe(want);
  });
});

describe("mayUpload", () => {
  it.each([
    [false, 5, 5, false],
    [false, null, null, false],
    [true, 5, 5, true],
    [true, 6, 5, true],
    [true, 4, 5, false],
    [true, null, 5, false], // no local gen counts as 0
    [true, 0, 5, false],
    [true, null, null, true], // pre-fleet profile, nothing in the cloud
    [true, 0, null, true],
    [true, 3, null, true],
    [true, 0, 0, true],
  ] as const)("ready %s local %s cloud %s -> %s", (sessionReady, localGen, cloudGen, want) => {
    expect(mayUpload({ sessionReady, localGen, cloudGen })).toBe(want);
  });
});

describe("defaultMaxAccounts", () => {
  const GB = 1024 ** 3;
  it("never below 1", () => {
    expect(defaultMaxAccounts(1 * GB, false)).toBe(1);
    expect(defaultMaxAccounts(4 * GB, true)).toBe(1);
  });
  it("scales with memory and reserves room for a local model", () => {
    expect(defaultMaxAccounts(16 * GB, false)).toBe(Math.floor((14.5 * GB) / (450 * 1024 ** 2)));
    expect(defaultMaxAccounts(16 * GB, true)).toBeLessThan(defaultMaxAccounts(16 * GB, false));
  });
});
