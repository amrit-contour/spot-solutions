// One whatsapp-web.js client per signed-in curator. Sessions persist on disk (LocalAuth),
// so a reboot reconnects without a new QR scan.
import { cp, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import WAWebJS from "whatsapp-web.js";
import type { SessionState } from "@spot/shared";
import { FieldValue, col, sessionRef, userRef } from "./firebase.ts";
import { catchUpSince, enqueue, markLive } from "./intake.ts";
import { handleSelfReply, handleVote } from "./replies.ts";
import { unwatchUser, watchUser } from "./userData.ts";

const { Client, LocalAuth } = WAWebJS;
const DATA_DIR = process.env.WWEBJS_DATA ?? path.resolve(".wwebjs_auth");

const BACKUP_EVERY_MS = 6 * 3600_000;
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

const notice = (uid: string, level: "info" | "warn", text: string) => col(uid, "notices").add({ level, text, createdAt: Date.now(), read: false }).catch(() => undefined);

// lastSeen drives the app's online dot (zeroed on shutdown); aliveAt is when we last processed messages (never zeroed).
const setState = (uid: string, s: Partial<SessionState>) =>
  sessionRef(uid).set({ ...s, lastSeen: Date.now(), aliveAt: Date.now() }, { merge: true });

class SessionManager {
  private clients = new Map<string, WAWebJS.Client>();
  private ready = new Set<string>();
  private restarting = new Set<string>();
  private restoredOnce = new Set<string>();
  private backupTimers = new Map<string, NodeJS.Timeout>();

  get(uid: string) {
    return this.ready.has(uid) ? this.clients.get(uid) : undefined;
  }

  require(uid: string) {
    const c = this.get(uid);
    if (!c) throw new Error("WhatsApp isn't connected yet");
    return c;
  }

  running(uid: string) {
    return this.clients.has(uid);
  }

  private starting = new Set<string>();

  async start(uid: string) {
    // Claim synchronously: the connect command and the users listener can both call this in the same tick.
    if (this.clients.has(uid) || this.starting.has(uid)) return;
    this.starting.add(uid);
    try {
      await this.launch(uid);
    } finally {
      this.starting.delete(uid);
    }
  }

  private async launch(uid: string) {
    watchUser(uid);
    // A crashed worker can leave Chromium's profile lock behind; clear it so the session reopens.
    const profile = path.join(DATA_DIR, `session-${uid}`);
    await Promise.all(["SingletonLock", "SingletonCookie", "SingletonSocket"].map((f) => rm(path.join(profile, f), { force: true })));
    // Was this account linked before the server went down? Then a QR now means the saved login broke.
    const prev = (await sessionRef(uid).get()).data() as SessionState | undefined;
    const wasLinked = Boolean(prev?.phone);
    const offlineSince = prev?.aliveAt ?? prev?.lastSeen ?? Date.now();
    let sawQr = false;
    await setState(uid, { status: "starting", qr: null, error: null });

    const client = new Client({
      authStrategy: new LocalAuth({ clientId: uid, dataPath: DATA_DIR }),
      puppeteer: {
        headless: true,
        executablePath: process.env.CHROME_PATH || undefined,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote"],
      },
    });
    this.clients.set(uid, client);

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
        void notice(uid, "warn", "WhatsApp asked to be linked again (it can happen after a power cut, or if the phone was offline for weeks). Open Settings → Show QR code and scan it.");
      }
      sawQr = true;
      void setState(uid, { status: "qr", qr });
    });
    client.on("authenticated", () => void setState(uid, { status: "authenticated", qr: null }));
    client.on("auth_failure", (m) => void setState(uid, { status: "error", error: `Auth failed: ${m}` }));
    client.on("ready", async () => {
      this.ready.add(uid);
      const me = client.info;
      await setState(uid, { status: "ready", qr: null, phone: me?.wid?.user ?? null, pushName: me?.pushname ?? null, error: null });
      await userRef(uid).set({ waEnabled: true, selfId: me?.wid?._serialized ?? null }, { merge: true });
      console.log(`[session] ${uid} ready as +${me?.wid?.user}`);
      markLive(uid);
      this.restoredOnce.delete(uid);
      // Fresh link: old chats are never read. Restored link: read what arrived while we were down (no auto-replies).
      if (!sawQr && wasLinked) {
        catchUpSince(uid, client, offlineSince).then((n) => { if (n) void notice(uid, "info", `Server was offline for a while. Caught up on ${n} message${n === 1 ? "" : "s"} that came in meanwhile; nothing was sent automatically.`); }).catch((e) => console.error("[session] catch-up failed", e));
      }
      // Keep a recent copy of the login so a crash can't cost a re-scan.
      setTimeout(() => void backupSession(uid).catch(() => undefined), 90_000).unref();
      clearInterval(this.backupTimers.get(uid));
      this.backupTimers.set(uid, setInterval(() => void backupSession(uid).catch(() => undefined), BACKUP_EVERY_MS).unref());
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
      console.warn(`[session] ${uid} disconnected: ${reason}`);
      this.ready.delete(uid);
      await setState(uid, { status: "disconnected", error: String(reason) });
      await this.stop(uid);
      if (reason === "LOGOUT") {
        await this.wipe(uid);
        await userRef(uid).set({ waEnabled: false }, { merge: true });
      } else {
        this.scheduleRestart(uid);
      }
    });

    try {
      await client.initialize();
    } catch (e) {
      console.error(`[session] ${uid} failed to start`, e);
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

  async stop(uid: string, opts: { backup?: boolean } = {}) {
    const c = this.clients.get(uid);
    const wasReady = this.ready.has(uid);
    this.clients.delete(uid);
    this.ready.delete(uid);
    clearInterval(this.backupTimers.get(uid));
    this.backupTimers.delete(uid);
    unwatchUser(uid);
    await c?.destroy().catch(() => undefined);
    // Chromium is closed now, so this is the cleanest possible copy.
    if (opts.backup && wasReady) await backupSession(uid).catch((e) => console.error("[session] backup failed", e.message));
  }

  async logout(uid: string) {
    const c = this.clients.get(uid);
    await c?.logout().catch(() => undefined);
    await this.stop(uid);
    await this.wipe(uid);
    await userRef(uid).set({ waEnabled: false }, { merge: true });
    await sessionRef(uid).set({ status: "idle", qr: null, phone: null, pushName: null, error: null, lastSeen: Date.now() });
  }

  private async wipe(uid: string) {
    await rm(profileDir(uid), { recursive: true, force: true });
    await rm(backupDir(uid), { recursive: true, force: true });
  }

  async stopAll() {
    await Promise.all([...this.clients.keys()].map((uid) => this.stop(uid, { backup: true })));
  }
}

export const sessions = new SessionManager();
export { FieldValue };
