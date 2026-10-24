// Server heartbeat: machine health, Ollama, and who is connected, written to servers/{id}
// for the app's Server page. Only admins listed in SPOT_ADMIN_EMAILS can read it.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import type { ServerStatus } from "@spot/shared";
import { db } from "./firebase.ts";

const exec = promisify(execFile);

export const counters = { messagesIn: 0, classified: 0, sent: 0, errors: 0 };

export const SERVER_ID = (process.env.SPOT_SERVER_ID || os.hostname()).toLowerCase().replace(/[^a-z0-9-]/g, "-");
const ADMINS = (process.env.SPOT_ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
const startedAt = Date.now();

function version() {
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
    ...extra,
  };
  await db.collection("servers").doc(SERVER_ID).set(status);
}

export const adminConfigured = ADMINS.length > 0;
