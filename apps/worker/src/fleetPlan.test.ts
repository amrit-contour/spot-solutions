import { describe, expect, it } from "vitest";
import { CLAIM_STAGGER_MS, LEASE_EXPIRE_MS, LEASE_FENCE_MS, SERVER_ONLINE_MS, rankCandidates, type CandidateServer, type Lease } from "@spot/shared";
import {
  HANDOFF_MAX_MS, OWN_RECLAIM_MS, PENDING_COMMAND_EXPIRE_MS, SLEEP_GAP_MS, claimDelayMs, claimReason, claimableHere, handoffStuck, isClonedDisk, isDesignatedNotifier, jumpOutcome, launchDecision, orphanPids, shouldFlagAbort,
  leaseEventAction, leaseKey, moveText, observePeer, observedLastSeen, pendingCommandAction, peerLastSeen, pickServerId, pickShed, shouldFence, shouldUploadOnRelease, slept,
} from "./fleetPlan.ts";

const lease = (o: Partial<Lease> = {}): Lease => ({ server: "a", epoch: 3, state: "running", renewedAt: 1_000_000, claimedAt: 900_000, ...o });
const base = { me: "b", heldLocally: false, observedStaleMs: LEASE_EXPIRE_MS + 1 };

describe("claimableHere", () => {
  it("no lease or released: claim", () => {
    expect(claimableHere(null, { ...base, now: 5 })).toBe(true);
    expect(claimableHere(lease({ server: null, state: "released" }), { ...base, now: 5 })).toBe(true);
  });
  it("live lease of another server: no; expired on both clocks: yes", () => {
    expect(claimableHere(lease(), { ...base, now: 1_010_000, observedStaleMs: 10_000 })).toBe(false);
    expect(claimableHere(lease(), { ...base, now: 1_000_000 + LEASE_EXPIRE_MS + 1 })).toBe(true);
  });
  it("a fast local clock alone can't steal a lease we saw renewed recently", () => {
    expect(claimableHere(lease(), { ...base, now: 9_999_999, observedStaleMs: 5_000 })).toBe(false);
  });
  it("released towards another server is left alone until it goes stale", () => {
    const l = lease({ server: null, state: "released", moveTo: "c" });
    expect(claimableHere(l, { ...base, now: 1, observedStaleMs: 1_000 })).toBe(false);
    expect(claimableHere(l, { ...base, now: 1 })).toBe(true);
    expect(claimableHere(l, { ...base, me: "c", now: 1, observedStaleMs: 0 })).toBe(true);
  });
  it("own lease after a restart: only once stale enough that the old process is surely gone", () => {
    const l = lease({ server: "b" });
    expect(claimableHere(l, { ...base, now: 1_000_000 + 10_000, observedStaleMs: 0 })).toBe(false);
    expect(claimableHere(l, { ...base, now: 1_000_000 + OWN_RECLAIM_MS + 1, observedStaleMs: 0 })).toBe(true);
    expect(claimableHere(l, { ...base, heldLocally: true, now: 1_000_000 + OWN_RECLAIM_MS + 1, observedStaleMs: 0 })).toBe(false);
  });
});

describe("claim reason and delay", () => {
  it("reasons", () => {
    expect(claimReason(null, "b")).toBe("first_start");
    expect(claimReason(lease({ state: "released", server: null, moveTo: "b" }), "b")).toBe("move");
    expect(claimReason(lease({ state: "released", server: null, moveTo: "b", reason: "rebalance" }), "b")).toBe("rebalance");
    expect(claimReason(lease(), "b")).toBe("failover");
  });
  it("stagger by rank, none for the target of a move", () => {
    expect(claimDelayMs(2, lease(), "b")).toBe(2 * CLAIM_STAGGER_MS);
    expect(claimDelayMs(0, null, "b")).toBe(0);
    expect(claimDelayMs(3, lease({ state: "released", server: null, moveTo: "b" }), "b")).toBe(0);
  });
});

describe("misc", () => {
  it("fence after 90s", () => {
    expect(shouldFence(89_000)).toBe(false);
    expect(shouldFence(91_000)).toBe(true);
  });
  it("pickShed: newest claims first, pinned last", () => {
    const h = [
      { uid: "u1", claimedAt: 1, pinnedHere: false },
      { uid: "u2", claimedAt: 3, pinnedHere: true },
      { uid: "u3", claimedAt: 2, pinnedHere: false },
    ];
    expect(pickShed(h, 3)).toEqual([]);
    expect(pickShed(h, 2)).toEqual(["u3"]);
    expect(pickShed(h, 0)).toEqual(["u3", "u1", "u2"]);
  });
  it("pickShed counts an agent number as a second browser", () => {
    const h = [
      { uid: "u1", claimedAt: 1, pinnedHere: false, units: 2 },
      { uid: "u2", claimedAt: 3, pinnedHere: false, units: 1 },
      { uid: "u3", claimedAt: 2, pinnedHere: false, units: 2 },
    ];
    expect(pickShed(h, 5)).toEqual([]);
    expect(pickShed(h, 4)).toEqual(["u2"]);
    expect(pickShed(h, 3)).toEqual(["u2", "u3"]);
    expect(pickShed(h, 0)).toEqual(["u2", "u3", "u1"]);
  });
  it("one notifier", () => {
    expect(isDesignatedNotifier(["z", "m", "b"], "b")).toBe(true);
    expect(isDesignatedNotifier(["z", "m", "b"], "m")).toBe(false);
  });
  it("leaseKey changes on renew", () => {
    expect(leaseKey(lease())).not.toBe(leaseKey(lease({ renewedAt: 1_000_001 })));
    expect(leaseKey(null)).toBe("none");
  });
  it("text", () => {
    expect(moveText("A", "B", false)).toBe("Your WhatsApp moved from A to B.");
    expect(moveText("A", "B", true)).toContain("stopped responding");
  });
});

describe("sleep and fence", () => {
  it("fences when either clock is past the limit", () => {
    expect(shouldFence(1_000, LEASE_FENCE_MS + 1)).toBe(true); // slept: mono barely moved, wall did
    expect(shouldFence(LEASE_FENCE_MS + 1, 0)).toBe(true);
    expect(shouldFence(LEASE_FENCE_MS, LEASE_FENCE_MS)).toBe(false);
  });
  it("detects a suspended process from the wall/mono gap", () => {
    expect(slept(5_000, 5_000)).toBe(false);
    expect(slept(5_400, 5_000)).toBe(false); // ordinary timer jitter
    expect(slept(5_000 + SLEEP_GAP_MS + 1, 5_000)).toBe(true);
    expect(slept(4_000, 5_000)).toBe(false); // wall clock set back: not a sleep
  });
});

describe("observation-based expiry", () => {
  it("a lease whose renewedAt looks ancient to us is still live until we watched it go quiet", () => {
    expect(claimableHere(lease({ renewedAt: 1 }), { ...base, now: 9e12, observedStaleMs: LEASE_EXPIRE_MS - 1 })).toBe(false);
    expect(claimableHere(lease({ renewedAt: 9e12 }), { ...base, now: 1, observedStaleMs: LEASE_EXPIRE_MS })).toBe(true);
  });
  it("handing_off leases expire the same way", () => {
    expect(claimableHere(lease({ state: "handing_off" }), { ...base, now: 1e12, observedStaleMs: 5_000 })).toBe(false);
    expect(claimableHere(lease({ state: "handing_off" }), { ...base, now: 1, observedStaleMs: LEASE_EXPIRE_MS })).toBe(true);
  });
});

describe("peer online by observation", () => {
  const NOW = 1_000_000;
  const peer = (id: string, docLastSeen: number, changedAtMono: number, monoNow: number): CandidateServer => ({
    id, lastSeen: observedLastSeen(docLastSeen, changedAtMono, monoNow, NOW), installedAt: 1, maxAccounts: 4, hosting: 0, localModel: false, draining: false,
  });
  it("a heartbeat we saw change recently is online, whatever its own clock says", () => {
    const ok = peer("a", 5, 9_000, 10_000); // peer clock is wildly off
    expect(rankCandidates([ok], { policy: "local_first", now: NOW }).map((s) => s.id)).toEqual(["a"]);
  });
  it("one we haven't seen change for SERVER_ONLINE_MS is offline, even with a fresh-looking lastSeen", () => {
    const stale = peer("a", NOW, 0, SERVER_ONLINE_MS + 1);
    expect(rankCandidates([stale], { policy: "local_first", now: NOW })).toEqual([]);
  });
  it("lastSeen 0 (drained) stays offline although the doc just changed", () => {
    expect(observedLastSeen(0, 10_000, 10_000, NOW)).toBe(0);
    expect(rankCandidates([peer("a", 0, 10_000, 10_000)], { policy: "local_first", now: NOW })).toEqual([]);
  });
});

describe("pending commands", () => {
  const now = 10_000_000;
  it("retries connect and move_account with no live holder, and gives up after 5 minutes", () => {
    expect(pendingCommandAction({ type: "connect", firstSeenAt: now - 1_000, now, liveHolder: false })).toBe("retry");
    expect(pendingCommandAction({ type: "move_account", firstSeenAt: now - PENDING_COMMAND_EXPIRE_MS - 1, now, liveHolder: false })).toBe("expire");
    expect(pendingCommandAction({ type: "connect", firstSeenAt: now - PENDING_COMMAND_EXPIRE_MS, now, liveHolder: false })).toBe("retry");
  });
  it("leaves them to the holder when one is live, and ignores other types", () => {
    expect(pendingCommandAction({ type: "connect", firstSeenAt: 0, now, liveHolder: true })).toBe("wait");
    expect(pendingCommandAction({ type: "send_message", firstSeenAt: 0, now, liveHolder: false })).toBe("wait");
  });
});

describe("lease snapshots for a held account", () => {
  const h = { epoch: 5, handingOff: false };
  it("ignores an older epoch, drops a newer one or another server", () => {
    expect(leaseEventAction(lease({ epoch: 4, server: "x" }), h, "b")).toBe("ignore");
    expect(leaseEventAction(lease({ epoch: 6, server: "x" }), h, "b")).toBe("drop");
    expect(leaseEventAction(lease({ epoch: 5, server: "x" }), h, "b")).toBe("drop");
    expect(leaseEventAction(null, h, "b")).toBe("drop");
  });
  it("keeps our own lease, and our own release while handing off", () => {
    expect(leaseEventAction(lease({ epoch: 5, server: "b" }), h, "b")).toBe("keep");
    const rel = lease({ epoch: 5, server: null, state: "released" });
    expect(leaseEventAction(rel, { ...h, handingOff: true }, "b")).toBe("keep");
    expect(leaseEventAction(rel, h, "b")).toBe("drop");
  });
});

describe("upload on release", () => {
  it("never uploads a session that wasn't ready before stop (QR / unlinked profile)", () => {
    expect(shouldUploadOnRelease({ wantUpload: true, wasReady: false, stopTimedOut: false })).toBe(false);
    expect(shouldUploadOnRelease({ wantUpload: true, wasReady: true, stopTimedOut: false })).toBe(true);
  });
  it("skips after a stop timeout, or when not asked to", () => {
    expect(shouldUploadOnRelease({ wantUpload: true, wasReady: true, stopTimedOut: true })).toBe(false);
    expect(shouldUploadOnRelease({ wantUpload: false, wasReady: true, stopTimedOut: false })).toBe(false);
  });
  it("a handoff stuck for over 3 minutes stops renewing", () => {
    expect(handoffStuck(null, 1e9)).toBe(false);
    expect(handoffStuck(1_000, 1_000 + HANDOFF_MAX_MS)).toBe(false);
    expect(handoffStuck(1_000, 1_000 + HANDOFF_MAX_MS + 1)).toBe(true);
  });
});

describe("pickServerId", () => {
  const o = { hostnameId: "mac-mini", installedAt: 100, random: "abc123" };
  it("env wins, then the persisted id", () => {
    expect(pickServerId({ ...o, env: "custom", persisted: "x" })).toEqual({ id: "custom", persist: false });
    expect(pickServerId({ ...o, persisted: "mac-mini-ff00aa" })).toEqual({ id: "mac-mini-ff00aa", persist: false });
  });
  it("migration: an existing record of this install keeps the hostname id", () => {
    expect(pickServerId({ ...o, hostDocInstalledAt: 100 })).toEqual({ id: "mac-mini", persist: true });
  });
  it("otherwise a new random id (another machine with the same hostname, or a fresh install)", () => {
    expect(pickServerId({ ...o, hostDocInstalledAt: 999 })).toEqual({ id: "mac-mini-abc123", persist: true });
    expect(pickServerId({ ...o })).toEqual({ id: "mac-mini-abc123", persist: true });
  });
});

describe("peer state right after boot", () => {
  const NOW = 1_000_000;
  it("a peer is offline on first sight, however fresh its lastSeen looks", () => {
    const first = observePeer(undefined, NOW - 1_000, 5_000);
    expect(first.changed).toBe(false);
    expect(peerLastSeen(first, 5_000, NOW)).toBe(0);
    expect(peerLastSeen(observePeer(first, NOW - 1_000, 40_000), 40_000, NOW)).toBe(0); // same snapshot again: still unproven
  });
  it("online once its lastSeen has changed, and offline again when it stops changing", () => {
    const first = observePeer(undefined, 100, 5_000);
    const beat = observePeer(first, 130, 35_000);
    expect(beat.changed).toBe(true);
    expect(peerLastSeen(beat, 36_000, NOW)).toBe(NOW - 1_000);
    expect(rankCandidates([{ id: "a", lastSeen: peerLastSeen(beat, 36_000, NOW), installedAt: 1, maxAccounts: 2, hosting: 0, localModel: false, draining: false }], { policy: "local_first", now: NOW })).toHaveLength(1);
    const later = peerLastSeen(observePeer(beat, 130, 36_000), 36_000 + SERVER_ONLINE_MS + 1, NOW);
    expect(rankCandidates([{ id: "a", lastSeen: later, installedAt: 1, maxAccounts: 2, hosting: 0, localModel: false, draining: false }], { policy: "local_first", now: NOW })).toEqual([]);
  });
});

describe("clock jump", () => {
  it("renewing keeps the account; only a rejected or unreachable renew drops it", () => {
    expect(jumpOutcome(true)).toBe("keep");
    expect(jumpOutcome(false)).toBe("lost"); // others claimed during a real sleep: the epoch check fails
    expect(jumpOutcome(new Error("offline"))).toBe("fenced");
  });
});

describe("cloned disk", () => {
  it("only a different known fingerprint counts as a clone", () => {
    expect(isClonedDisk("aaa", "bbb")).toBe(true);
    expect(isClonedDisk("aaa", "aaa")).toBe(false);
    expect(isClonedDisk(undefined, "bbb")).toBe(false); // older server.json: keep the id, record the fingerprint
    expect(isClonedDisk("aaa", null)).toBe(false); // fingerprint unreadable now
  });
  it("a hostname/MAC fallback fingerprint never proves a clone (a container's MAC changes on every recreate)", () => {
    expect(isClonedDisk("aaa", "bbb", { stored: "fallback", current: "fallback" })).toBe(false);
    expect(isClonedDisk("aaa", "bbb", { stored: "machine", current: "fallback" })).toBe(false);
    expect(isClonedDisk("aaa", "bbb", { stored: "fallback", current: "machine" })).toBe(false);
    expect(isClonedDisk("aaa", "bbb", { stored: "machine", current: "machine" })).toBe(true);
    expect(isClonedDisk("aaa", "bbb", { current: "machine" })).toBe(true); // older server.json without a source
  });
  it("a clone gets a new id (fresh install time, no persisted id)", () => {
    const o = { hostnameId: "vm", random: "abc123" };
    // what serverIdentity does on a mismatch: drop the stored id and installedAt, so the host record can't match either
    expect(pickServerId({ ...o, persisted: null, hostDocInstalledAt: 100, installedAt: 200 })).toEqual({ id: "vm-abc123", persist: true });
  });
});

describe("start/stop race", () => {
  it("launch proceeds only when not aborted and the lease is still ours", () => {
    expect(launchDecision({ aborted: false, canRun: true })).toBe("proceed");
    expect(launchDecision({ aborted: true, canRun: true })).toBe("abort"); // stop() came in before the client was registered
    expect(launchDecision({ aborted: false, canRun: false })).toBe("abort"); // lease lost
    expect(launchDecision({ aborted: true, canRun: false })).toBe("abort");
  });
  it("stop() flags an abort only for an account that is mid-launch", () => {
    expect(shouldFlagAbort({ starting: true })).toBe(true);
    expect(shouldFlagAbort({ starting: false })).toBe(false);
  });
});

describe("orphanPids", () => {
  const profile = "/data/wwebjs/session-abc";
  const ps = [
    `  101 /usr/bin/chrome --headless --user-data-dir=${profile} --no-sandbox`,
    `  102 /usr/bin/chrome --user-data-dir=${profile}`,
    `  103 /usr/bin/chrome --user-data-dir=${profile}def --no-sandbox`, // another account whose id starts the same
    `  104 /usr/bin/chrome --user-data-dir=/data/wwebjs/session-xyz`,
    `  105 node worker.js --user-data-dir=${profile}`, // us
    `  106 /usr/bin/chrome --headless`,
    "garbage",
  ];
  it("finds browsers on exactly this profile, never ourselves or a longer directory name", () => {
    expect(orphanPids(ps, profile, 105)).toEqual([101, 102]);
  });
  it("handles Windows paths and quoted values", () => {
    const win = "C:\\SpotSolutions\\data\\wwebjs\\session-abc";
    expect(orphanPids([`7 "C:\\chrome.exe" --user-data-dir=${win} --x`, `8 chrome.exe --user-data-dir="${win}"`, `9 chrome.exe --user-data-dir=${win}2`], win, 1)).toEqual([7]);
  });
});
