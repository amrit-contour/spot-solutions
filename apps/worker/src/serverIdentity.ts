// This machine's identity: where its data lives, when it was first installed, and its fleet id.
// The id is persisted in server.json so a hostname change or a clone of the OS image can't merge two servers.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "./firebase.ts";
import { isClonedDisk, pickServerId } from "./fleetPlan.ts";

export const DATA_DIR = process.env.WWEBJS_DATA ?? path.resolve(".wwebjs_auth");
const FILE = path.join(DATA_DIR, "server.json");

const sanitise = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "-");

type Stored = { installedAt?: number; id?: string; fingerprint?: string; fingerprintSource?: "machine" | "fallback" };
function readFile(): Stored {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return {}; // first run
  }
}
function save(v: Stored & { installedAt: number }) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(v));
  } catch (e) {
    console.warn("[fleet] couldn't persist server.json:", (e as Error).message);
  }
}

const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });

/**
 * A stable id of this machine (not of the disk image): hashed, so the raw machine id is never stored. `source` says
 * where it came from: "fallback" (hostname + MAC) is not stable across container recreates, so it never proves a clone.
 */
function machineFingerprint(): { value: string; source: "machine" | "fallback" } | null {
  let raw = "";
  let source: "machine" | "fallback" = "machine";
  try {
    if (process.platform === "linux") raw = readFileSync("/etc/machine-id", "utf8").trim();
    else if (process.platform === "darwin") raw = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]))?.[1] ?? "";
    else if (process.platform === "win32") raw = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]))?.[1] ?? "";
  } catch {
    /* fall through to the generic fingerprint */
  }
  if (!raw) {
    const mac = Object.values(os.networkInterfaces())
      .flat()
      .find((n) => n && !n.internal && n.mac && n.mac !== "00:00:00:00:00:00")?.mac;
    if (!mac) return null;
    raw = `${os.hostname()}|${mac}`;
    source = "fallback";
  }
  return { value: createHash("sha256").update(`${process.platform}:${raw}`).digest("hex").slice(0, 32), source };
}

const FP = machineFingerprint();
const FINGERPRINT = FP?.value ?? null;
const fpFields = FP ? { fingerprint: FP.value, fingerprintSource: FP.source } : {};
const stored = readFile();
// server.json copied from another machine (disk clone): start over with a new id and a fresh install time.
const cloned = isClonedDisk(stored.fingerprint, FINGERPRINT, { stored: stored.fingerprintSource, current: FP?.source });
if (cloned) console.warn("[fleet] server.json came from another machine (cloned disk?); generating a new server id");
const file = cloned ? {} : stored;
export const INSTALLED_AT = typeof file.installedAt === "number" ? file.installedAt : Date.now();
if (cloned || typeof file.installedAt !== "number" || (FP && (file.fingerprint !== FP.value || file.fingerprintSource !== FP.source))) {
  save({ installedAt: INSTALLED_AT, ...(file.id ? { id: file.id } : {}), ...fpFields });
}

async function resolveId() {
  const hostnameId = sanitise(os.hostname());
  const env = process.env.SPOT_SERVER_ID ? sanitise(process.env.SPOT_SERVER_ID) : undefined;
  const persisted = typeof file.id === "string" && file.id ? file.id : null;
  let hostDocInstalledAt: number | null = null;
  if (!env && !persisted) {
    try {
      hostDocInstalledAt = ((await db.collection("servers").doc(hostnameId).get()).data()?.fleet?.installedAt as number | undefined) ?? null;
    } catch (e) {
      // Can't tell whether this is a returning server: keep the hostname for now and decide again next start.
      console.warn("[fleet] couldn't check for an existing server record, using the hostname id:", (e as Error).message);
      return hostnameId;
    }
  }
  const { id, persist } = pickServerId({ env, persisted, hostnameId, hostDocInstalledAt, installedAt: INSTALLED_AT, random: randomBytes(4).toString("hex").slice(0, 6) });
  if (persist) save({ installedAt: INSTALLED_AT, id, ...fpFields });
  return id;
}

export const SERVER_ID: string = await resolveId();
