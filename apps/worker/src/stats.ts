// Server heartbeat: machine health, Ollama, and who is connected, written to servers/{id}
// for the app's Server page. Only admins listed in SPOT_ADMIN_EMAILS can read it.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DocumentReference } from "firebase-admin/firestore";
import { LOGS_WANTED_FRESH_MS, type FleetCapacity, type FleetServerSummary, type ServerStatus } from "@spot/shared";
import { SERVICE_ACCOUNT, db, FieldValue } from "./firebase.ts";
import { DATA_DIR, SERVER_ID } from "./serverIdentity.ts";
import { recentLogs } from "./logbuf.ts";
import { ADMIN_DATA_COMMANDS, runAdminDataCommand } from "./adminData.ts";

const exec = promisify(execFile);

export const counters = { messagesIn: 0, classified: 0, sent: 0, errors: 0 };

export { SERVER_ID };
const ADMINS = (process.env.SPOT_ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
const startedAt = Date.now();

let fleetCapacity: (() => FleetCapacity) | null = null;
/** fleet.ts registers itself here so every heartbeat carries the capacity fields. */
export const setFleetProvider = (fn: () => FleetCapacity) => void (fleetCapacity = fn);

function version() {
  try {
    return readFileSync(new URL("../../../VERSION", import.meta.url), "utf8").trim();
  } catch {
    /* not a tarball install */
  }
  try {
    return readFileSync(new URL("../../../.git/HEAD", import.meta.url), "utf8").trim().replace(/^ref: refs\/heads\//, "");
  } catch {
    return process.env.npm_package_version ?? "dev";
  }
}
const VERSION = version();

let lastCpu = os.cpus().map((c) => c.times);
function cpuUsage() {
  const now = os.cpus().map((c) => c.times);
  let idle = 0;
  let total = 0;
  now.forEach((t, i) => {
    const p = lastCpu[i] ?? t;
    const d = (k: keyof typeof t) => t[k] - p[k];
    idle += d("idle");
    total += d("user") + d("nice") + d("sys") + d("idle") + d("irq");
  });
  lastCpu = now;
  return total ? Math.max(0, Math.min(1, 1 - idle / total)) : 0;
}

async function disk() {
  try {
    if (process.platform === "win32") {
      const { stdout } = await exec("powershell", ["-NoProfile", "-Command", "(Get-PSDrive C) | % { \"$($_.Used) $($_.Free)\" }"]);
      const [used, free] = stdout.trim().split(" ").map(Number);
      return { total: used + free, free };
    }
    const { stdout } = await exec("df", ["-k", "/"]);
    const cols = stdout.trim().split("\n").pop()!.split(/\s+/);
    return { total: Number(cols[1]) * 1024, free: Number(cols[3]) * 1024 };
  } catch {
    return null;
  }
}

// Logs go into the heartbeat only while an admin has the log section open (servers/{id}.logsWanted, ms, refreshed
// every minute by the app). Otherwise they are left out, and cleared once so old lines don't linger.
let logsWantedAt = 0;
let logsWatching = false;
let logsInDoc: "unknown" | "present" | "cleared" = "unknown";
let lastLogs = "";
const logsWanted = () => Date.now() - logsWantedAt < LOGS_WANTED_FRESH_MS;

function watchLogsWanted() {
  if (logsWatching) return;
  logsWatching = true;
  const ref = db.collection("servers").doc(SERVER_ID);
  ref.onSnapshot(
    (snap) => {
      const was = logsWanted();
      const at = snap.data()?.logsWanted;
      logsWantedAt = typeof at === "number" ? at : 0;
      // Someone just opened the log: don't make them wait for the next heartbeat.
      if (!was && logsWanted()) void sendLogs(ref).catch(() => undefined);
    },
    (e) => console.error("[server] logsWanted listener", e.message),
  );
}

async function sendLogs(ref: DocumentReference) {
  const logs = recentLogs.slice(-120);
  lastLogs = logs.join("\n");
  logsInDoc = "present";
  await ref.set({ logs }, { merge: true });
}

/** Memory that's actually available: os.freemem() counts file cache as used on macOS and Linux (reads ~100%). */
async function availableMemory() {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await exec("vm_stat");
      const page = Number(/page size of (\d+)/.exec(stdout)?.[1] ?? 4096);
      const pages = (name: string) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(stdout)?.[1] ?? 0);
      return Math.min(os.totalmem(), (pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * page);
    }
    if (process.platform === "linux") {
      const kb = Number(/MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1] ?? NaN);
      if (Number.isFinite(kb)) return kb * 1024;
    }
  } catch {}
  return os.freemem();
}

/**
 * Where this server's console answers on the local network, plus its access code (from the console's token
 * file next to the WhatsApp data). servers/{id} is readable only by this server's admins.
 */
function consoleInfo(): ServerStatus["console"] {
  const port = Number(process.env.SPOT_CONSOLE_PORT ?? 7420);
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === "IPv4" && !n.internal && !n.address.startsWith("169.254."))
    .map((n) => n!.address);
  const host = `${os.hostname().replace(/\.local$/i, "").toLowerCase()}.local`;
  let token: string | null = null;
  try {
    token = readFileSync(process.env.SPOT_CONSOLE_TOKEN_FILE ?? path.join(path.dirname(DATA_DIR), "console-token"), "utf8").trim() || null;
  } catch {}
  return { port, ips, host, token };
}

export async function writeServerStatus(extra: Pick<ServerStatus, "ollama" | "sessions" | "geminiServerKey">) {
  const cpus = os.cpus();
  const status: ServerStatus = {
    id: SERVER_ID,
    hostname: os.hostname(),
    serviceAccount: SERVICE_ACCOUNT,
    platform: process.platform,
    osRelease: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    version: VERSION,
    startedAt,
    lastSeen: Date.now(),
    cpu: { model: cpus[0]?.model?.trim() ?? "unknown", cores: cpus.length, load1: os.loadavg()[0], usage: cpuUsage() },
    memory: { total: os.totalmem(), free: await availableMemory(), process: process.memoryUsage().rss },
    console: consoleInfo(),
    disk: await disk(),
    counters: { ...counters },
    admins: ADMINS,
    ...extra,
    ...(fleetCapacity ? { fleet: fleetCapacity() } : {}),
  };
  watchLogsWanted();
  const logs = recentLogs.slice(-120);
  const logsPart: Record<string, unknown> = {};
  if (logsWanted()) {
    // Only when the lines changed since the last write.
    if (logs.join("\n") !== lastLogs || logsInDoc !== "present") {
      logsPart.logs = logs;
      lastLogs = logs.join("\n");
      logsInDoc = "present";
    }
  } else if (logsInDoc !== "cleared") {
    logsPart.logs = FieldValue.delete();
    logsInDoc = "cleared";
    lastLogs = "";
  }
  // merge: fleet.ts also updates servers/{id}.fleet between heartbeats, and the app owns logsWanted; never wipe them.
  await db.collection("servers").doc(SERVER_ID).set({ ...status, ...logsPart }, { merge: true });
  if (status.fleet) {
    const summary: FleetServerSummary = { id: SERVER_ID, hostname: status.hostname, platform: status.platform, lastSeen: status.lastSeen, ...status.fleet };
    await db.collection("fleetServers").doc(SERVER_ID).set(summary, { merge: true });
  }
}

export const adminConfigured = ADMINS.length > 0;

/** Admin actions sent from the app. Runs only for this server. */
export function watchServerCommands(onRestartWorker: () => Promise<void>) {
  void settleUpdate().catch(() => undefined);
  db.collection("servers")
    .doc(SERVER_ID)
    .collection("commands")
    .where("status", "==", "pending")
    .onSnapshot((q) => {
      for (const ch of q.docChanges()) {
        if (ch.type !== "added") continue;
        const ref = ch.doc.ref;
        const type = ch.doc.data().type as string;
        void (async () => {
          try {
            await ref.update({ status: "running" });
            console.log(`[server] ${type} requested by ${ch.doc.data().by}`);
            if (type === "restart_ollama") {
              await restartOllama();
              await ref.update({ status: "done" });
            } else if (type === "update_server") {
              await requestUpdate(String(ch.doc.data().by ?? "the app"));
              await ref.update({ status: "done" });
            } else if (type === "restart_worker") {
              await ref.update({ status: "done" });
              await onRestartWorker(); // systemd / the Windows launcher brings us back up
            } else if (ADMIN_DATA_COMMANDS.has(type)) {
              await ref.update({ status: "done", result: await runAdminDataCommand(type, ch.doc.data()) });
            } else throw new Error(`Unknown ${type}`);
          } catch (e) {
            await ref.update({ status: "error", error: (e as Error).message }).catch(() => undefined);
          }
        })();
      }
    }, (e) => console.error("[server] command listener", e.message));
}

async function restartOllama() {
  if (process.platform === "win32") {
    const exe = process.env.SPOT_OLLAMA_EXE ?? "ollama";
    await exec("powershell", ["-NoProfile", "-Command", `Get-Process ollama -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 2; Start-Process -FilePath '${exe}' -ArgumentList serve -WindowStyle Hidden`]);
  } else if (process.platform === "darwin") {
    await exec("launchctl", ["kickstart", "-k", `gui/${process.getuid!()}/com.spotsolutions.ollama`], { timeout: 60_000 });
  } else {
    await exec("sudo", ["-n", "/usr/bin/systemctl", "restart", "ollama"], { timeout: 60_000 });
  }
}

// ---- updates (apps/worker/console/update.mjs does the work; this is the app's way to ask for it) ----

const serverRef = () => db.collection("servers").doc(SERVER_ID);

/** Ask this machine's console to run its updater, and say so on the server's doc so the app can show "Updating". */
async function requestUpdate(by: string) {
  const port = Number(process.env.SPOT_CONSOLE_PORT ?? 7420);
  let res: Response;
  try {
    // The console trusts requests from this machine; admins already proved themselves to Firestore to get here.
    res = await fetch(`http://127.0.0.1:${port}/api/update`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ by }), signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error("This server's console isn't answering. Update it once by running the installer again.");
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; to?: string | null; already?: boolean };
  if (res.status === 404) throw new Error("This server's console is too old to update from here. Run the installer again once.");
  if (!res.ok) throw new Error(body.error ?? `Console said ${res.status}`);
  await serverRef().set({ update: { state: "updating", target: body.to ?? null, from: VERSION, startedAt: Date.now() } }, { merge: true });
}

/** After a restart: an update that changed our version is done, one that never changed it for 30 minutes failed. */
async function settleUpdate() {
  const ref = serverRef();
  const u = (await ref.get()).data()?.update as ServerStatus["update"];
  if (!u) return;
  if (u.from !== VERSION) await ref.update({ update: FieldValue.delete() });
  else if (u.state === "updating" && Date.now() - u.startedAt > 30 * 60_000) await ref.update({ update: { ...u, state: "error", error: "The update didn't finish. Check the server's console." } });
}
