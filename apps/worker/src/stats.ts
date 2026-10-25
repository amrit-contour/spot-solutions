// Server heartbeat: machine health, Ollama, and who is connected, written to servers/{id}
// for the app's Server page. Only admins listed in SPOT_ADMIN_EMAILS can read it.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import type { FleetCapacity, FleetServerSummary, ServerStatus } from "@spot/shared";
import { db } from "./firebase.ts";
import { SERVER_ID } from "./serverIdentity.ts";
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

export async function writeServerStatus(extra: Pick<ServerStatus, "ollama" | "sessions" | "geminiServerKey">) {
  const cpus = os.cpus();
  const status: ServerStatus = {
    id: SERVER_ID,
    hostname: os.hostname(),
    platform: process.platform,
    osRelease: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    version: VERSION,
    startedAt,
    lastSeen: Date.now(),
    cpu: { model: cpus[0]?.model?.trim() ?? "unknown", cores: cpus.length, load1: os.loadavg()[0], usage: cpuUsage() },
    memory: { total: os.totalmem(), free: os.freemem(), process: process.memoryUsage().rss },
    disk: await disk(),
    counters: { ...counters },
    admins: ADMINS,
    logs: recentLogs.slice(-120),
    ...extra,
    ...(fleetCapacity ? { fleet: fleetCapacity() } : {}),
  };
  // merge: fleet.ts also updates servers/{id}.fleet between heartbeats; never wipe it.
  await db.collection("servers").doc(SERVER_ID).set(status, { merge: true });
  if (status.fleet) {
    const summary: FleetServerSummary = { id: SERVER_ID, hostname: status.hostname, platform: status.platform, lastSeen: status.lastSeen, ...status.fleet };
    await db.collection("fleetServers").doc(SERVER_ID).set(summary, { merge: true });
  }
}

export const adminConfigured = ADMINS.length > 0;

/** Admin actions sent from the app. Runs only for this server. */
export function watchServerCommands(onRestartWorker: () => Promise<void>) {
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
