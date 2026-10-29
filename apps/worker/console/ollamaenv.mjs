// Where Ollama keeps its models, and making sure the Ollama we run is reading that folder.
//
// Nothing assumes a drive or a folder. resolveModelsDir() checks, in order, the places models can live and uses the first one that really
// holds models: the models-dir pointer, OLLAMA_MODELS (machine then user level, read fresh, never this process's inherited copy), the install's
// own folder, then Ollama's own default for this OS. When the winner is not the pointer, the pointer is rewritten to it, so every launcher and
// the updater use that exact location from then on. Every start of Ollama sets OLLAMA_MODELS from the result. A running Ollama that lists no
// models while the folder has them is "reading the wrong folder": it is restarted with the right environment.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPointer, writePointer } from "./storage.mjs";

const KEEP_ALIVE = /^(-1|0|\d+(\.\d+)?(ms|s|m|h))$/;
/** How long Ollama keeps a model in memory: NBS_OLLAMA_KEEP_ALIVE, default 5m (same rule as the worker's ollamaKeepAlive in aiRouting.ts). */
export const keepAlive = (raw) => { const v = String(raw ?? "").trim(); return KEEP_ALIVE.test(v) ? v : "5m"; };

export const ollamaEnv = (dir, env = process.env) => ({ OLLAMA_MODELS: dir, OLLAMA_KEEP_ALIVE: keepAlive(env.NBS_OLLAMA_KEEP_ALIVE) });

/** What is in a models folder: manifests (one per installed model tag), blob bytes, and whether a blobs folder exists. Never throws. */
export function scanModelsDir(dir, { readdir = readdirSync, stat = statSync, join = path.join, root = "manifests", bytes = true } = {}) {
  const out = { manifests: 0, blobBytes: 0, hasBlobs: false };
  if (!dir) return out;
  const walk = (d, depth) => {
    let names;
    try { names = readdir(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      let s;
      try { s = stat(p); } catch { continue; }
      if (s.isDirectory()) { if (depth < 8) walk(p, depth + 1); } else out.manifests++;
    }
  };
  walk(join(dir, root), 0);
  try { out.hasBlobs = stat(join(dir, "blobs")).isDirectory(); } catch {}
  if (bytes) try { for (const n of readdir(join(dir, "blobs"))) { try { out.blobBytes += stat(join(dir, "blobs", n)).size; } catch {} } } catch {}
  return out;
}

/** OLLAMA_MODELS at the machine or user level of Windows, read fresh (a launcher's or console's own environment may predate a move). Cached briefly. */
const winCache = new Map();
function winEnvVar(scope) {
  const hit = winCache.get(scope);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  let v = null;
  try { v = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::GetEnvironmentVariable('OLLAMA_MODELS','${scope}')`], { encoding: "utf8", timeout: 5000, windowsHide: true }).trim() || null; } catch {}
  winCache.set(scope, { at: Date.now(), v });
  return v;
}

const sameDir = (a, b, platform) => { const n = (x) => String(x ?? "").replace(/[\\/]+$/, ""); return platform === "win32" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b); };

/**
 * Where the models are: { dir, source, models }. The first candidate holding real models wins (a manifests/registry.ollama.ai tree with at
 * least one manifest, and a blobs folder). With none, dir is the pointer if set, else the install default, so new pulls go to the planned place.
 * source: "pointer" | "machine-env" | "user-env" | "env" | "install-default" | "ollama-default". A winner that is not the pointer is written to the pointer.
 */
export function resolveModelsDir({ stateDir, defaultModels, platform = process.platform, home = os.homedir(), env = process.env, read = readPointer, write = writePointer,
  fs = {}, envVar = winEnvVar, log = console.log }) {
  const win = platform === "win32";
  const join = (win ? path.win32 : path.posix).join;
  const readdir = fs.readdir ?? readdirSync;
  const pointer = read(stateDir, "models-dir") || read(stateDir, "models-dir.txt") || null;
  const own = join(home, ".ollama", "models");
  const cands = [{ dir: pointer, source: "pointer" }];
  if (win) cands.push({ dir: envVar("Machine"), source: "machine-env" }, { dir: envVar("User"), source: "user-env" });
  else cands.push({ dir: env.OLLAMA_MODELS, source: "env" });
  cands.push({ dir: defaultModels, source: "install-default" });
  if (win) {
    // The console may run as SYSTEM, so the person's own .ollama folder is in their profile, beside every other one.
    const users = env.SystemDrive ? join(env.SystemDrive + "\\", "Users") : path.win32.dirname(home);
    let profiles = [];
    try { profiles = readdir(users); } catch {}
    cands.push({ dir: own, source: "ollama-default" }, ...profiles.map((n) => ({ dir: join(users, n, ".ollama", "models"), source: "ollama-default" })));
  } else if (platform === "darwin") cands.push({ dir: own, source: "ollama-default" });
  else cands.push({ dir: "/usr/share/ollama/.ollama/models", source: "ollama-default" }, { dir: own, source: "ollama-default" });

  const seen = [];
  for (const c of cands) {
    if (!c.dir || seen.some((d) => sameDir(d, c.dir, platform))) continue;
    seen.push(c.dir);
    const s = scanModelsDir(c.dir, { ...fs, join, root: join("manifests", "registry.ollama.ai"), bytes: false });
    if (!s.manifests || !s.hasBlobs) continue;
    if (!pointer || !sameDir(pointer, c.dir, platform)) {
      try { write(stateDir, "models-dir", c.dir); log(`[models] found ${s.manifests} model${s.manifests === 1 ? "" : "s"} in ${c.dir} (${c.source}); pointer updated`); } catch {}
    }
    return { dir: c.dir, source: c.source, models: s.manifests };
  }
  return pointer ? { dir: pointer, source: "pointer", models: 0 } : { dir: defaultModels, source: "install-default", models: 0 };
}

/** "wrong-folder" when Ollama answers with no models while the models folder holds some; otherwise null. */
export function wrongFolder({ up, modelCount, scan }) {
  return up && modelCount === 0 && scan.manifests > 0 && scan.blobBytes > 0 ? "wrong-folder" : null;
}

const q = (s) => String(s).replace(/'/g, "''");

/**
 * PowerShell that sets `$exe` to a real ollama.exe, or stops with a plain error. The server runs as SYSTEM, which doesn't have the
 * user's PATH or their AppData, so a bare "ollama" isn't found: look in the server's own copy, the usual install folders, every
 * user's per-user install (Ollama's installer puts it under the user who ran it), then PATH.
 */
export function winFindOllamaScript({ exe, root }) {
  const tries = [exe && exe !== "ollama" ? exe : null, root ? `${root}\\ollama-app\\ollama.exe` : null].filter(Boolean).map((x) => `'${q(x)}'`);
  return [
    `$exe = $null`,
    `foreach ($c in @(${[...tries, `"$env:LOCALAPPDATA\\Programs\\Ollama\\ollama.exe"`, `"$env:ProgramFiles\\Ollama\\ollama.exe"`, `"$env:windir\\System32\\config\\systemprofile\\AppData\\Local\\Programs\\Ollama\\ollama.exe"`].join(", ")})) { if ($c -and (Test-Path -LiteralPath $c)) { $exe = $c; break } }`,
    `if (-not $exe) { $exe = Get-ChildItem "$env:SystemDrive\\Users\\*\\AppData\\Local\\Programs\\Ollama\\ollama.exe" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName }`,
    `if (-not $exe) { $g = Get-Command ollama -ErrorAction SilentlyContinue | Select-Object -First 1; if ($g) { $exe = $g.Source } }`,
    `if (-not $exe) { throw "Ollama isn't installed on this server (ollama.exe wasn't found). Reinstall it from ollama.com, or run the Nothing BOT installer again." }`,
  ].join("; ");
}

/** PowerShell: find ollama.exe FIRST (nothing is stopped if it's missing), stop every Ollama (server and tray app), start ours with
 * the models folder set explicitly, and fail loudly if it didn't come back. */
export function winRestartOllamaScript({ exe, dir, env, root }) {
  return `$ErrorActionPreference='Stop'; ${winFindOllamaScript({ exe, root })}; Get-Process -Name 'ollama','ollama app' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep 2; ${winStartOllamaScript({ exe, dir, env, root, found: true })}`;
}
export function winStartOllamaScript({ exe, dir, env, root, found = false }) {
  const e = ollamaEnv(dir, env);
  return [
    found ? null : `$ErrorActionPreference='Stop'; ${winFindOllamaScript({ exe, root })}`,
    `$env:OLLAMA_MODELS='${q(e.OLLAMA_MODELS)}'; $env:OLLAMA_KEEP_ALIVE='${e.OLLAMA_KEEP_ALIVE}'`,
    `Start-Process -FilePath $exe -ArgumentList serve -WindowStyle Hidden`,
    // Up means it answers on its port, not just that a process exists.
    `$ok = $false; foreach ($i in 1..15) { Start-Sleep 1; try { Invoke-RestMethod 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 | Out-Null; $ok = $true; break } catch {} }`,
    `if (-not $ok) { throw "Ollama was started from $exe but isn't answering on port 11434 yet." }`,
    `Write-Output "Ollama running ($exe)"`,
  ].filter(Boolean).join("; ");
}

/**
 * Watches for "Ollama is reading the wrong folder" and fixes it by restarting Ollama (at most once per cooldown).
 * `info()` is Ollama's own answer ({up, models}); `restart()` restarts it with the right environment.
 * check() returns { problem: "wrong-folder" | null, dir, fixing, fixedAt, manifests }.
 */
export function createOllamaGuard({ info, dir, scan = scanModelsDir, restart, enabled = () => true, now = Date.now, cooldownMs = 5 * 60_000 }) {
  let fixedAt = null, lastTry = 0, fixing = false;
  return {
    async check() {
      const d = dir();
      if (!enabled()) return { problem: null, dir: d, fixing: false, fixedAt };
      const o = await info();
      const s = o.up && o.models.length === 0 ? scan(d) : { manifests: 0, blobBytes: 0 };
      const problem = wrongFolder({ up: o.up, modelCount: o.models.length, scan: s });
      if (problem && !fixing && now() - lastTry >= cooldownMs) {
        lastTry = now();
        fixing = true;
        try { await restart(d); fixedAt = now(); } catch { /* shown as still wrong on the next look */ } finally { fixing = false; }
      }
      return { problem, dir: d, fixing, fixedAt, manifests: s.manifests };
    },
  };
}
