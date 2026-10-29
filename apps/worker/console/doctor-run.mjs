// Runs the server doctor (doctor.mjs) against this machine. Used three ways:
//   node doctor-run.mjs [--repair] [--quick] [--json] [--only id,id]   from nbsctl / install.ps1 / update-core.ps1
//   createMachineDoctor({...})                                           from the console (server.mjs) and the worker's startup
// Exit code: 0 when nothing critical is broken (installers continue), 1 when a critical check (Node, packages, browser, data folder) still fails.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, cpSync, accessSync, constants, statfsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctor, summarize, hasCriticalFailure } from "./doctor.mjs";
import { contextFor } from "./move.mjs";
import { resolveModelsDir, ollamaEnv } from "./ollamaenv.mjs";

const exec = promisify(execFile);
const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";
const here = path.dirname(fileURLToPath(import.meta.url));

export function machinePaths(env = process.env) {
  const appDir = path.resolve(here, "..", "..", "..");
  const macRoot = path.join(os.homedir(), "Library", "Application Support", "NothingBotServer");
  const dataDir = env.NBS_DATA_DIR ?? (WIN ? "C:\\NothingBotServer\\data" : MAC ? path.join(macRoot, "data") : "/var/lib/nothing-bot-server");
  const envFile = env.NBS_ENV_FILE ?? path.join(appDir, "apps", "worker", ".env");
  return {
    appDir, dataDir, envFile,
    legacyDataDirs: WIN ? ["C:\\SpotSolutions\\data"] : MAC ? [path.join(os.homedir(), "Library", "Application Support", "SpotSolutions", "data")] : ["/var/lib/spot-solutions"],
    legacyChromeDirs: WIN ? ["C:\\SpotSolutions\\chrome"] : MAC ? [path.join(os.homedir(), "Library", "Application Support", "SpotSolutions", "chrome")] : ["/var/lib/spot-solutions/.cache/puppeteer"],
  };
}

export function parseEnv(raw) {
  return Object.fromEntries(String(raw).split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
}

/** Memory that's actually available. os.freemem() counts file cache as used on macOS and Linux, so it reads ~100%. */
export async function readMemory() {
  const total = os.totalmem();
  try {
    if (MAC) {
      const { stdout } = await exec("vm_stat");
      const page = Number(/page size of (\d+)/.exec(stdout)?.[1] ?? 4096);
      const pages = (name) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(stdout)?.[1] ?? 0);
      return { total, free: Math.min(total, (pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * page) };
    }
    if (!WIN) {
      const kb = Number(/MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1] ?? NaN);
      if (Number.isFinite(kb)) return { total, free: kb * 1024 };
    }
  } catch {}
  return { total, free: os.freemem() };
}

/** The real machine behind doctor.mjs's `d`. Anything platform-specific that can't be done from Node is optional and reported as such. */
/** The first set, non-cloud Ollama URL of these, else http://127.0.0.1:11434. */
export function localOllamaUrl(...candidates) {
  for (const c of candidates) {
    const u = String(c ?? "").trim().replace(/\/+$/, "");
    if (u && !/^https?:\/\/([^/]+\.)?ollama\.com(\/|:|$)/i.test(u)) return u;
  }
  return "http://127.0.0.1:11434";
}

export function createMachine({ env = process.env, paths = machinePaths(env), log = () => {} } = {}) {
  const readText = (f) => { try { return readFileSync(f, "utf8"); } catch { return null; } };
  const ensureScript = path.join(paths.appDir, "deploy", "ensure-browser.mjs");
  const nodeBin = process.execPath;
  const withNodeOnPath = { ...env, PATH: `${path.dirname(nodeBin)}${path.delimiter}${env.PATH ?? ""}` };
  // The LOCAL Ollama, the same as the console uses: an empty OLLAMA_URL (saving a cloud key clears the old cloud one) or an
  // ollama.com URL means the default local address, never "" (which made every health check say Ollama wasn't running).
  const ollamaUrl = localOllamaUrl(env.OLLAMA_URL, parseEnv(readText(paths.envFile) ?? "").OLLAMA_URL);
  const fsx = { existsSync, readdirSync, mkdirSync, cpSync, accessWritable: (p) => accessSync(p, constants.W_OK) };
  return {
    paths, fs: fsx, nodeVersion: process.version, readText, parseEnv,
    writeText: (f, t) => writeFileSync(f, t, { mode: 0o600 }),
    defaultModel: env.NBS_LOCAL_MODEL ?? "gemma3:4b",
    freeBytes: async (dir) => { try { const s = statfsSync(existsSync(dir) ? dir : path.dirname(dir)); return Number(s.bavail) * Number(s.bsize); } catch { return null; } },
    installDeps: async () => {
      const npx = path.join(path.dirname(nodeBin), WIN ? "npx.cmd" : "npx");
      log("reinstalling packages");
      await exec(npx, ["-y", "pnpm@9.15.4", "install", "--frozen-lockfile", "--filter", "@spot/worker..."], { cwd: paths.appDir, env: withNodeOnPath, timeout: 20 * 60_000, maxBuffer: 16 << 20, shell: WIN });
    },
    browserCheck: async () => {
      try { const { stdout } = await exec(nodeBin, [ensureScript, "--check"], { env: { ...env }, timeout: 60_000 }); return { ok: true, build: /(\d+\.\d+\.\d+\.\d+)/.exec(stdout)?.[1] }; }
      catch { return { ok: false }; }
    },
    browserEnsure: async (from = []) => {
      const args = [ensureScript, ...from.flatMap((f) => ["--from", f])];
      await exec(nodeBin, args, { env: { ...env }, timeout: 20 * 60_000, maxBuffer: 8 << 20 });
    },
    ollamaTags: async () => {
      try { const r = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2500) }); return r.ok ? ((await r.json()).models ?? []).map((m) => m.name) : null; } catch { return null; }
    },
    memory: readMemory,
    /** Models Ollama holds in memory right now: [{ name, size }] (null when Ollama can't be asked). */
    ollamaLoaded: async () => {
      try { const r = await fetch(`${ollamaUrl}/api/ps`, { signal: AbortSignal.timeout(2500) }); return r.ok ? ((await r.json()).models ?? []).map((m) => ({ name: m.name, size: Number(m.size) || 0 })) : null; } catch { return null; }
    },
    ollamaEnsure: async () => {
      const model = parseEnv(readText(paths.envFile) ?? "").NBS_LOCAL_MODEL || env.NBS_LOCAL_MODEL || "gemma3:4b";
      const up = async () => { try { return (await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
      if (!(await up())) {
        if (MAC) await exec("launchctl", ["kickstart", `gui/${process.getuid()}/app.nothingbot.server.ollama`]).catch(() => {});
        else if (!WIN && existsSync("/etc/systemd/system/ollama.service")) await exec("sudo", ["-n", "/usr/bin/systemctl", "start", "ollama"]).catch(() => {});
        // OLLAMA_MODELS comes from the persisted pointer, read now: the environment this process inherited can be stale.
        else spawn(env.NBS_OLLAMA_EXE ?? "ollama", ["serve"], { detached: true, stdio: "ignore", env: { ...process.env, ...ollamaEnv(resolveModelsDir(contextFor(process.platform, process.env)).dir, { ...env, ...parseEnv(readText(paths.envFile) ?? "") }) } }).on("error", () => {}).unref();
        for (let i = 0; i < 20 && !(await up()); i++) await new Promise((r) => setTimeout(r, 1000));
      }
      if (!(await up())) throw new Error("Ollama isn't installed or won't start; run Update or reinstall");
      // Pull in the background: nothing waits for it.
      fetch(`${ollamaUrl}/api/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, stream: false }) }).catch(() => {});
    },
    servicesCheck: async () => {
      const need = (txts, what) => txts.some((t) => t == null) ? { ok: false, detail: `${what} isn't registered` } : txts.some((t) => !t.includes(paths.appDir)) ? { ok: false, detail: `${what} points at a different folder than this install` } : { ok: true };
      if (MAC) {
        const dir = path.join(os.homedir(), "Library", "LaunchAgents");
        return need(["worker", "console"].map((n) => readText(path.join(dir, `app.nothingbot.server.${n}.plist`))), "A launch agent");
      }
      if (WIN) {
        try { const { stdout } = await exec("powershell", ["-NoProfile", "-Command", "(Get-ScheduledTask -TaskName 'NothingBotServerWorker','NothingBotServerConsole' -ErrorAction Stop | Measure-Object).Count"], { timeout: 20000 }); return Number(stdout.trim()) >= 2 ? { ok: true } : { ok: false, detail: "A scheduled task isn't registered" }; }
        catch { return { ok: false, detail: "A scheduled task isn't registered" }; }
      }
      if (!existsSync("/etc/systemd/system")) return { ok: true };
      return need(["worker", "console"].map((n) => readText(`/etc/systemd/system/nothing-bot-server-${n}.service`)), "A systemd service");
    },
    // Mac only: nbsctl rewrites its launch agents. Windows and Ubuntu report instead (their units are root/SYSTEM-owned).
    servicesRepair: MAC ? async () => { await exec("/bin/bash", [path.join(paths.appDir, "deploy", "mac", "nbsctl"), "write-agents"]); } : undefined,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = process.argv.slice(2);
  const only = a.includes("--only") ? a[a.indexOf("--only") + 1].split(",") : null;
  const res = await runDoctor(createMachine({ log: (m) => console.log(`[doctor] ${m}`) }), { repair: a.includes("--repair"), quick: a.includes("--quick"), only });
  if (a.includes("--json")) console.log(JSON.stringify(res));
  else {
    for (const r of res.results) console.log(`  ${r.ok ? (r.fixed ? "fixed" : "ok   ") : "FAIL "} ${r.title}: ${r.detail}${r.fix ? ` (${r.fix})` : ""}`);
    console.log(summarize(res));
  }
  process.exit(hasCriticalFailure(res) ? 1 : 0);
}
