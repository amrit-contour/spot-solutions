// One whatsapp-web.js client per signed-in curator. Sessions persist on disk (LocalAuth),
// so a reboot reconnects without a new QR scan.
import { rm } from "node:fs/promises";
import path from "node:path";
import WAWebJS from "whatsapp-web.js";
import type { SessionState } from "@spot/shared";
import { FieldValue, sessionRef, userRef } from "./firebase.ts";
import { enqueue, markLive } from "./intake.ts";
import { handleSelfReply, handleVote } from "./replies.ts";
import { unwatchUser, watchUser } from "./userData.ts";

const { Client, LocalAuth } = WAWebJS;
const DATA_DIR = process.env.WWEBJS_DATA ?? path.resolve(".wwebjs_auth");

const setState = (uid: string, s: Partial<SessionState>) =>
  sessionRef(uid).set({ ...s, lastSeen: Date.now() }, { merge: true });

class SessionManager {
  private clients = new Map<string, WAWebJS.Client>();
  private ready = new Set<string>();
  private restarting = new Set<string>();

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

    client.on("qr", (qr) => void setState(uid, { status: "qr", qr }));
    client.on("authenticated", () => void setState(uid, { status: "authenticated", qr: null }));
    client.on("auth_failure", (m) => void setState(uid, { status: "error", error: `Auth failed: ${m}` }));
    client.on("ready", async () => {
      this.ready.add(uid);
      const me = client.info;
      await setState(uid, { status: "ready", qr: null, phone: me?.wid?.user ?? null, pushName: me?.pushname ?? null, error: null });
      await userRef(uid).set({ waEnabled: true, selfId: me?.wid?._serialized ?? null }, { merge: true });
      console.log(`[session] ${uid} ready as +${me?.wid?.user}`);
      markLive(uid); // backlog is ignored: only messages from now on are read
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

  async stop(uid: string) {
    const c = this.clients.get(uid);
    this.clients.delete(uid);
    this.ready.delete(uid);
    unwatchUser(uid);
    await c?.destroy().catch(() => undefined);
  }

  async logout(uid: string) {
    const c = this.clients.get(uid);
    await c?.logout().catch(() => undefined);
    await this.stop(uid);
    await this.wipe(uid);
    await userRef(uid).set({ waEnabled: false }, { merge: true });
    await sessionRef(uid).set({ status: "idle", qr: null, phone: null, pushName: null, error: null, lastSeen: Date.now() });
  }

  private wipe(uid: string) {
    return rm(path.join(DATA_DIR, `session-${uid}`), { recursive: true, force: true });
  }

  async stopAll() {
    await Promise.all([...this.clients.keys()].map((uid) => this.stop(uid)));
  }
}

export const sessions = new SessionManager();
export { FieldValue };
