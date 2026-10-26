// Pure decisions for the fleet lease module (fleet.ts), kept free of Firebase so they can be tested.
import { CLAIM_STAGGER_MS, LEASE_EXPIRE_MS, LEASE_FENCE_MS, LEASE_RENEW_MS, type Lease } from "@spot/shared";

/** A restarted server may take back its own lease once it has gone this stale (the old process is dead). */
export const OWN_RECLAIM_MS = LEASE_RENEW_MS + 5_000;

/**
 * May this server claim now? Expiry is judged only by what we observed locally (`observedStaleMs`: how long, on our own
 * monotonic clock, the lease doc has not changed), never by comparing renewedAt (the holder's wall clock) with ours.
 * The one exception is our own lease after a restart. A lease released towards another server is left alone for
 * LEASE_EXPIRE_MS of observation, then anyone may take it.
 */
export function claimableHere(lease: Lease | null | undefined, o: { now: number; me: string; heldLocally: boolean; observedStaleMs: number }) {
  if (!lease || !lease.server || lease.state === "released") {
    if (lease?.moveTo && lease.moveTo !== o.me && o.observedStaleMs < LEASE_EXPIRE_MS) return false;
    return true;
  }
  if (lease.server === o.me && !o.heldLocally) return o.now - lease.renewedAt > OWN_RECLAIM_MS;
  return o.observedStaleMs >= LEASE_EXPIRE_MS;
}

export function claimReason(lease: Lease | null | undefined, me: string): NonNullable<Lease["reason"]> {
  if (!lease) return "first_start";
  if (lease.moveTo === me && lease.state === "released") return lease.reason === "rebalance" ? "rebalance" : "move";
  return "failover";
}

/** The Nth-ranked candidate waits N stagger steps; the target of a planned move goes straight away. */
export function claimDelayMs(rank: number, lease: Lease | null | undefined, me: string) {
  return lease?.moveTo === me && lease.state === "released" ? 0 : rank * CLAIM_STAGGER_MS;
}

/** Fence when either clock says we've gone too long without a renewal: the monotonic one pauses while a laptop sleeps. */
export const shouldFence = (monoSinceOkMs: number, wallSinceOkMs = 0) => monoSinceOkMs > LEASE_FENCE_MS || wallSinceOkMs > LEASE_FENCE_MS;

/** A tick gap beyond this between the wall and monotonic clocks means the process was suspended (sleep). */
export const SLEEP_GAP_MS = 10_000;
export const slept = (wallDeltaMs: number, monoDeltaMs: number) => wallDeltaMs - monoDeltaMs > SLEEP_GAP_MS;

/**
 * A peer's lastSeen as an equivalent local timestamp: lastSeen is written with the peer's clock, so we only trust how
 * long ago *we* saw it change. Zero (a drained or stopped server) stays offline.
 */
export const observedLastSeen = (docLastSeen: number, changedAtMono: number, nowMono: number, nowWall: number) =>
  docLastSeen > 0 ? nowWall - Math.max(0, nowMono - changedAtMono) : 0;

/** What we know about one peer's heartbeat. `changed` is false until lastSeen has changed at least once since we first saw it. */
export interface PeerObservation {
  lastSeen: number;
  at: number; // mono() when lastSeen last changed (or when we first saw it)
  changed: boolean;
}

/**
 * Track a peer's heartbeat. Right after boot the first snapshot shows whatever lastSeen the peer wrote last, which says
 * nothing about whether it is alive now, so a peer stays offline until we see its lastSeen change (peers beat every 30 s).
 */
export function observePeer(prev: PeerObservation | undefined, docLastSeen: number, nowMono: number): PeerObservation {
  if (!prev) return { lastSeen: docLastSeen, at: nowMono, changed: false };
  if (prev.lastSeen !== docLastSeen) return { lastSeen: docLastSeen, at: nowMono, changed: true };
  return prev;
}

/** A peer's equivalent local lastSeen: 0 (offline) until its heartbeat has been seen to change. */
export const peerLastSeen = (obs: PeerObservation | undefined, nowMono: number, nowWall: number) =>
  obs?.changed ? observedLastSeen(obs.lastSeen, obs.at, nowMono, nowWall) : 0;

/** Handoffs that haven't finished by now stop renewing, so a hung one can't keep an account locked forever. */
export const HANDOFF_MAX_MS = 180_000;
export const handoffStuck = (handingOffAt: number | null, now: number) => handingOffAt !== null && now - handingOffAt > HANDOFF_MAX_MS;

/**
 * After the clocks jumped (sleep, NTP step, VM resume) every held lease is renewed at once; this is what to do with each.
 * Renewed: still ours, keep running. Rejected (epoch/holder changed): someone took over, stop without uploading.
 * Error (can't reach Firestore): we can't prove we still hold it, so fence.
 */
export const jumpOutcome = (renew: boolean | Error): "keep" | "lost" | "fenced" => (renew === true ? "keep" : renew === false ? "lost" : "fenced");

/** What a lease snapshot means for an account this server holds at `h.epoch`. */
export function leaseEventAction(lease: Lease | null, h: { epoch: number; handingOff: boolean }, me: string): "ignore" | "drop" | "keep" {
  if (lease && lease.epoch < h.epoch) return "ignore"; // older than our claim: a stale snapshot, not news
  if (lease && lease.server === me && lease.epoch === h.epoch) return "keep";
  if (h.handingOff && lease && lease.server === null && lease.epoch === h.epoch) return "keep"; // our own release
  return "drop";
}

/** Upload on release only a session that was ready before we stopped it, and only if the stop finished in time. */
export const shouldUploadOnRelease = (o: { wantUpload: boolean; wasReady: boolean; stopTimedOut: boolean }) => o.wantUpload && o.wasReady && !o.stopTimedOut;

/**
 * connect / move_account commands for an account nobody runs: retry the gate each evaluation, give up after this long.
 * Measured from when this server first saw the command (its own clock), never from the client's createdAt.
 */
export const PENDING_COMMAND_EXPIRE_MS = 5 * 60_000;
export const PENDING_COMMAND_ERROR = "No server could take this account. Check the Server page.";
export function pendingCommandAction(o: { type: string; firstSeenAt: number; now: number; liveHolder: boolean }): "wait" | "retry" | "expire" {
  if (o.type !== "connect" && o.type !== "move_account") return "wait";
  if (o.liveHolder) return "wait"; // the holder runs it
  return o.now - o.firstSeenAt > PENDING_COMMAND_EXPIRE_MS ? "expire" : "retry";
}

/**
 * A server.json written on another machine and copied here (disk clone, restored image) carries that machine's
 * fingerprint. A mismatch means this is a different machine: it must not reuse the id (two servers would share one
 * identity) or the install time. A missing fingerprint (older file, or none readable) is never treated as a clone, and
 * neither is one that came from the hostname/MAC fallback: a container's MAC changes on every recreate, so a mismatch
 * there says nothing about the disk.
 */
export const isClonedDisk = (
  storedFingerprint: string | null | undefined,
  currentFingerprint: string | null | undefined,
  sources: { stored?: string | null; current?: string | null } = {},
) => sources.stored !== "fallback" && sources.current !== "fallback" && Boolean(storedFingerprint && currentFingerprint && storedFingerprint !== currentFingerprint);

/**
 * Server id: an explicit env value wins; then the persisted one; otherwise a new random id. The one migration: a
 * machine that ran before ids were persisted keeps its hostname id when servers/{hostname} belongs to this install.
 */
export function pickServerId(o: { env?: string; persisted?: string | null; hostnameId: string; hostDocInstalledAt?: number | null; installedAt: number; random: string }) {
  if (o.env) return { id: o.env, persist: false };
  if (o.persisted) return { id: o.persisted, persist: false };
  if (o.hostDocInstalledAt === o.installedAt) return { id: o.hostnameId, persist: true };
  return { id: `${o.hostnameId}-${o.random}`, persist: true };
}


/**
 * Accounts to hand away when over capacity: newest claims first, accounts pinned here last.
 * `units` is how many browsers the account runs (1, or 2 with an agent number); the default counts each account once.
 */
export function pickShed(held: { uid: string; claimedAt: number; pinnedHere: boolean; units?: number }[], max: number) {
  let load = held.reduce((n, h) => n + (h.units ?? 1), 0);
  const out: string[] = [];
  for (const h of [...held].sort((a, b) => Number(a.pinnedHere) - Number(b.pinnedHere) || b.claimedAt - a.claimedAt)) {
    if (load <= Math.max(0, max)) break;
    out.push(h.uid);
    load -= h.units ?? 1;
  }
  return out;
}

/** Only one online server announces a peer going silent: the lowest id. */
export const isDesignatedNotifier = (onlineIds: string[], me: string) => [...onlineIds].sort()[0] === me;

/** Changes whenever the holder renews, claims, or releases; used to time how long a lease has been unchanged. */
export const leaseKey = (l: Lease | null | undefined) => (l ? `${l.server}:${l.epoch}:${l.state}:${l.renewedAt}:${l.moveTo ?? ""}` : "none");

export function moveText(from: string, to: string, crashed: boolean) {
  return crashed ? `Your WhatsApp moved from ${from} to ${to} because ${from} stopped responding.` : `Your WhatsApp moved from ${from} to ${to}.`;
}

/** Notices for the pre-fleet guard: one per (old server, user), so a long-running old server doesn't spam. */
export const preFleetNoticeKey = (oldId: string, uid: string) => `${oldId}:${uid}`;
export const preFleetText = (hostname: string) =>
  `Another Nothing BOT Server ("${hostname}") is running an old version. Your WhatsApp is paused on the newer servers until that one is stopped or updated, so two servers never answer the same chats.`;

/**
 * Sessions.stop() on an account whose launch is still in flight (`starting`) can't stop a client that doesn't exist yet.
 * It sets an abort flag; launch() asks this twice: before creating the Client and again immediately before registering it.
 * Abort when stop() was called meanwhile, or when we no longer hold the lease.
 */
export const launchDecision = (o: { aborted: boolean; canRun: boolean }): "proceed" | "abort" => (o.aborted || !o.canRun ? "abort" : "proceed");

/** stop() flags an abort only for an account that is mid-launch. */
export const shouldFlagAbort = (o: { starting: boolean }) => o.starting;

/**
 * Lines of `ps -axo pid=,command=` (or "pid command" lines from PowerShell): pids of processes whose command line carries
 * `--user-data-dir=<profile>` exactly (a prefix of a longer directory name, e.g. session-ab vs session-abc, does not count).
 */
export function orphanPids(lines: string[], profileDir: string, selfPid: number): number[] {
  const needle = `--user-data-dir=${profileDir}`;
  const out: number[] = [];
  for (const line of lines) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === selfPid) continue;
    let from = 0;
    for (;;) {
      const i = m[2].indexOf(needle, from);
      if (i < 0) break;
      const next = m[2][i + needle.length];
      if (next === undefined || /[\s"']/.test(next)) {
        out.push(pid);
        break;
      }
      from = i + 1;
    }
  }
  return out;
}

/** adoptCloudGen retries: 1, 2, 4, 8, 16, 32, 32 s (about 95 s in all, then the upload path adopts instead). */
export const ADOPT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 32_000];
