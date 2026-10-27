// Where Ollama keeps its models, and making sure the Ollama we run is reading that folder.
//
// The folder is persisted in the models-dir pointer (written by "Move data", read by the installer and updater). Every start of Ollama
// sets OLLAMA_MODELS from that file, read at start time. The environment this process inherited is never trusted: it can be from before a
// move, and Ollama's own tray app (started at login) can hold the port with its own folder. A running Ollama that lists no models while the
// folder has them is "reading the wrong folder": it is restarted with the right environment.
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { readPointer } from "./storage.mjs";

/** The folder models live in, read fresh from the pointer. Windows falls back to the install's own folder, never to an inherited variable. */
export function freshModelsDir({ stateDir, defaultModels, env = process.env, platform = process.platform, read = readPointer }) {
  return read(stateDir, "models-dir") || read(stateDir, "models-dir.txt") || (platform === "win32" ? defaultModels : env.OLLAMA_MODELS || defaultModels);
}

export const ollamaEnv = (dir) => ({ OLLAMA_MODELS: dir, OLLAMA_KEEP_ALIVE: "24h" });

/** What is in a models folder: how many manifests (one per installed model tag) and how many bytes of blobs. Never throws. */
export function scanModelsDir(dir, { readdir = readdirSync, stat = statSync } = {}) {
  const out = { manifests: 0, blobBytes: 0 };
  if (!dir) return out;
  const walk = (d, depth) => {
    let names;
    try { names = readdir(d); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n);
      let s;
      try { s = stat(p); } catch { continue; }
      if (s.isDirectory()) { if (depth < 8) walk(p, depth + 1); } else out.manifests++;
    }
  };
  walk(path.join(dir, "manifests"), 0);
  try { for (const n of readdir(path.join(dir, "blobs"))) { try { out.blobBytes += stat(path.join(dir, "blobs", n)).size; } catch {} } } catch {}
  return out;
}

/** "wrong-folder" when Ollama answers with no models while the models folder holds some; otherwise null. */
export function wrongFolder({ up, modelCount, scan }) {
  return up && modelCount === 0 && scan.manifests > 0 && scan.blobBytes > 0 ? "wrong-folder" : null;
}

const q = (s) => String(s).replace(/'/g, "''");

/** PowerShell: stop every Ollama (server and tray app), then start ours with the models folder set explicitly. */
export function winRestartOllamaScript({ exe, dir }) {
  return `$ErrorActionPreference='SilentlyContinue'; Get-Process -Name 'ollama','ollama app' | Stop-Process -Force; Start-Sleep 2; ${winStartOllamaScript({ exe, dir })}`;
}
export function winStartOllamaScript({ exe, dir }) {
  const e = ollamaEnv(dir);
  return `$env:OLLAMA_MODELS='${q(e.OLLAMA_MODELS)}'; $env:OLLAMA_KEEP_ALIVE='${e.OLLAMA_KEEP_ALIVE}'; Start-Process -FilePath '${q(exe || "ollama")}' -ArgumentList serve -WindowStyle Hidden`;
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
