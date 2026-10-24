// Spot Solutions worker: keeps every curator's WhatsApp session alive and executes
// commands the web app drops into Firestore. Only outbound connections — no ports.
import { col, db, sessionRef } from "./firebase.ts";
import { runCommand } from "./commands.ts";
import { sessions } from "./sessions.ts";
import { ollamaHealthy } from "./gemma.ts";

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
  void sessionRef(uid).get().then((s) => (s.exists ? beat(uid) : sessionRef(uid).set({ status: "idle", lastSeen: Date.now() })));
}

async function main() {
  console.log(`[worker] starting · ollama ${(await ollamaHealthy()) ? "up" : "DOWN (Gemini fallback only)"}`);

  // Every user doc gets a command listener; users who've linked WhatsApp get a live session.
  db.collection("users").onSnapshot((q) => {
    for (const ch of q.docChanges()) {
      const uid = ch.doc.id;
      if (ch.type === "removed") {
        commandListeners.get(uid)?.();
        commandListeners.delete(uid);
        void sessions.stop(uid);
        continue;
      }
      watchCommands(uid);
      if (ch.doc.data().waEnabled && !sessions.running(uid)) void sessions.start(uid);
    }
  });

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
