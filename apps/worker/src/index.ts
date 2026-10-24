// Spot Solutions worker: keeps every curator's WhatsApp session alive and executes
// commands the web app drops into Firestore. Only outbound connections — no ports.
import "./logbuf.ts";
import { col, db, sessionRef } from "./firebase.ts";
import { notice, runCommand } from "./commands.ts";
import { isAdminEmail, startAccess } from "./access.ts";
import { sessions } from "./sessions.ts";
import { hasServerGeminiKey, ollamaState, unwatchKeys, watchKeys, OLLAMA_URL } from "./llm.ts";
import { SERVER_ID, adminConfigured, watchServerCommands, writeServerStatus } from "./stats.ts";
import { startScheduler } from "./scheduler.ts";

const commandListeners = new Map<string, () => void>();
const HEARTBEAT_MS = 30_000;

// Every curator sees the worker as online, even before linking WhatsApp — otherwise there's no way to ask for a QR.
const beat = (uid: string) => sessionRef(uid).set({ lastSeen: Date.now() }, { merge: true }).catch(() => undefined);
setInterval(() => commandListeners.forEach((_, uid) => void beat(uid)), HEARTBEAT_MS).unref();

function watchCommands(uid: string) {
  if (commandListeners.has(uid)) return;
  const unsub = col(uid, "commands")
    .where("status", "==", "pending")
    .onSnapshot(
      (q) => q.docChanges().forEach((ch) => ch.type === "added" && void runCommand(uid, ch.doc)),
      (err) => console.error(`[commands] ${uid} listener error`, err),
    );
  commandListeners.set(uid, unsub);
  watchKeys(uid);
  void sessionRef(uid).get().then((s) => (s.exists ? beat(uid) : sessionRef(uid).set({ status: "idle", lastSeen: Date.now() })));
}

async function main() {
  const ol = await ollamaState();
  console.log(`[worker] starting · server "${SERVER_ID}" · ollama ${ol.up ? `up (${ol.models.map((m) => m.name).join(", ") || "no models"})` : "DOWN"}`);
  if (!adminConfigured) console.warn("[worker] SPOT_ADMIN_EMAILS not set: the Server page in the app stays hidden");

  // Heartbeat for the app's Server page.
  const users = new Map<string, { email?: string | null; name?: string | null }>();
  const pushStatus = async () => {
    const ollama = await ollamaState();
    const states = await Promise.all(
      [...commandListeners.keys()].map(async (uid) => {
        const s = (await sessionRef(uid).get()).data() ?? {};
        return { uid, email: users.get(uid)?.email ?? null, name: users.get(uid)?.name ?? null, status: String(s.status ?? "idle"), phone: s.phone ? `•••${String(s.phone).slice(-4)}` : null };
      }),
    );
    await writeServerStatus({ ollama: { ...ollama, url: OLLAMA_URL }, sessions: states, geminiServerKey: hasServerGeminiKey });
  };
  setInterval(() => void pushStatus().catch((e) => console.error("[stats]", e.message)), HEARTBEAT_MS).unref();
  setTimeout(() => void pushStatus().catch(() => undefined), 5_000);

  // Only approved curators get a command listener; those who've linked WhatsApp also get a session.
  const userDocs = new Map<string, FirebaseFirestore.DocumentData>();
  let allowed = new Set<string>();
  const reconcile = () => {
    for (const uid of allowed) {
      const data = userDocs.get(uid);
      if (!data) continue;
      watchCommands(uid);
      if (data.waEnabled && !sessions.running(uid)) void sessions.start(uid);
    }
    for (const uid of [...commandListeners.keys()]) {
      if (allowed.has(uid) && userDocs.has(uid)) continue;
      console.log(`[access] ${users.get(uid)?.email ?? uid} no longer allowed, stopping`);
      commandListeners.get(uid)?.();
      commandListeners.delete(uid);
      unwatchKeys(uid);
      void sessions.stop(uid);
      void sessionRef(uid).set({ lastSeen: 0 }, { merge: true }).catch(() => undefined);
    }
  };

  db.collection("users").onSnapshot((q) => {
    for (const ch of q.docChanges()) {
      const uid = ch.doc.id;
      users.set(uid, { email: ch.doc.data().email ?? null, name: ch.doc.data().name ?? null });
      if (ch.type === "removed") userDocs.delete(uid);
      else userDocs.set(uid, ch.doc.data());
    }
    reconcile();
  });

  await startAccess(
    (next) => {
      allowed = next;
      reconcile();
    },
    (e) => {
      console.log(`[access] ${e.email ?? e.uid} asked to join`);
      for (const [uid, u] of users) {
        if (isAdminEmail(u.email)) void notice(uid, "info", `${e.name ?? e.email ?? "Someone"} (${e.email ?? "no email"}) asked to use Spot Solutions. Approve them in Account → Server.`);
      }
    },
  );

  startScheduler(() => commandListeners.keys());
  if (adminConfigured) watchServerCommands(() => shutdown());

  const shutdown = async () => {
    console.log("[worker] shutting down");
    // Mark everyone offline right away instead of waiting for the heartbeat to go stale.
    await Promise.all([...commandListeners.keys()].map((uid) => sessionRef(uid).set({ lastSeen: 0 }, { merge: true }).catch(() => undefined)));
    await sessions.stopAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
