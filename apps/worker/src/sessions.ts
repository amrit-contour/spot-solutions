// One whatsapp-web.js client per signed-in curator. Sessions persist on disk (LocalAuth),
// so a reboot reconnects without a new QR scan.
import { execFile } from "node:child_process";
import { cp, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import WAWebJS from "whatsapp-web.js";
import { TTL_DAYS, type SessionState } from "@spot/shared";
import { FieldValue, col, expireAt, sessionRef, userRef } from "./firebase.ts";
import { catchUpSince, enqueue, markLive } from "./intake.ts";
import { handleSelfReply, handleVote } from "./replies.ts";
import { unwatchUser, watchUser } from "./userData.ts";
import { DATA_DIR, SERVER_ID } from "./serverIdentity.ts";
import { live } from "./stats.ts";
import { wipeLogin } from "./vault.ts";
import { setWedgeHook } from "./sendQueue.ts";
import { prepareLoginSafe } from "./vaultCalls.ts";
import { BROWSER_MISSING_MESSAGE, healBrowser, isMissingBrowserError } from "./browserHeal.ts";
import { launchDecision, orphanPids, shouldFlagAbort } from "./fleetPlan.ts";
import { PROBE_EVERY_MS, WaWatchdog, dueOnce, isWedgeError } from "./health.ts";

const { Client, LocalAuth } = WAWebJS;
export { DATA_DIR };

const BACKUP_EVERY_MS = 6 * 3600_000;
const READY_WATCHDOG_MS = 3 * 60_000;
const MAX_PREPARE_FAILS = 5; // failed login restores (each already retried 4 times) before a stale local copy is allowed
const PREPARE_RETRY_MS = 30_000;
const run = promisify(execFile);
const profileDir = (uid: string) => path.join(DATA_DIR, `session-${uid}`);
const backupDir = (uid: string) => path.join(DATA_DIR, `backup-${uid}`);
// Caches are rebuilt by Chromium; the login itself lives in IndexedDB / Local Storage.
const SKIP = /(Cache|Code Cache|GPUCache|Service Worker|DawnCache|GrShaderCache|ShaderCache|Crashpad|Singleton)/;

/** Copy the WhatsApp login out of the Chromium profile, atomically. A clean copy needs Chromium stopped. */
async function backupSession(uid: string) {
  const src = profileDir(uid);
  try {
    await stat(src);
  } catch {
    return;
  }
  const tmp = `${backupDir(uid)}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  await cp(src, tmp, { recursive: true, filter: (f) => !SKIP.test(path.basename(f)) });
  await rm(backupDir(uid), { recursive: true, force: true });
  await rename(tmp, backupDir(uid));
}

/** Put the last good login back (e.g. after a power cut corrupted the profile). */
async function restoreSession(uid: string) {
  await stat(backupDir(uid));
  await rm(profileDir(uid), { recursive: true, force: true });
  await cp(backupDir(uid), profileDir(uid), { recursive: true });
}

/**
 * Kill any process still running on this profile (a Chromium orphaned by a crashed worker, a SIGKILLed parent, or a destroy()
 * that hung): its `--user-data-dir=<profile>` is the only reliable link. Only then are the Singleton* lock files safe to delete.
 */
export async function killOrphanChromium(uid: string) {
  const profile = path.resolve(profileDir(uid));
  try {
    let lines: string[];
    if (process.platform === "win32") {
      const ps = `Get-CimInstance Win32_Process -Filter "CommandLine like '%--user-data-dir=%'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`;
      lines = (await run("powershell", ["-NoProfile", "-Command", ps], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 })).stdout.split(/\r?\n/);
    } else {
      lines = (await run("ps", ["-axo", "pid=,command="], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 })).stdout.split("\n");
    }
    const pids = orphanPids(lines, profile, process.pid);
    for (const pid of pids) {
      console.warn(`[session] ${uid} killing leftover browser process ${pid} on its profile`);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    if (pids.length) await new Promise((r) => setTimeout(r, 1_000)); // let the OS release the profile files
  } catch (e) {
    console.warn(`[session] ${uid} couldn't look for leftover browser processes:`, (e as Error).message);
  }
}

const notice = (uid: string, level: "info" | "warn", text: string) => col(uid, "notices").add({ level, text, createdAt: Date.now(), read: false, expireAt: expireAt(TTL_DAYS.notices) }).catch(() => undefined);

/** One notice per `key` per window, so a flapping page or a retry loop never floods Updates. */
const noticed = new Map<string, number>();
const NOTICE_WINDOW_MS = 30 * 60_000;
export function noticeOnce(uid: string, key: string, level: "info" | "warn", text: string, windowMs = NOTICE_WINDOW_MS) {
  if (!dueOnce(noticed, `${uid}|${key}`, windowMs, Date.now())) return false;
  void notice(uid, level, text);
  return true;
}
/** Start failures in a row before the app is told (one slow start is normal). */
const START_NOTICE_AFTER = 2;
const startRetryMs = (fails: number) => Math.min(5 * 60_000, 15_000 * 2 ** Math.max(0, fails - 1));

// lastSeen drives the app's online dot (zeroed on shutdown); aliveAt is when we last processed messages (never zeroed).
const setState = (uid: string, s: Partial<SessionState>) => {
  live.recordSession(uid, s); // the server console's live view
  return sessionRef(uid).set({ ...s, lastSeen: Date.now(), aliveAt: Date.now() }, { merge: true });
};

/** Set by fleet.ts: sessions only run while this server holds the account's lease. */
interface Hooks {
  canRun?: (uid: string) => boolean;
  onReady?: (uid: string, source: "local" | "cloud" | "fresh") => void;
  onScanNeeded?: (uid: string) => void;
  onLogout?: (uid: string) => void;
  /** The WhatsApp page keeps failing after restarts: release the account so another server can take it (fleet.ts). */
  onUnhealthy?: (uid: string) => void;
}

class SessionManager {
  hooks: Hooks = {};
  private sources = new Map<string, "local" | "cloud" | "fresh">();
  private clients = new Map<string, WAWebJS.Client>();
  private stopping = new Map<string, WAWebJS.Client>(); // clients whose destroy() is still running, so kill() can reach them
  private ready = new Set<string>();
  private restarting = new Set<string>();
  /** Times in a row a session signed in but never became ready (see the watchdog on "authenticated"). */
  private stuck = new Map<string, number>();
  private restoredOnce = new Set<string>();
  /** The health watchdog outlives a client (its restart count must survive the restart it causes). */
  private dogs = new Map<string, WaWatchdog>();
  private probeTimers = new Map<string, NodeJS.Timeout>();
  private startFails = new Map<string, number>();
  /** When each session last became ready: other jobs (group cleanup) wait for it to be stable. */
  private readyAt = new Map<string, number>();
  private backupTimers = new Map<string, NodeJS.Timeout>();

  get(uid: string) {
    return this.ready.has(uid) ? this.clients.get(uid) : undefined;
  }

  require(uid: string) {
    const c = this.get(uid);
    if (!c) throw new Error("WhatsApp isn't connected yet");
    return c;
  }

  /** Ready for at least `ms`, so jobs that need a settled WhatsApp (group cleanup) don't run on a page that just loaded. */
  stableFor(uid: string, ms: number, now = Date.now()) {
    const t = this.readyAt.get(uid);
    return this.ready.has(uid) && t !== undefined && now - t >= ms;
  }

  /** Healthy: ready and not flagged by the watchdog. */
  healthy(uid: string) {
    return this.ready.has(uid) && (this.dogs.get(uid)?.health ?? "ok") === "ok";
  }

  /** Call when a WhatsApp call failed: a page-level error (protocol, closed target, timeout) triggers an immediate probe. */
  noteWaError(uid: string, err: unknown) {
    if (!isWedgeError(err) || !this.ready.has(uid)) return;
    void this.dogFor(uid).check(err).catch((e) => console.error("[health] check failed", e));
  }

  private dogFor(uid: string) {
    let d = this.dogs.get(uid);
    if (!d) {
      d = new WaWatchdog({
        probe: async () => {
          const c = this.clients.get(uid);
          if (!c?.pupPage) throw new Error("no WhatsApp page");
          await c.pupPage.evaluate(() => 1);
        },
        restart: async (delayMs) => {
          console.warn(`[health] ${uid} WhatsApp page unresponsive; restarting it in ${delayMs / 1000}s`);
          const stopping = this.stop(uid);
          await Promise.race([stopping, new Promise((r) => setTimeout(r, 20_000))]); // a wedged browser can hang destroy()
          this.kill(uid); // no-op when it closed cleanly
          this.scheduleRestart(uid, delayMs);
        },
        setHealth: (health, note) => {
          console.warn(`[health] ${uid} ${health}${note ? `: ${note}` : ""}`);
          void setState(uid, { health, error: note, ...(health === "failing" ? { status: "error" as const } : {}) });
        },
        notify: (key, level, text) => void noticeOnce(uid, `health-${key}`, level, text, key === "recovered" ? 5 * 60_000 : NOTICE_WINDOW_MS),
        giveUp: this.hooks.onUnhealthy ? () => this.hooks.onUnhealthy?.(uid) : undefined,
        now: Date.now,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        serverName: SERVER_ID,
      });
      this.dogs.set(uid, d);
    }
    return d;
  }

  running(uid: string) {
    return this.clients.has(uid);
  }

  private starting = new Set<string>();
  private aborted = new Set<string>(); // stop() was called while launch() was still preparing; launch() must not register a client
  private prepareFails = new Map<string, number>();

  /** Uids with a client, or one on its way (a launch in flight): everything stop() has to deal with. */
  activeUids() {
    return new Set([...this.clients.keys(), ...this.starting]);
  }

  async start(uid: string) {
    // Claim synchronously: the connect command and the users listener can both call this in the same tick.
    if (this.clients.has(uid) || this.starting.has(uid)) return;
    if (this.hooks.canRun && !this.hooks.canRun(uid)) return;
    this.starting.add(uid);
    this.aborted.delete(uid);
    this.dogs.get(uid)?.resetIfStale(Date.now()); // the account came back after a give-up: start fresh
    try {
      await this.launch(uid);
    } catch (e) {
      console.error(`[session] ${uid} launch failed`, e);
      this.scheduleRestart(uid, PREPARE_RETRY_MS);
    } finally {
      this.starting.delete(uid);
      // stop() hit us mid-launch, but the lease may be ours again by now (stop, then re-claim): don't strand the account.
      if (this.aborted.delete(uid) && this.hooks.canRun?.(uid)) this.scheduleRestart(uid, 2_000);
    }
  }

  private async launch(uid: string) {
    // Newest login copy wins (docs/fleet.md): may download the cloud copy over a stale local profile. A transient failure
    // (retried inside) never becomes a QR: wait and try again; only after MAX_PREPARE_FAILS rounds fall back to the local copy.
    const fails = this.prepareFails.get(uid) ?? 0;
    let source: "local" | "cloud" | "fresh";
    try {
      source = await prepareLoginSafe(uid, { allowStaleLocal: fails >= MAX_PREPARE_FAILS });
    } catch (e) {
      this.prepareFails.set(uid, fails + 1);
      console.warn(`[session] ${uid} can't read its login backup yet (attempt ${fails + 1}); retrying in ${PREPARE_RETRY_MS / 1000}s:`, (e as Error).message);
      if (fails + 1 === MAX_PREPARE_FAILS) void notice(uid, "warn", "Nothing BOT Curate can't read the saved copy of your WhatsApp login right now. It keeps trying; if this server has an older copy it will use that next.");
      this.scheduleRestart(uid, PREPARE_RETRY_MS);
      return;
    }
    this.prepareFails.delete(uid);
    if (fails >= MAX_PREPARE_FAILS && source === "local") void notice(uid, "warn", "The saved copy of your WhatsApp login couldn't be read, so this server started from its own older copy. It may ask for a scan.");
    this.sources.set(uid, source);
    if (launchDecision({ aborted: this.aborted.has(uid), canRun: this.hooks.canRun?.(uid) ?? true }) === "abort") return; // stopped or lease lost while downloading
    watchUser(uid);
    // A crashed worker can leave Chromium orphaned on this profile (and its lock files behind): kill it first, then clear the locks.
    const profile = path.join(DATA_DIR, `session-${uid}`);
    await killOrphanChromium(uid);
    await Promise.all(["SingletonLock", "SingletonCookie", "SingletonSocket"].map((f) => rm(path.join(profile, f), { force: true })));
    // Was this account linked before the server went down? Then a QR now means the saved login broke.
    const prev = (await sessionRef(uid).get()).data() as SessionState | undefined;
    const wasLinked = Boolean(prev?.phone);
    const offlineSince = prev?.aliveAt ?? prev?.lastSeen ?? Date.now();
    let sawQr = false;
    await setState(uid, { status: "starting", qr: null, error: null });
    // The awaits above gave stop() and the lease watcher time to act; check again before building the client.
    if (launchDecision({ aborted: this.aborted.has(uid), canRun: this.hooks.canRun?.(uid) ?? true }) === "abort") {
      unwatchUser(uid);
      return;
    }

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: uid, dataPath: DATA_DIR }),
      puppeteer: {
        headless: true,
        // Reading a big account (every chat for Learn my voice, Messages, history scans) can take minutes in WhatsApp Web;
        // puppeteer's default 3-minute limit per browser call failed those with "Runtime.callFunctionOn timed out".
        protocolTimeout: 10 * 60_000,
        executablePath: process.env.CHROME_PATH || undefined,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote"],
        // Our own shutdown drain (index.ts) must run first: puppeteer's handlers would close Chromium before the final upload.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      },
    });
    // Last check, with no await between it and the registration: stop() or a lost lease must not leave an untracked client.
    if (launchDecision({ aborted: this.aborted.has(uid), canRun: this.hooks.canRun?.(uid) ?? true }) === "abort") {
      void client.destroy().catch(() => undefined); // never initialised: nothing to close, but release anything it allocated
      unwatchUser(uid);
      return;
    }
    this.clients.set(uid, client);
    live.bindClient(uid, client); // sends through this client count toward this account

    client.on("qr", async (qr) => {
      if (!sawQr && wasLinked) {
        // First try the last good backup of the login, once.
        if (!this.restoredOnce.has(uid)) {
          this.restoredOnce.add(uid);
          try {
            await stat(backupDir(uid));
            console.warn(`[session] ${uid} lost its login; restoring the last backup`);
            await this.stop(uid);
            await restoreSession(uid);
            void this.start(uid);
            return;
          } catch {
            /* no backup: fall through to asking for a scan */
          }
        }
        console.warn(`[session] ${uid} needs to be re-linked`);
        this.hooks.onScanNeeded?.(uid);
        void notice(uid, "warn", "WhatsApp asked to be linked again (it can happen after a power cut, or if the phone was offline for weeks). Open Settings → Show QR code and scan it.");
      }
      sawQr = true;
      void setState(uid, { status: "qr", qr });
    });
    client.on("authenticated", () => {
      void setState(uid, { status: "authenticated", qr: null });
      // Signed in but never "ready": WhatsApp Web loaded before whatsapp-web.js could hook in (an upstream race).
      // Nothing retries that on its own, so reload the browser rather than sit there for hours.
      setTimeout(() => {
        if (this.clients.get(uid) !== client || this.ready.has(uid)) return;
        const n = (this.stuck.get(uid) ?? 0) + 1;
        this.stuck.set(uid, n);
        console.warn(`[session] ${uid} signed in but not ready after ${READY_WATCHDOG_MS / 60_000} min; reloading (try ${n})`);
        void this.stop(uid).then(() => this.scheduleRestart(uid, Math.min(5, n) * 15_000));
        if (n === 3) void notice(uid, "warn", "WhatsApp signed in but keeps failing to finish loading on the server. It keeps retrying; if this lasts, restart the server from its console.");
      }, READY_WATCHDOG_MS).unref();
    });
    client.on("auth_failure", (m) => void setState(uid, { status: "error", error: `Auth failed: ${m}` }));
    client.on("ready", async () => {
      this.ready.add(uid);
      this.readyAt.set(uid, Date.now());
      this.stuck.delete(uid);
      this.startFails.delete(uid);
      const me = client.info;
      await setState(uid, { status: "ready", qr: null, phone: me?.wid?.user ?? null, pushName: me?.pushname ?? null, error: null, health: "ok" });
      await userRef(uid).set({ waEnabled: true, selfId: me?.wid?._serialized ?? null }, { merge: true });
      console.log(`[session] ${uid} ready as +${me?.wid?.user}`);
      markLive(uid);
      this.restoredOnce.delete(uid);
      this.hooks.onReady?.(uid, this.sources.get(uid) ?? "local");
      // Fresh link: old chats are never read. Restored link: read what arrived while we were down (no auto-replies).
      if (!sawQr && wasLinked) {
        catchUpSince(uid, client, offlineSince).then((n) => { if (n) void notice(uid, "info", `Server was offline for a while. Caught up on ${n} message${n === 1 ? "" : "s"} that came in meanwhile; nothing was sent automatically.`); }).catch((e) => {
          console.error("[session] catch-up failed", e);
          noticeOnce(uid, "catchup-failed", "warn", `WhatsApp on ${SERVER_ID} was slow to answer, so messages from while the server was offline weren't all read (${String((e as Error).message ?? e).slice(0, 120)}). Open Messages to check for anything missed.`);
          this.noteWaError(uid, e);
        });
      }
      // Keep a recent copy of the login so a crash can't cost a re-scan.
      setTimeout(() => void backupSession(uid).catch(() => undefined), 90_000).unref();
      clearInterval(this.backupTimers.get(uid));
      this.backupTimers.set(uid, setInterval(() => void backupSession(uid).catch(() => undefined), BACKUP_EVERY_MS).unref());
      // Cheap probe of the WhatsApp page; a wedged one is reported and restarted (health.ts).
      clearInterval(this.probeTimers.get(uid));
      this.probeTimers.set(uid, setInterval(() => { if (this.clients.get(uid) === client && this.ready.has(uid)) void this.dogFor(uid).check().catch((e) => console.error("[health] check failed", e)); }, PROBE_EVERY_MS).unref());
    });
    client.on("vote_update", (vote) => {
      handleVote(uid, client, vote).catch((e) => console.error("[poll] vote failed", e));
    });
    // Your own messages: only used for mic-check answers in your "Message yourself" chat.
    client.on("message_create", (msg) => {
      if (msg.fromMe) handleSelfReply(uid, client, msg).catch((e) => console.error("[mic-check] reply failed", e));
    });
    client.on("message", (msg) => {
      enqueue(uid, client, msg).catch((e) => console.error("[intake] enqueue failed", e));
    });
    client.on("disconnected", async (reason) => {
      if (this.clients.get(uid) !== client) return; // we stopped it on purpose (handoff, lost lease): not a crash
      console.warn(`[session] ${uid} disconnected: ${reason}`);
      this.ready.delete(uid);
      await setState(uid, { status: "disconnected", error: String(reason) });
      await this.stop(uid);
      if (reason === "LOGOUT") {
        // WhatsApp Web also reports LOGOUT when its local state broke (a full disk, a killed browser), not only when
        // you removed the device on your phone. Keep every backup and try again: the restart restores the last good
        // copy, and if WhatsApp really dropped the link it shows a QR and says so. Only an unlink you chose wipes.
        console.warn(`[session] ${uid} WhatsApp reported LOGOUT; keeping the backups and trying to restore`);
        this.scheduleRestart(uid, 5_000);
      } else {
        this.scheduleRestart(uid);
      }
    });

    try {
      await client.initialize();
    } catch (e) {
      if (isMissingBrowserError(e)) {
        // Chrome isn't on this server (pnpm skipped puppeteer's download). Install it once and try again; say it plainly, not puppeteer's text.
        console.error(`[session] ${uid} can't start: ${BROWSER_MISSING_MESSAGE}`);
        await this.stop(uid);
        if (await healBrowser()) {
          console.log(`[session] ${uid} the browser is installed now; starting again`);
          this.scheduleRestart(uid, 2_000);
        } else {
          await setState(uid, { status: "error", error: BROWSER_MISSING_MESSAGE });
          this.scheduleRestart(uid);
        }
        return;
      }
      console.error(`[session] ${uid} failed to start`, e);
      const fails = (this.startFails.get(uid) ?? 0) + 1;
      this.startFails.set(uid, fails);
      await setState(uid, { status: "error", error: (e as Error).message });
      await this.stop(uid);
      if (fails >= START_NOTICE_AFTER) noticeOnce(uid, "start-failed", "warn", `WhatsApp on ${SERVER_ID} isn't starting (${String((e as Error).message).slice(0, 140)}). It keeps retrying; if this machine is short on memory, closing other apps or using a smaller AI model helps.`);
      this.scheduleRestart(uid, startRetryMs(fails));
    }
  }

  private scheduleRestart(uid: string, ms = 15_000) {
    if (this.restarting.has(uid)) return;
    this.restarting.add(uid);
    setTimeout(() => {
      this.restarting.delete(uid);
      this.start(uid).catch(() => undefined);
    }, ms).unref();
  }

  async stop(uid: string, opts: { backup?: boolean } = {}) {
    if (shouldFlagAbort({ starting: this.starting.has(uid) })) this.aborted.add(uid);
    const c = this.clients.get(uid);
    const wasReady = this.ready.has(uid);
    this.clients.delete(uid);
    this.ready.delete(uid);
    clearInterval(this.backupTimers.get(uid));
    this.backupTimers.delete(uid);
    clearInterval(this.probeTimers.get(uid));
    this.probeTimers.delete(uid);
    this.readyAt.delete(uid);
    unwatchUser(uid);
    if (c) this.stopping.set(uid, c);
    try {
      await c?.destroy().catch(() => undefined);
    } finally {
      if (this.stopping.get(uid) === c) this.stopping.delete(uid);
    }
    // Chromium is closed now, so this is the cleanest possible copy.
    if (opts.backup && wasReady) await backupSession(uid).catch((e) => console.error("[session] backup failed", e.message));
  }

  /**
   * Hard stop for a client whose destroy() hung: detach every handler so nothing more is processed, then SIGKILL its
   * Chromium so the account can't keep running (or sending) after the lease is released.
   */
  kill(uid: string) {
    const c = this.clients.get(uid) ?? this.stopping.get(uid);
    if (!c) return;
    this.clients.delete(uid);
    this.ready.delete(uid);
    c.removeAllListeners();
    try {
      c.pupBrowser?.process()?.kill("SIGKILL");
    } catch (e) {
      console.warn(`[session] ${uid} kill failed:`, (e as Error).message);
    }
  }

  async logout(uid: string) {
    const c = this.clients.get(uid);
    await c?.logout().catch(() => undefined);
    await this.stop(uid);
    await this.wipe(uid);
    await userRef(uid).set({ waEnabled: false }, { merge: true });
    live.recordSession(uid, { status: "idle", phone: null });
    await sessionRef(uid).set({ status: "idle", qr: null, phone: null, pushName: null, error: null, lastSeen: Date.now() });
    this.hooks.onLogout?.(uid);
  }

  /** The tombstone is written first (inside wipeLogin), then the local profile, backup, cloud copy and key go. If the tombstone fails nothing is deleted. */
  private async wipe(uid: string) {
    await wipeLogin(uid, SERVER_ID).catch((e) => console.error("[session] wipeLogin failed; the local login was kept", e.message));
  }

  async stopAll() {
    await Promise.all([...this.clients.keys()].map((uid) => this.stop(uid, { backup: true })));
  }
}

export const sessions = new SessionManager();
setWedgeHook((client, err) => {
  for (const uid of sessions.activeUids()) if (sessions.get(uid) === client) sessions.noteWaError(uid, err);
});
export { FieldValue };
