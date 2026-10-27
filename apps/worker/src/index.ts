// Nothing BOT worker: keeps every curator's WhatsApp session alive and executes
// commands the web app drops into Firestore. Only outbound connections — no ports.
import "./envCompat.ts";
import "./logbuf.ts";
import { col, db, sessionRef } from "./firebase.ts";
import { runCommand } from "./commands.ts";
import { markAdhocTold } from "./replies.ts";
import { startAccess } from "./access.ts";
import { sessions } from "./sessions.ts";
import { checkBrowserAtStart } from "./browserHeal.ts";
import { agentSessions } from "./agentSession.ts";
import { onAgentMessage, onAgentVote } from "./agent.ts";
import { fleet } from "./fleet.ts";
import { DEFAULT_AI_POLICY, type AiPolicy } from "@spot/shared";
import { hasServerGeminiKey, ollamaState, unwatchKeys, watchKeys, OLLAMA_URL } from "./llm.ts";
import { SERVER_ID, adminConfigured, watchServerCommands, writeServerStatus } from "./stats.ts";
import { startScheduler } from "./scheduler.ts";
import { startRetention } from "./retention.ts";
import { readFileSync } from "node:fs";

const commandListeners = new Map<string, () => void>();
const HEARTBEAT_MS = 30_000;
let shuttingDown = false;

// Every curator sees the worker as online, even before linking WhatsApp — otherwise there's no way to ask for a QR.
const beat = (uid: string) => sessionRef(uid).set({ lastSeen: Date.now(), aliveAt: Date.now() }, { merge: true }).catch(() => undefined);
setInterval(() => commandListeners.forEach((_, uid) => fleet.shouldBeat(uid) && void beat(uid)), HEARTBEAT_MS).unref();

function watchCommands(uid: string) {
  if (commandListeners.has(uid)) return;
  const unsub = col(uid, "commands")
    .where("status", "==", "pending")
    .onSnapshot(
      (q) =>
        q.docChanges().forEach((ch) => {
          if (ch.type === "removed") return fleet.untrackCommand(uid, ch.doc.id); // left "pending": done, error or running
          if (ch.type !== "added") return;
          const d = ch.doc.data();
          fleet.trackCommand(uid, ch.doc.id, String(d.type));
          void runCommand(uid, ch.doc);
        }),
      (err) => console.error(`[commands] ${uid} listener error`, err),
    );
  commandListeners.set(uid, unsub);
  watchKeys(uid);
  void sessionRef(uid).get().then((s) => (s.exists ? undefined : sessionRef(uid).set({ status: "idle", lastSeen: Date.now() })));
}

async function main() {
  const ol = await ollamaState();
  console.log(`[worker] starting · server "${SERVER_ID}" · ollama ${ol.up ? `up (${ol.models.map((m) => m.name).join(", ") || "no models"})` : "DOWN"}`);
  fleet.setLocalModel(ol.up && ol.models.length > 0);
  if (!adminConfigured) console.warn("[worker] NBS_ADMIN_EMAILS not set: the Server page in the app stays hidden");

  // Heartbeat for the app's Server page.
  const users = new Map<string, { email?: string | null; name?: string | null }>();
  const pushStatus = async () => {
    const ollama = await ollamaState();
    fleet.setLocalModel(ollama.up && ollama.models.length > 0);
    const states = await Promise.all(
      fleet.heldUids().map(async (uid) => {
        const s = (await sessionRef(uid).get()).data() ?? {};
        return { uid, email: users.get(uid)?.email ?? null, name: users.get(uid)?.name ?? null, status: String(s.status ?? "idle"), phone: s.phone ? `•••${String(s.phone).slice(-4)}` : null };
      }),
    );
    await writeServerStatus({ ollama: { ...ollama, url: OLLAMA_URL }, sessions: states, geminiServerKey: hasServerGeminiKey });
  };
  setInterval(() => void pushStatus().catch((e) => console.error("[stats]", e.message)), HEARTBEAT_MS).unref();
  await pushStatus().catch((e) => console.error("[stats]", e.message)); // peers need our capacity before ranking us

  checkBrowserAtStart(); // missing Chrome is installed in the background before the first session needs it

  // Only approved curators get a command listener; those who've linked WhatsApp also get a session.
  const userDocs = new Map<string, FirebaseFirestore.DocumentData>();
  let allowed = new Set<string>();
  // Commands that were left pending because another server held the account (or nobody did) run once we do.
  const rescanCommands = (uid: string) =>
    void col(uid, "commands").where("status", "==", "pending").get().then((q) => q.docs.forEach((d) => void runCommand(uid, d))).catch(() => undefined);
  const reconcile = () => {
    const known = new Map<string, { policy: AiPolicy; enabled: boolean; agent?: boolean }>();
    for (const uid of allowed) {
      const data = userDocs.get(uid);
      if (!data) continue;
      watchCommands(uid);
      const policy: AiPolicy = data.settings?.ai?.policy === "local_only" ? "local_only" : DEFAULT_AI_POLICY;
      known.set(uid, { policy, enabled: Boolean(data.waEnabled), agent: Boolean(data.waEnabled && data.agentEnabled) });
      if (data.waEnabled && fleet.holds(uid) && !sessions.running(uid)) void sessions.start(uid);
      // The agent number rides on the same lease: it starts here too, once the account's own WhatsApp is on its way.
      if (data.waEnabled && data.agentEnabled && fleet.holds(uid) && !agentSessions.running(uid)) startAgentSoon(uid);
    }
    fleet.sync(known);
    for (const uid of [...commandListeners.keys()]) {
      if (allowed.has(uid) && userDocs.has(uid)) continue;
      console.log(`[access] ${users.get(uid)?.email ?? uid} no longer allowed, stopping`);
      commandListeners.get(uid)?.();
      commandListeners.delete(uid);
      unwatchKeys(uid);
      if (fleet.holds(uid)) void sessionRef(uid).set({ lastSeen: 0 }, { merge: true }).catch(() => undefined);
    }
  };
  // A second Chromium at the same moment as the first doubles the start-up load: give the account's own WhatsApp a head start.
  const agentDue = new Set<string>();
  const startAgentSoon = (uid: string, delayMs = 20_000) => {
    if (agentDue.has(uid)) return;
    agentDue.add(uid);
    setTimeout(() => {
      agentDue.delete(uid);
      const d = userDocs.get(uid);
      if (d?.waEnabled && d.agentEnabled && fleet.holds(uid)) void agentSessions.start(uid);
    }, delayMs).unref();
  };
  agentSessions.hooks.onMessage = onAgentMessage;
  agentSessions.hooks.onVote = onAgentVote;
  fleet.start({
    retryPending: rescanCommands,
    onAcquire: (uid) => {
      // Once the account's data has loaded: record ad hoc comics who were told but have no "sent" entry (idempotent).
      setTimeout(() => void markAdhocTold(uid).catch((e) => console.error("[adhoc] told backfill failed", e.message)), 20_000).unref();
      if (userDocs.get(uid)?.waEnabled) void sessions.start(uid); // pending commands are replayed once it is ready
      else rescanCommands(uid);
      if (userDocs.get(uid)?.waEnabled && userDocs.get(uid)?.agentEnabled) startAgentSoon(uid);
    },
  });
  sessions.hooks.onReady = ((prev) => (uid, source) => {
    prev?.(uid, source);
    setTimeout(() => rescanCommands(uid), 2_000).unref();
  })(sessions.hooks.onReady);

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
      // The admins are told by the onAccessRequested Cloud Function (functions/src/accessAlerts.ts): an Updates notice, a push and their agent number.
      console.log(`[access] ${e.email ?? e.uid} asked to join`);
    },
  );

  startScheduler(() => commandListeners.keys());
  startRetention();
  // Exit non-zero on a requested restart so every supervisor (systemd, launchd, the Windows loop) brings us back.
  if (adminConfigured) watchServerCommands(() => shutdown(75));

  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("[worker] shutting down");
    setTimeout(() => process.exit(code), 60_000).unref(); // don't hang a restart on a slow upload
    // Upload and release every account first so a peer takes over at once, then mark them offline.
    const mine = fleet.heldUids();
    await fleet.drain();
    await Promise.all(mine.map((uid) => sessionRef(uid).set({ lastSeen: 0 }, { merge: true }).catch(() => undefined)));
    await Promise.all([sessions.stopAll(), agentSessions.stopAll()]);
    process.exit(code);
  };
  // SIGHUP too (terminal closed, ssh dropped): puppeteer's own handlers are off, so this drain is the only thing that closes Chromium cleanly.
  // A signal is a stop only when the owner pressed Stop server (NBS_WORKER_STOPPED in .env). Any other signal (an update, a restart,
  // a supervisor reload) exits 75 so launchd's KeepAlive {SuccessfulExit: false} and the other supervisors start us again;
  // exiting 0 there left the worker down after an update.
  const ownerStopped = () => {
    try { return /^NBS_WORKER_STOPPED=(1|true|yes)\s*$/im.test(readFileSync(process.env.NBS_ENV_FILE ?? ".env", "utf8")); } catch { return false; }
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => void shutdown(ownerStopped() ? 0 : 75));
  // Node prints MaxListenersExceededWarning without saying who added the listeners; log the stack once per kind so the
  // source shows up in worker.log instead of a bare "possible memory leak" line.
  const warned = new Set<string>();
  process.on("warning", (w) => {
    if (w.name !== "MaxListenersExceededWarning" || warned.has(w.message)) return;
    warned.add(w.message);
    console.warn(`[warning] ${w.message}\n${w.stack ?? ""}`);
  });
  // Windows has no SIGTERM for a console-less process, so "Stop server" in the console sets NBS_WORKER_STOPPED=1 in .env and the
  // worker closes itself properly (logins uploaded, leases released) when it sees it. Elsewhere the supervisor sends SIGTERM.
  if (process.platform === "win32") {
    setInterval(() => {
      try { if (/^NBS_WORKER_STOPPED=(1|true|yes)\s*$/im.test(readFileSync(process.env.NBS_ENV_FILE ?? ".env", "utf8"))) void shutdown(0); } catch { /* no .env: nothing to stop for */ }
    }, 3000).unref();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
