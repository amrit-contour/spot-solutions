// The server fleet (docs/fleet.md): each approved, linked account runs on exactly one server, chosen by a lease
// in users/{uid}/fleet/lease. This file does the Firestore side; the decisions live in fleetPlan.ts and
// packages/shared/src/fleet.ts so they can be tested.
import os from "node:os";
import {
  DEFAULT_AI_POLICY, LEASE_FENCE_MS, agentVaultId, TTL_DAYS, LEASE_RENEW_MS, SERVER_ONLINE_MS, VAULT_UPLOAD_EVERY_MS, defaultMaxAccounts, preFleetServers, rankCandidates,
  type AiPolicy, type CandidateServer, type FleetCapacity, type FleetPrefs, type FleetServerSummary, type Lease, type ServerBeat,
} from "@spot/shared";
import { col, db, expireAt } from "./firebase.ts";
import { sessions } from "./sessions.ts";
import { agentSessions } from "./agentSession.ts";
import { setFleetProvider } from "./stats.ts";
import { INSTALLED_AT, SERVER_ID } from "./serverIdentity.ts";
import { notify } from "./notify.ts";
import { adoptCloudGen, uploadLogin } from "./vault.ts";
import {
  ADOPT_BACKOFF_MS, PENDING_COMMAND_ERROR, preFleetNoticeKey, preFleetText, type PeerObservation, claimDelayMs, claimReason, claimableHere, handoffStuck, isDesignatedNotifier, jumpOutcome, leaseEventAction, leaseKey, moveText,
  observePeer, pendingCommandAction, peerLastSeen, pickShed, shouldFence, shouldUploadOnRelease, slept,
} from "./fleetPlan.ts";

const ME = SERVER_ID;
const EVALUATE_EVERY_MS = 10_000;
const FENCE_CHECK_MS = 5_000;
const NEW_CLAIM_GRACE_MS = 30_000; // a freshly claimed account may not be "wanted" yet (connect command flow)
const RATE_LIMIT_MS = 60_000;
const FIRST_UPLOAD_MS = 60_000;
const STOP_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;

const leaseRef = (uid: string) => col(uid, "fleet").doc("lease");
const mono = () => performance.now();
const TIMED_OUT = Symbol("timed out");
/** Resolves to TIMED_OUT instead of waiting forever on a hung stop or upload (the work itself keeps running). */
const within = <T,>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> => {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<typeof TIMED_OUT>((r) => (t = setTimeout(() => r(TIMED_OUT), ms)))]).finally(() => clearTimeout(t));
};

interface Held {
  epoch: number;
  claimedAt: number;
  // Last successful renew on both clocks: mono() pauses while a laptop sleeps, Date.now() doesn't. Fence on either.
  lastOkMono: number;
  lastOkWall: number;
  handingOff: boolean;
  handingOffAt: number | null;
  renewing: boolean;
  timers: NodeJS.Timeout[];
}
interface Known {
  policy: AiPolicy;
  enabled: boolean;
  /** The account has an agent number linked: it runs under the same lease, as a second browser (docs/agent.md). */
  agent?: boolean;
}

const held = new Map<string, Held>();
const leases = new Map<string, Lease | null>();
const seen = new Map<string, { key: string; at: number }>(); // when we last saw the lease change, mono() time
const peerSeen = new Map<string, PeerObservation>(); // when each peer's heartbeat last changed, mono() time
const uploadChain = new Map<string, Promise<unknown>>();
const pendingCmds = new Map<string, { uid: string; type: string; firstSeenAt: number }>(); // pending commands by doc path; firstSeenAt is Date.now() when this server first saw it
const prefs = new Map<string, FleetPrefs>();
const peers = new Map<string, FleetServerSummary>();
const known = new Map<string, Known>();
const claimTimers = new Map<string, NodeJS.Timeout>();
const rateLimit = new Map<string, number>();
const offlineNotified = new Set<string>();
const serverBeats = new Map<string, ServerBeat>(); // every servers/{id} doc: the pre-fleet guard looks for ones with no `fleet` field
const oldLogged = new Set<string>(); // pre-fleet servers already logged
const oldNoticed = new Set<string>(); // preFleetNoticeKey(old server, uid) already told
const freshReady = new Set<string>(); // sessions that reached ready from a fresh QR link under the current claim (see resolveMarker)
let hooks: { onAcquire(uid: string): void; retryPending?(uid: string): void } = { onAcquire: () => undefined };
let draining = false;
let started = false;
let leasesReady = false;
let peersReady = false;
let serversReady = false;
let localModel = false;
let evalTimer: NodeJS.Timeout | undefined;

// ---- capacity ----
function maxAccounts() {
  const env = Number(process.env.NBS_MAX_ACCOUNTS);
  return Number.isInteger(env) && env > 0 ? env : defaultMaxAccounts(os.totalmem(), localModel);
}
/** Browsers this server runs for its leases: one per account, plus one for each account's agent number. maxAccounts is counted in these. */
const units = () => held.size + [...held.keys()].filter((uid) => known.get(uid)?.agent).length;
export const capacity = (): FleetCapacity => ({ installedAt: INSTALLED_AT, maxAccounts: maxAccounts(), hosting: units(), localModel, draining });
setFleetProvider(capacity);

export async function publishFleet() {
  const fleet = capacity();
  const now = Date.now();
  await Promise.all([
    db.collection("fleetServers").doc(ME).set({ id: ME, hostname: os.hostname(), platform: process.platform, lastSeen: now, ...fleet }, { merge: true }),
    db.collection("servers").doc(ME).set({ fleet }, { merge: true }),
  ]);
}
const publish = () => void publishFleet().catch((e) => console.warn("[fleet] publish failed:", e.message));

// ---- views of the world ----
const nameOf = (id: string) => peers.get(id)?.hostname ?? id;
const policyOf = (uid: string) => known.get(uid)?.policy ?? DEFAULT_AI_POLICY;

function candidates(now: number): CandidateServer[] {
  const out: CandidateServer[] = [];
  // Peers are online by what we observed (heartbeat changed recently on our monotonic clock), not by their clock,
  // and only once we've seen a heartbeat change: the first snapshot after boot shows a lastSeen of unknown age.
  for (const p of peers.values()) {
    if (p.id === ME || typeof p.maxAccounts !== "number") continue;
    out.push({ ...p, lastSeen: peerLastSeen(peerSeen.get(p.id), mono(), now) });
  }
  out.push({ id: ME, lastSeen: now, ...capacity() });
  return out;
}
const rank = (uid: string, now = Date.now()) => rankCandidates(candidates(now), { policy: policyOf(uid), pinned: prefs.get(uid)?.pinned ?? null, now });
const staleFor = (uid: string, lease: Lease | null | undefined) => {
  const s = seen.get(uid);
  return s && s.key === leaseKey(lease) ? mono() - s.at : 0;
};
const live = (uid: string) => {
  const l = leases.get(uid);
  return Boolean(l?.server && l.state !== "released" && !claimableHere(l, { now: Date.now(), me: ME, heldLocally: held.has(uid), observedStaleMs: staleFor(uid, l) }));
};

/** Another server (not us) holds a live lease on this account. */
export const hasRemoteHolder = (uid: string) => !held.has(uid) && live(uid);
export const holds = (uid: string) => Boolean(held.get(uid) && !held.get(uid)!.handingOff);
export const heldUids = () => [...held.keys()];

/**
 * Servers running the previous release (no fleet logic): they start every approved account and ignore leases, so while one
 * is online (lastSeen within SERVER_ONLINE_MS) this server must not claim or start anything.
 */
const preFleet = (now = Date.now()) => preFleetServers([...serverBeats.values()], ME, now);
const oldServerRunning = () => !serversReady || preFleet().length > 0;

// ---- claim ----
/** Accounts this server gave up because its WhatsApp page kept failing: not claimed back for a while, so another server gets its turn (even a pinned one). */
const unhealthyUntil = new Map<string, number>();
const UNHEALTHY_COOLDOWN_MS = 15 * 60_000;

async function claim(uid: string, opts: { requireWanted: boolean }): Promise<boolean> {
  claimTimers.delete(uid);
  if (draining || held.has(uid)) return held.has(uid);
  if ((unhealthyUntil.get(uid) ?? 0) > Date.now()) return false;
  if (oldServerRunning()) return false;
  if (opts.requireWanted && !known.get(uid)?.enabled) return false;
  if (units() >= capacity().maxAccounts) return false;
  const res = await db.runTransaction(async (tx) => {
    const snap = await tx.get(leaseRef(uid));
    const cur = snap.exists ? (snap.data() as Lease) : null;
    const now = Date.now();
    if (!claimableHere(cur, { now, me: ME, heldLocally: held.has(uid), observedStaleMs: staleFor(uid, cur) })) return null;
    const next: Lease = {
      server: ME,
      epoch: (cur?.epoch ?? 0) + 1,
      state: "running",
      renewedAt: now,
      claimedAt: now,
      moveTo: null,
      reason: claimReason(cur, ME),
      from: cur?.server ?? cur?.from ?? null,
    };
    tx.set(leaseRef(uid), next);
    return { next, crashed: Boolean(cur?.server && cur.state === "running") };
  });
  if (!res) return false;
  const { next, crashed } = res;
  const h: Held = { epoch: next.epoch, claimedAt: Date.now(), lastOkMono: mono(), lastOkWall: Date.now(), handingOff: false, handingOffAt: null, renewing: false, timers: [] };
  h.timers.push(setInterval(() => {
    void uploadNow(uid, true);
    void uploadNow(uid, true, "agent");
  }, VAULT_UPLOAD_EVERY_MS).unref());
  held.set(uid, h);
  freshReady.delete(uid);
  leases.set(uid, next);
  console.log(`[fleet] ${uid} claimed (epoch ${next.epoch}, ${next.reason})`);
  publish();
  if (next.from && next.from !== ME) {
    const text = moveText(nameOf(next.from), nameOf(ME), crashed && next.reason === "failover");
    void col(uid, "notices").add({ level: "info", kind: "server", text, createdAt: Date.now(), read: false, expireAt: expireAt(TTL_DAYS.notices) }).catch(() => undefined);
    void notify(uid, "account_moved", text).catch((e) => console.warn("[fleet] notify failed:", e.message));
  }
  hooks.onAcquire(uid);
  return true;
}

function scheduleClaim(uid: string, delay: number) {
  if (claimTimers.has(uid)) return;
  claimTimers.set(uid, setTimeout(() => void claim(uid, { requireWanted: true }).catch((e) => console.warn(`[fleet] claim ${uid} failed:`, e.message)), delay).unref());
}
function cancelClaim(uid: string) {
  const t = claimTimers.get(uid);
  if (t) clearTimeout(t);
  claimTimers.delete(uid);
}

// ---- renew / fence / lose ----
async function touch(uid: string, h: Held): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const cur = (await tx.get(leaseRef(uid))).data() as Lease | undefined;
    if (!cur || cur.server !== ME || cur.epoch !== h.epoch) return false;
    tx.update(leaseRef(uid), { renewedAt: Date.now() });
    return true;
  });
}

async function renew(uid: string) {
  const h = held.get(uid);
  if (!h || h.renewing) return;
  // A hung handoff must not keep the lease alive: stop renewing and let the fence and expiry do their job.
  if (h.handingOff && handoffStuck(h.handingOffAt, Date.now())) return;
  h.renewing = true;
  try {
    const ok = await touch(uid, h);
    if (held.get(uid) !== h) {
      if (ok) void releaseLease(uid, h.epoch); // fenced meanwhile: don't sit on a lease we aren't running
      return;
    }
    if (ok) {
      h.lastOkMono = mono();
      h.lastOkWall = Date.now();
    }
    else drop(uid, "lost");
  } catch (e) {
    console.warn(`[fleet] renew ${uid} failed:`, (e as Error).message);
  } finally {
    h.renewing = false;
  }
}

// Suspend / clock-jump detection: the wall clock keeps running while a laptop sleeps, performance.now() doesn't.
// A forward wall-clock step (NTP, VM resume) looks the same, so we never decide from the clocks alone.
let prevWall = Date.now();
let prevMono = mono();
/** Renew a held lease right now and act on the answer: still ours keeps it, taken over or unreachable drops it. */
async function verifyHeld(uid: string, h: Held) {
  let result: boolean | Error;
  try {
    result = await touch(uid, h);
  } catch (e) {
    console.warn(`[fleet] ${uid} renew after clock jump failed:`, (e as Error).message);
    result = e as Error;
  }
  const outcome = jumpOutcome(result);
  if (held.get(uid) !== h) {
    if (outcome === "keep") void releaseLease(uid, h.epoch); // dropped meanwhile: don't sit on a lease we aren't running
    return;
  }
  if (outcome === "keep") {
    h.lastOkMono = mono();
    h.lastOkWall = Date.now();
  } else drop(uid, outcome === "lost" ? "lost" : "fenced");
}
/**
 * Called from every timer tick. If the clocks disagree (suspend, or a clock step), our leases may have been taken
 * over meanwhile and a routine renew could "succeed" before the fence notices; so renew every held lease immediately.
 * A real sleep is caught by the epoch check: others claimed meanwhile, so the renew fails and the lease drops (no
 * upload). A clock step with nobody having claimed just renews. A hung renew still ends in the normal fence.
 */
function checkSlept() {
  const wall = Date.now();
  const m = mono();
  const wallDelta = wall - prevWall;
  const monoDelta = m - prevMono;
  prevWall = wall;
  prevMono = m;
  if (!slept(wallDelta, monoDelta)) return false;
  console.warn(`[fleet] clock jumped or process was suspended (~${Math.round((wallDelta - monoDelta) / 1000)}s); renewing ${held.size} account(s) now`);
  for (const [uid, h] of held) {
    h.lastOkWall = wall; // the wall delta is meaningless after a jump; the mono clock and the renew result decide
    void verifyHeld(uid, h);
  }
  schedule();
  return true;
}

/** Stop running the account right now, without uploading: someone else may already own it. */
function drop(uid: string, why: "lost" | "fenced") {
  const h = held.get(uid);
  if (!h) return;
  held.delete(uid);
  h.timers.forEach(clearInterval);
  h.timers.forEach(clearTimeout);
  console.warn(`[fleet] ${uid} ${why === "lost" ? "lease lost to another server" : "fenced (couldn't renew)"}: stopping`);
  void sessions.stop(uid);
  void agentSessions.stop(uid);
  publish();
  if (why === "fenced") void releaseLease(uid, h.epoch);
}

/** Release only if the lease is still ours at this epoch. */
async function releaseLease(uid: string, epoch: number, moveTo: string | null = null, reason?: Lease["reason"]) {
  await db
    .runTransaction(async (tx) => {
      const cur = (await tx.get(leaseRef(uid))).data() as Lease | undefined;
      if (!cur || cur.server !== ME || cur.epoch !== epoch) return;
      tx.update(leaseRef(uid), { server: null, state: "released", renewedAt: Date.now(), from: ME, moveTo, ...(reason ? { reason } : {}) });
    })
    .catch((e) => console.warn(`[fleet] release ${uid} failed:`, e.message));
}

// ---- vault ----
/** One upload at a time per account: a handoff waits for a running periodic upload, then does its own final one. */
function enqueueUpload<T>(uid: string, job: () => Promise<T>): Promise<T> {
  const run = (uploadChain.get(uid) ?? Promise.resolve()).catch(() => undefined).then(job);
  const tail = run.catch(() => undefined);
  uploadChain.set(uid, tail);
  void tail.then(() => uploadChain.get(uid) === tail && uploadChain.delete(uid));
  return run;
}

/**
 * `periodic`: the timer-driven kind, which the vault skips when the login folders haven't changed.
 * `which`: the account's own WhatsApp, or its agent number (a second login, saved under `{uid}_agent`; both ride the one lease).
 */
function uploadNow(uid: string, periodic = false, which: "main" | "agent" = "main") {
  const id = which === "agent" ? agentVaultId(uid) : uid;
  return enqueueUpload(uid, async () => {
    // Checked when the job runs, not when it was queued: a handoff may have started meanwhile.
    const h = held.get(uid);
    if (!h || h.handingOff || !(which === "agent" ? agentSessions.get(uid) : sessions.get(uid))) return;
    try {
      if (!(await touch(uid, h))) return; // not ours any more: the lease watcher will stop the session
      const meta = await within(uploadLogin(id, ME, { sessionReady: true, epoch: h.epoch, freshLink: freshReady.has(id), periodic }), UPLOAD_TIMEOUT_MS);
      if (meta === TIMED_OUT) console.warn(`[fleet] ${id} vault upload timed out; will retry`);
      else if (!meta) console.log(`[fleet] ${id} vault upload skipped (unchanged, not ready, behind the cloud, or another writer won)`);
    } catch (e) {
      console.warn(`[fleet] ${id} vault upload failed, will retry:`, (e as Error).message);
    }
  });
}

/** Planned stop of one account: stop Chromium (clean copy), upload, release. Skips both if we lost the lease meanwhile. */
async function finishRelease(uid: string, h: Held, o: { upload: boolean; moveTo: string | null; reason?: Lease["reason"] }) {
  h.handingOff = true;
  h.handingOffAt ??= Date.now();
  // Read before stop(): stopping clears readiness, and an unlinked profile (QR showing) must never be uploaded.
  // The account's agent number (a second browser under the same lease) is stopped, saved and released together with it.
  const logins = [
    { id: uid, wasReady: Boolean(sessions.get(uid)), stop: () => sessions.stop(uid, { backup: true }), kill: () => sessions.kill(uid) },
    { id: agentVaultId(uid), wasReady: Boolean(agentSessions.get(uid)), stop: () => agentSessions.stop(uid), kill: () => agentSessions.kill(uid) },
  ];
  const timedOut = await Promise.all(
    logins.map(async (l) => {
      const stopped = (await within(l.stop(), STOP_TIMEOUT_MS)) === TIMED_OUT;
      if (stopped) {
        // Chromium may still be alive: kill it before the lease goes, or two servers could run one account.
        console.warn(`[fleet] ${l.id} stop timed out after ${STOP_TIMEOUT_MS / 1000}s; killing the browser and releasing without an upload`);
        l.kill();
      }
      return stopped;
    }),
  );
  if (held.get(uid) !== h) return;
  for (const [i, l] of logins.entries()) {
    if (!shouldUploadOnRelease({ wantUpload: o.upload, wasReady: l.wasReady, stopTimedOut: timedOut[i] })) continue;
    try {
      const res = await enqueueUpload(uid, async () => {
        if (!(await touch(uid, h))) return undefined;
        return within(uploadLogin(l.id, ME, { sessionReady: l.wasReady, epoch: h.epoch, freshLink: freshReady.has(l.id) }), UPLOAD_TIMEOUT_MS);
      });
      if (res === TIMED_OUT) console.warn(`[fleet] ${l.id} handoff upload timed out; releasing anyway`);
      else if (res === null) console.warn(`[fleet] ${l.id} handoff upload returned nothing; peer falls back to its local copy or a QR`);
    } catch (e) {
      console.warn(`[fleet] ${l.id} handoff upload failed, releasing anyway:`, (e as Error).message);
    }
    if (held.get(uid) !== h) return;
  }
  await releaseLease(uid, h.epoch, o.moveTo, o.reason);
  if (held.get(uid) === h) {
    held.delete(uid);
    h.timers.forEach(clearInterval);
    h.timers.forEach(clearTimeout);
  }
  publish();
  console.log(`[fleet] ${uid} released${o.moveTo ? ` to ${o.moveTo}` : ""}`);
}

/** Clear a refused moveTo only while the lease is still ours at this epoch. */
const clearMoveTo = (uid: string, epoch: number) =>
  db.runTransaction(async (tx) => {
    const cur = (await tx.get(leaseRef(uid))).data() as Lease | undefined;
    if (!cur || cur.server !== ME || cur.epoch !== epoch) return;
    tx.update(leaseRef(uid), { moveTo: null });
  });

async function handoff(uid: string) {
  const h = held.get(uid);
  const lease = leases.get(uid);
  if (!h || h.handingOff || !lease?.moveTo) return;
  const to = lease.moveTo;
  if (!rank(uid).some((s) => s.id === to)) {
    console.warn(`[fleet] ${uid}: ${to} can't take it (offline, full or not allowed); staying`);
    await clearMoveTo(uid, h.epoch).catch(() => undefined);
    return;
  }
  h.handingOff = true;
  h.handingOffAt = Date.now();
  try {
    const ok = await db.runTransaction(async (tx) => {
      const cur = (await tx.get(leaseRef(uid))).data() as Lease | undefined;
      if (!cur || cur.server !== ME || cur.epoch !== h.epoch) return false;
      tx.update(leaseRef(uid), { state: "handing_off" });
      return true;
    });
    if (!ok) {
      h.handingOff = false;
      h.handingOffAt = null;
      return;
    }
  } catch (e) {
    h.handingOff = false;
    h.handingOffAt = null;
    console.warn(`[fleet] handoff ${uid} failed to start:`, (e as Error).message);
    return;
  }
  await finishRelease(uid, h, { upload: true, moveTo: to, reason: lease.reason ?? "move" });
}

// ---- moves ----
async function setMoveTo(uid: string, to: string, reason: "move" | "rebalance", expectServer: string, epoch?: number) {
  return db.runTransaction(async (tx) => {
    const cur = (await tx.get(leaseRef(uid))).data() as Lease | undefined;
    if (!cur || cur.server !== expectServer || cur.state !== "running" || (epoch !== undefined && cur.epoch !== epoch)) return false;
    tx.update(leaseRef(uid), { moveTo: to, reason });
    return true;
  });
}
const limited = (key: string) => {
  const last = rateLimit.get(key) ?? 0;
  if (Date.now() - last < RATE_LIMIT_MS) return true;
  rateLimit.set(key, Date.now());
  return false;
};

/** move_account on the current holder: ask for a handoff; the lease watcher does the rest. */
export async function requestMove(uid: string, to: string) {
  if (!to) throw new Error("Pick a server to move to");
  if (to === ME) return { ok: true, to };
  const h = held.get(uid);
  if (!h) throw new Error("This server isn't running that account");
  if (!rank(uid).some((s) => s.id === to)) throw new Error(`${nameOf(to)} can't take this account right now (offline, full, shutting down, or it has no local AI model).`);
  if (!(await setMoveTo(uid, to, "move", ME, h.epoch))) throw new Error("The account changed hands meanwhile; try again");
  return { ok: true, to };
}

// ---- command gate ----
/**
 * Should this server execute a user command? The holder does. With no live holder, only the two commands that can
 * create one run: connect (on the best-ranked server) and move_account (on its target). Everything else stays
 * pending and is replayed by whoever acquires the account.
 */
export async function gate(uid: string, type: string, payload?: Record<string, unknown>): Promise<"run" | "skip"> {
  if (holds(uid)) return "run";
  if (held.has(uid) || draining) return "skip";
  if (type === "move_account") {
    if (payload?.to !== ME) return "skip";
  } else if (type === "connect") {
    if (rank(uid)[0]?.id !== ME) return "skip";
  } else return "skip";
  return (await claim(uid, { requireWanted: false }).catch(() => false)) ? "run" : "skip";
}

/** Should this server show the "worker online" dot for an account nobody runs? Best-ranked server only. */
export const shouldBeat = (uid: string) => holds(uid) || (leasesReady && !live(uid) && rank(uid)[0]?.id === ME);

// ---- pending commands ----
export const trackCommand = (uid: string, id: string, type: string) => {
  const key = `${uid}/${id}`;
  if (!pendingCmds.has(key)) pendingCmds.set(key, { uid, type, firstSeenAt: Date.now() });
};
export const untrackCommand = (uid: string, id: string) => void pendingCmds.delete(`${uid}/${id}`);

/** Is this account held here, mid-move (handing off, or released towards a target that hasn't claimed it yet)? */
export function isMoving(uid: string) {
  if (held.get(uid)?.handingOff) return true;
  const l = leases.get(uid);
  return !held.has(uid) && Boolean(l && l.state === "released" && l.moveTo);
}

/**
 * A gate-triggered claim whose command turned out not to be pending any more (another server ran it, or it expired)
 * leaves us holding an account nobody wants. Release it now unless the account is enabled or other commands wait.
 */
export function releaseIfUnwanted(uid: string, commandId: string) {
  const h = held.get(uid);
  if (!h || h.handingOff || known.get(uid)?.enabled) return;
  for (const [key, c] of pendingCmds) if (c.uid === uid && key !== `${uid}/${commandId}`) return;
  console.log(`[fleet] ${uid} claimed for a command that is gone and nothing else wants it; releasing`);
  void finishRelease(uid, h, { upload: false, moveTo: null });
}

/** Error out a command nobody could run. Same pending check as runCommand's claim, so exactly one server wins. */
async function expireCommand(key: string) {
  const [uid, id] = key.split("/");
  pendingCmds.delete(key);
  try {
    const ref = col(uid, "commands").doc(id);
    await db.runTransaction(async (tx) => {
      if ((await tx.get(ref)).data()?.status !== "pending") return;
      tx.update(ref, { status: "error", error: PENDING_COMMAND_ERROR, finishedAt: Date.now() });
    });
  } catch (e) {
    console.warn(`[fleet] couldn't expire command ${key}:`, (e as Error).message);
  }
}

// ---- evaluation ----
function schedule() {
  if (evalTimer) return;
  evalTimer = setTimeout(() => {
    evalTimer = undefined;
    try {
      evaluate();
    } catch (e) {
      console.error("[fleet] evaluate", e);
    }
  }, 200);
  evalTimer.unref();
}

/** Old servers seen online for longer than this get a notice; a brief blip (e.g. this machine's own upgrade) doesn't. */
const OLD_NOTICE_AFTER_MS = 120_000;
const oldSince = new Map<string, number>();
const oldNoticeId = (serverId: string) => `old-server-${serverId}`.replace(/[^\w-]/g, "_");

/** Log once per old server, tell each affected curator once it has stayed up a while, and clear the notice when it's gone. */
function guardAgainstOldServers(now: number) {
  const old = preFleet(now);
  const ids = new Set(old.map((s) => s.id));
  for (const id of [...oldLogged]) if (!ids.has(id)) {
    oldLogged.delete(id);
    console.log(`[fleet] old server "${id}" is gone; resuming`);
  }
  for (const id of [...oldSince.keys()]) if (!ids.has(id)) oldSince.delete(id);
  for (const k of [...oldNoticed]) {
    const [id, uid] = k.split(":");
    if (ids.has(id)) continue;
    oldNoticed.delete(k);
    void col(uid, "notices").doc(oldNoticeId(id)).delete().catch(() => undefined);
  }
  for (const s of old) {
    const name = serverBeats.get(s.id)?.hostname ?? s.id;
    if (!oldLogged.has(s.id)) {
      oldLogged.add(s.id);
      console.warn(`[fleet] old server "${name}" is running: stop it, two servers would answer the same chats`);
    }
    if (!oldSince.has(s.id)) oldSince.set(s.id, now);
    if (now - oldSince.get(s.id)! < OLD_NOTICE_AFTER_MS) continue;
    for (const [uid, k] of known) {
      const key = preFleetNoticeKey(s.id, uid);
      if (!k.enabled || oldNoticed.has(key)) continue;
      oldNoticed.add(key);
      void col(uid, "notices").doc(oldNoticeId(s.id)).set({ level: "warn", text: preFleetText(name), createdAt: Date.now(), read: false, expireAt: expireAt(TTL_DAYS.notices) }).catch(() => oldNoticed.delete(key));
    }
  }
  return old.length > 0;
}

function evaluate() {
  if (!started || !leasesReady || !peersReady || !serversReady || draining) return;
  const now = Date.now();
  const cap = capacity();
  const blocked = guardAgainstOldServers(now);

  // A session that isn't ours to run (lease lost or released, a launch that raced a stop) is stopped, never left to answer chats.
  for (const uid of sessions.activeUids()) {
    if (held.has(uid)) continue;
    console.warn(`[fleet] ${uid} has a session but this server doesn't hold the account; stopping it`);
    void sessions.stop(uid);
  }
  for (const uid of agentSessions.activeUids()) {
    if (held.has(uid)) continue;
    console.warn(`[fleet] ${uid} has an agent session but this server doesn't hold the account; stopping it`);
    void agentSessions.stop(uid);
  }

  for (const [uid, h] of held) {
    if (!known.get(uid)?.enabled && now - h.claimedAt > NEW_CLAIM_GRACE_MS && !h.handingOff) {
      console.log(`[fleet] ${uid} no longer wanted; releasing`);
      void finishRelease(uid, h, { upload: false, moveTo: null });
    }
  }

  if (units() > cap.maxAccounts) {
    const order = [...held].filter(([, h]) => !h.handingOff).map(([uid, h]) => ({ uid, claimedAt: h.claimedAt, pinnedHere: prefs.get(uid)?.pinned === ME, units: known.get(uid)?.agent ? 2 : 1 }));
    for (const uid of pickShed(order, cap.maxAccounts)) {
      const to = rank(uid, now).find((s) => s.id !== ME);
      const h = held.get(uid)!;
      if (to && !leases.get(uid)?.moveTo && !limited(`shed:${uid}`)) void setMoveTo(uid, to.id, "rebalance", ME, h.epoch).catch(() => undefined);
    }
  }

  for (const [uid, k] of known) {
    if (blocked) {
      cancelClaim(uid); // an old (pre-fleet) server is online: claim nothing until it's gone
      continue;
    }
    if (!k.enabled || held.has(uid)) continue;
    const lease = leases.get(uid) ?? null;
    if (!claimableHere(lease, { now, me: ME, heldLocally: false, observedStaleMs: staleFor(uid, lease) })) {
      cancelClaim(uid);
      // Pinned here but running elsewhere: pull it back.
      if ((unhealthyUntil.get(uid) ?? 0) <= Date.now() && prefs.get(uid)?.pinned === ME && lease?.server && lease.server !== ME && lease.state === "running" && !lease.moveTo && rank(uid, now)[0]?.id === ME && !limited(`pin:${uid}`)) {
        console.log(`[fleet] ${uid} is pinned here; asking ${lease.server} to hand it over`);
        void setMoveTo(uid, ME, "move", lease.server).catch(() => undefined);
      }
      continue;
    }
    const r = rank(uid, now).findIndex((s) => s.id === ME);
    if (r < 0 || units() >= cap.maxAccounts) {
      cancelClaim(uid);
      continue;
    }
    scheduleClaim(uid, claimDelayMs(r, lease, ME));
  }

  // Pending connect/move_account commands for accounts nobody here runs: retry the gate every pass (a server that was
  // offline or full a minute ago may be able to take it now), and give up after PENDING_COMMAND_EXPIRE_MS.
  const retried = new Set<string>();
  for (const [key, c] of pendingCmds) {
    if (held.has(c.uid)) continue; // replayed once the session is ready
    const act = pendingCommandAction({ type: c.type, firstSeenAt: c.firstSeenAt, now, liveHolder: live(c.uid) });
    if (act === "retry" && !retried.has(c.uid)) {
      retried.add(c.uid);
      hooks.retryPending?.(c.uid);
    } else if (act === "expire") void expireCommand(key);
  }

  // A peer that stopped heartbeating while holding accounts: one online server tells those curators.
  const online = candidates(now).filter((s) => now - s.lastSeen < SERVER_ONLINE_MS).map((s) => s.id);
  if (isDesignatedNotifier(online, ME)) {
    for (const [uid, lease] of leases) {
      if (!lease?.server || lease.server === ME || lease.state !== "running" || !known.has(uid)) continue;
      if (online.includes(lease.server) || staleFor(uid, lease) < LEASE_FENCE_MS) continue;
      const key = `${uid}:${lease.epoch}`;
      if (offlineNotified.has(key)) continue;
      offlineNotified.add(key);
      void notify(uid, "server_offline", `${nameOf(lease.server)} stopped responding. Your WhatsApp will move to another server shortly.`).catch(() => undefined);
    }
  }
}

// ---- lifecycle ----
function onLease(uid: string, lease: Lease | null) {
  const h = held.get(uid);
  const action = h ? leaseEventAction(lease, h, ME) : "keep";
  if (action === "ignore") return; // epoch regression (stale snapshot): neither news nor a reason to drop
  const key = leaseKey(lease);
  if (seen.get(uid)?.key !== key) seen.set(uid, { key, at: mono() });
  leases.set(uid, lease);
  if (!h) return;
  if (action === "drop") drop(uid, "lost");
  else if (lease && lease.moveTo && lease.moveTo !== ME && lease.state === "running") void handoff(uid);
}

export function start(h: { onAcquire(uid: string): void; retryPending?(uid: string): void }) {
  hooks = h;
  started = true;
  sessions.hooks.canRun = (uid) => holds(uid) && !oldServerRunning();
  /** A login (the account's own, or its agent number's: `id` is the vault id) reached ready: save it soon. */
  const onLoginReady = (uid: string, id: string, source: "local" | "cloud" | "fresh", which: "main" | "agent") => {
    if (source === "fresh") freshReady.add(id);
    else freshReady.delete(id);
    if (source === "cloud") return; // just downloaded: the cloud is already current; the periodic upload follows
    const held1 = held.get(uid);
    if (!held1) return;
    void (async () => {
      // A new QR link starts below the cloud gen (a wipe leaves a tombstone): adopt it so the first upload may go out.
      // Retry for about 2 minutes; if it never succeeds, the upload path adopts it itself (freshLink in resolveMarker).
      if (source === "fresh") {
        for (let i = 0; ; i++) {
          if (held.get(uid) !== held1) return;
          try {
            await adoptCloudGen(id);
            break;
          } catch (e) {
            console.warn(`[fleet] ${id} adoptCloudGen failed${i < ADOPT_BACKOFF_MS.length ? ", retrying" : ", leaving it to the upload"}:`, (e as Error).message);
            if (i >= ADOPT_BACKOFF_MS.length) break;
            await new Promise((r) => setTimeout(r, ADOPT_BACKOFF_MS[i]));
          }
        }
      }
      if (held.get(uid) === held1) held1.timers.push(setTimeout(() => void uploadNow(uid, false, which), FIRST_UPLOAD_MS).unref());
    })();
  };
  sessions.hooks.onReady = (uid, source) => onLoginReady(uid, uid, source, "main");
  agentSessions.hooks.canRun = (uid) => holds(uid) && !oldServerRunning();
  agentSessions.hooks.onReady = (uid, source) => onLoginReady(uid, agentVaultId(uid), source, "agent");
  sessions.hooks.onScanNeeded = (uid) => void notify(uid, "scan_needed", "WhatsApp needs to be linked again. Open Settings, then Show QR code, and scan it.").catch(() => undefined);
  sessions.hooks.onLogout = (uid) => {
    const h1 = held.get(uid);
    void agentSessions.stop(uid); // the agent number talks to your number: with no linked WhatsApp it has nothing to do
    if (h1) void releaseLease(uid, h1.epoch).then(() => { held.delete(uid); h1.timers.forEach(clearInterval); h1.timers.forEach(clearTimeout); publish(); });
  };
  sessions.hooks.onUnhealthy = (uid) => {
    const h1 = held.get(uid);
    if (!h1) return;
    console.warn(`[fleet] ${uid} WhatsApp keeps failing here; releasing the account so another server can run it`);
    unhealthyUntil.set(uid, Date.now() + UNHEALTHY_COOLDOWN_MS);
    void sessions.stop(uid);
    void releaseLease(uid, h1.epoch, null, "failover").then(() => { held.delete(uid); h1.timers.forEach(clearInterval); h1.timers.forEach(clearTimeout); publish(); });
  };
  db.collectionGroup("fleet").onSnapshot(
    (q) => {
      for (const ch of q.docChanges()) {
        const uid = ch.doc.ref.parent.parent?.id;
        if (!uid) continue;
        if (ch.doc.id === "lease") onLease(uid, ch.type === "removed" ? null : (ch.doc.data() as Lease));
        else if (ch.doc.id === "prefs") ch.type === "removed" ? prefs.delete(uid) : prefs.set(uid, ch.doc.data() as FleetPrefs);
      }
      leasesReady = true;
      schedule();
    },
    (e) => console.error("[fleet] lease listener", e.message),
  );
  db.collection("fleetServers").onSnapshot(
    (q) => {
      peers.clear();
      q.docs.forEach((d) => {
        const p = d.data() as FleetServerSummary;
        peers.set(d.id, p);
        peerSeen.set(d.id, observePeer(peerSeen.get(d.id), p.lastSeen, mono()));
      });
      peersReady = true;
      schedule();
    },
    (e) => console.error("[fleet] servers listener", e.message),
  );
  db.collection("servers").onSnapshot(
    (q) => {
      serverBeats.clear();
      q.docs.forEach((d) => {
        const v = d.data();
        serverBeats.set(d.id, { id: d.id, lastSeen: typeof v.lastSeen === "number" ? v.lastSeen : undefined, fleet: v.fleet, hostname: typeof v.hostname === "string" ? v.hostname : undefined });
      });
      serversReady = true;
      schedule();
    },
    (e) => console.error("[fleet] servers (guard) listener", e.message),
  );
  setInterval(() => {
    if (!checkSlept()) held.forEach((_, uid) => void renew(uid));
  }, LEASE_RENEW_MS).unref();
  setInterval(() => {
    if (checkSlept()) return;
    for (const [uid, h1] of held) if (shouldFence(mono() - h1.lastOkMono, Date.now() - h1.lastOkWall)) drop(uid, "fenced");
  }, FENCE_CHECK_MS).unref();
  setInterval(schedule, EVALUATE_EVERY_MS).unref();
  publish();
}

/** The accounts this server may serve, with their AI policy; `enabled` means linked or linking. */
export function sync(next: Map<string, Known>) {
  known.clear();
  next.forEach((v, k) => known.set(k, v));
  schedule();
}

export const setLocalModel = (v: boolean) => {
  if (v !== localModel) {
    localModel = v;
    if (started) publish();
  }
};

/** Graceful shutdown: stop taking accounts, then upload and release every one so a peer claims at once. */
export async function drain() {
  draining = true;
  claimTimers.forEach(clearTimeout);
  claimTimers.clear();
  await publishFleet().catch(() => undefined);
  await Promise.all([...held].map(([uid, h]) => (h.handingOff ? Promise.resolve() : finishRelease(uid, h, { upload: true, moveTo: null })).catch((e) => console.warn(`[fleet] drain ${uid}:`, e.message))));
  await db.collection("fleetServers").doc(ME).set({ lastSeen: 0, hosting: 0 }, { merge: true }).catch(() => undefined);
}

export const fleet = { start, sync, holds, hasRemoteHolder, trackCommand, untrackCommand, heldUids, gate, requestMove, shouldBeat, isMoving, releaseIfUnwanted, drain, setLocalModel, publishFleet, capacity };
