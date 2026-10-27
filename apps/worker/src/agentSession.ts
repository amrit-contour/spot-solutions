// The agent number's WhatsApp session (docs/agent.md): a second whatsapp-web.js client per account, linked by QR like the first,
// that talks only to the curator's own number. It is part of the account's lease: it runs wherever the account runs, starts after
// it, stops with it, and its login is backed up to the vault under `{uid}_agent` (separate key, meta and Storage prefix).
import path from "node:path";
import { rm } from "node:fs/promises";
import WAWebJS from "whatsapp-web.js";
import { TTL_DAYS, agentVaultId, type SessionState } from "@spot/shared";
import { col, expireAt, userRef } from "./firebase.ts";
import { DATA_DIR, SERVER_ID } from "./serverIdentity.ts";
import { wipeLogin } from "./vault.ts";
import { prepareLoginSafe } from "./vaultCalls.ts";
import { launchDecision, shouldFlagAbort } from "./fleetPlan.ts";
import { killOrphanChromium } from "./sessions.ts";

const { Client, LocalAuth } = WAWebJS;

const READY_WATCHDOG_MS = 3 * 60_000;
const MAX_PREPARE_FAILS = 5;
const PREPARE_RETRY_MS = 30_000;

export const agentRef = (uid: string) => col(uid, "session").doc("agent");

const notice = (uid: string, text: string) => col(uid, "notices").add({ level: "warn", text, createdAt: Date.now(), read: false, expireAt: expireAt(TTL_DAYS.notices) }).catch(() => undefined);
const setState = (uid: string, s: Partial<SessionState>) => agentRef(uid).set({ ...s, lastSeen: Date.now(), aliveAt: Date.now() }, { merge: true });

interface Hooks {
  /** Set by fleet.ts: the agent runs only while this server holds the account's lease. */
  canRun?: (uid: string) => boolean;
  onReady?: (uid: string, source: "local" | "cloud" | "fresh") => void;
  /** Set by agent.ts: a message arrived for the agent. */
  onMessage?: (uid: string, client: WAWebJS.Client, msg: WAWebJS.Message) => void;
}

class AgentSessionManager {
  hooks: Hooks = {};
  private clients = new Map<string, WAWebJS.Client>();
  private stopping = new Map<string, WAWebJS.Client>();
  private ready = new Set<string>();
  private starting = new Set<string>();
  private aborted = new Set<string>();
  private restarting = new Set<string>();
  private stuck = new Map<string, number>();
  private prepareFails = new Map<string, number>();
  private sources = new Map<string, "local" | "cloud" | "fresh">();

  get(uid: string) {
    return this.ready.has(uid) ? this.clients.get(uid) : undefined;
  }
  running(uid: string) {
    return this.clients.has(uid) || this.starting.has(uid);
  }
  activeUids() {
    return new Set([...this.clients.keys(), ...this.starting]);
  }

  async start(uid: string) {
    if (this.clients.has(uid) || this.starting.has(uid)) return;
    if (this.hooks.canRun && !this.hooks.canRun(uid)) return;
    this.starting.add(uid);
    this.aborted.delete(uid);
    try {
      await this.launch(uid);
    } catch (e) {
      console.error(`[agent] ${uid} launch failed`, e);
      this.scheduleRestart(uid, PREPARE_RETRY_MS);
    } finally {
      this.starting.delete(uid);
      if (this.aborted.delete(uid) && this.hooks.canRun?.(uid)) this.scheduleRestart(uid, 2_000);
    }
  }

  private async launch(uid: string) {
    const vid = agentVaultId(uid);
    // Newest login copy wins, exactly as for the account's own WhatsApp (docs/fleet.md): a restore failure that might be
    // transient never turns into a QR.
    const fails = this.prepareFails.get(uid) ?? 0;
    let source: "local" | "cloud" | "fresh";
    try {
      source = await prepareLoginSafe(vid, { allowStaleLocal: fails >= MAX_PREPARE_FAILS });
    } catch (e) {
      this.prepareFails.set(uid, fails + 1);
      console.warn(`[agent] ${uid} can't read the agent login backup yet (attempt ${fails + 1}); retrying in ${PREPARE_RETRY_MS / 1000}s:`, (e as Error).message);
      this.scheduleRestart(uid, PREPARE_RETRY_MS);
      return;
    }
    this.prepareFails.delete(uid);
    this.sources.set(uid, source);
    if (launchDecision({ aborted: this.aborted.has(uid), canRun: this.hooks.canRun?.(uid) ?? true }) === "abort") return;

    const profile = path.join(DATA_DIR, `session-${vid}`);
    await killOrphanChromium(vid);
    await Promise.all(["SingletonLock", "SingletonCookie", "SingletonSocket"].map((f) => rm(path.join(profile, f), { force: true })));
    const prev = (await agentRef(uid).get()).data() as SessionState | undefined;
    const wasLinked = Boolean(prev?.phone);
    let sawQr = false;
    await setState(uid, { status: "starting", qr: null, error: null });
    if (launchDecision({ aborted: this.aborted.has(uid), canRun: this.hooks.canRun?.(uid) ?? true }) === "abort") return;

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: vid, dataPath: DATA_DIR }),
      puppeteer: {
        headless: true,
        // Reading a big account (every chat for Learn my voice, Messages, history scans) can take minutes in WhatsApp Web;
        // puppeteer's default 3-minute limit per browser call failed those with "Runtime.callFunctionOn timed out".
        protocolTimeout: 10 * 60_000,
        executablePath: process.env.CHROME_PATH || undefined,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote"],
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      },
    });
    if (launchDecision({ aborted: this.aborted.has(uid), canRun: this.hooks.canRun?.(uid) ?? true }) === "abort") {
      void client.destroy().catch(() => undefined);
      return;
    }
    this.clients.set(uid, client);

    client.on("qr", (qr) => {
      if (!sawQr && wasLinked) void notice(uid, "The agent number asked to be linked again. Open Settings → WhatsApp → Agent number and scan the code.");
      sawQr = true;
      void setState(uid, { status: "qr", qr });
    });
    client.on("authenticated", () => {
      void setState(uid, { status: "authenticated", qr: null });
      setTimeout(() => {
        if (this.clients.get(uid) !== client || this.ready.has(uid)) return;
        const n = (this.stuck.get(uid) ?? 0) + 1;
        this.stuck.set(uid, n);
        console.warn(`[agent] ${uid} signed in but not ready after ${READY_WATCHDOG_MS / 60_000} min; reloading (try ${n})`);
        void this.stop(uid).then(() => this.scheduleRestart(uid, Math.min(5, n) * 15_000));
      }, READY_WATCHDOG_MS).unref();
    });
    client.on("auth_failure", (m) => void setState(uid, { status: "error", error: `Auth failed: ${m}` }));
    client.on("ready", async () => {
      this.ready.add(uid);
      this.stuck.delete(uid);
      const me = client.info;
      await setState(uid, { status: "ready", qr: null, phone: me?.wid?.user ?? null, pushName: me?.pushname ?? null, error: null });
      console.log(`[agent] ${uid} ready as +${me?.wid?.user}`);
      this.hooks.onReady?.(uid, this.sources.get(uid) ?? "local");
    });
    client.on("message", (msg) => this.hooks.onMessage?.(uid, client, msg));
    client.on("disconnected", async (reason) => {
      if (this.clients.get(uid) !== client) return;
      console.warn(`[agent] ${uid} disconnected: ${reason}`);
      this.ready.delete(uid);
      await setState(uid, { status: "disconnected", error: String(reason) });
      await this.stop(uid);
      // Same as the main login: a LOGOUT can be local breakage, so keep the backups and retry; only an unlink wipes.
      this.scheduleRestart(uid);
    });

    try {
      await client.initialize();
    } catch (e) {
      console.error(`[agent] ${uid} failed to start`, e);
      await setState(uid, { status: "error", error: (e as Error).message });
      await this.stop(uid);
      this.scheduleRestart(uid);
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

  async stop(uid: string) {
    if (shouldFlagAbort({ starting: this.starting.has(uid) })) this.aborted.add(uid);
    const c = this.clients.get(uid);
    this.clients.delete(uid);
    this.ready.delete(uid);
    if (c) this.stopping.set(uid, c);
    try {
      await c?.destroy().catch(() => undefined);
    } finally {
      if (this.stopping.get(uid) === c) this.stopping.delete(uid);
    }
  }

  /** Hard stop for a client whose destroy() hung (same as sessions.kill). */
  kill(uid: string) {
    const c = this.clients.get(uid) ?? this.stopping.get(uid);
    if (!c) return;
    this.clients.delete(uid);
    this.ready.delete(uid);
    c.removeAllListeners();
    try {
      c.pupBrowser?.process()?.kill("SIGKILL");
    } catch (e) {
      console.warn(`[agent] ${uid} kill failed:`, (e as Error).message);
    }
  }

  /** Unlink the agent number: log it out of WhatsApp and delete its local and cloud login. The account's own WhatsApp is untouched. */
  async logout(uid: string) {
    const c = this.clients.get(uid);
    await c?.logout().catch(() => undefined);
    await this.stop(uid);
    await wipeLogin(agentVaultId(uid), SERVER_ID).catch((e) => console.error("[agent] wipeLogin failed; the local login was kept", e.message));
    await userRef(uid).set({ agentEnabled: false }, { merge: true });
    await setState(uid, { status: "idle", qr: null, phone: null, pushName: null, error: null });
  }

  async stopAll() {
    await Promise.all([...this.clients.keys()].map((uid) => this.stop(uid)));
  }
}

export const agentSessions = new AgentSessionManager();
