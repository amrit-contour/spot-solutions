// Moves Spot Solutions' data (and optionally the Ollama models) to another folder, safely, on Windows, macOS and Ubuntu.
//
// The console never does this itself: it writes the request into DATA/task.json and starts the platform's task runner
// (update-core.ps1 as SYSTEM on Windows, `spotctl task` on macOS, spot-task as root on Ubuntu), which runs
//   node move.mjs move-data      copy, verify, switch, restart, check WhatsApp, rollback on any failure
//   node move.mjs move-cleanup   delete the old copy, only after a verified move
// so the job outlives the worker and console restarts it causes. Node built-ins only. On Ubuntu this file and storage.mjs are
// installed root-owned in /usr/local/lib/spot-solutions and the request is validated again there: the request is untrusted.
//
// Test hooks: SPOT_MOVE_DRY_RUN=1 never touches services or the machine's settings (the copy and the config rewrite still happen
// in the folders it is given), SPOT_ROOT, SPOT_STATE_DIR, SPOT_APP_DIR, SPOT_DATA_DIR.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmdirSync, chmodSync, lchownSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import {
  HEADROOM_BYTES, MARKER, modFor, pathKey, isInside, inspectTarget, measure, copyTree, verifyTree, removeTree,
  rewriteEnvPaths, replacePaths, readPointer, writePointer, writeAtomic, readJson, fmtGb, makeFolder, fingerprint, sameFingerprint, waitQuiet, STILL_CLOSING,
} from "./storage.mjs";

const exec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODELS_DIR_NAME = "ollama-models";

// ---------- where things are, per platform ----------
export function contextFor(platform = process.platform, env = process.env) {
  const m = modFor(platform);
  let c;
  if (platform === "win32") {
    const root = env.SPOT_ROOT || "C:\\SpotSolutions";
    c = { root, stateDir: env.SPOT_STATE_DIR || root, defaultData: m.join(root, "data"), app: m.join(root, "app"), defaultModels: m.join(root, "ollama"), chrome: m.join(root, "chrome"), forbid: [m.join(root, "node"), m.join(root, "chrome"), m.join(root, "ollama-app")] };
  } else if (platform === "darwin") {
    const root = env.SPOT_ROOT || path.join(os.homedir(), "Library", "Application Support", "SpotSolutions");
    c = { root, stateDir: env.SPOT_STATE_DIR || root, defaultData: path.join(root, "data"), app: path.join(root, "app"), defaultModels: path.join(os.homedir(), ".ollama", "models"), chrome: path.join(root, "chrome"), forbid: [path.join(root, "runtime"), path.join(root, "chrome")] };
  } else {
    c = { root: "/opt/spot-solutions", stateDir: env.SPOT_STATE_DIR || "/etc/spot-solutions", defaultData: "/var/lib/spot-solutions", app: env.SPOT_APP_DIR || "/opt/spot-solutions", defaultModels: "/usr/share/ollama/.ollama/models", chrome: null, forbid: ["/usr/local/lib/spot-solutions", "/usr/local/sbin", "/etc/spot-solutions"] };
  }
  c.platform = platform;
  c.envFile = m.join(c.app, "apps", "worker", ".env");
  c.forbidden = [{ path: c.app, label: "the Spot Solutions program folder" }, ...c.forbid.map((p) => ({ path: p, label: "Spot Solutions' own program files" }))];
  c.current = readPointer(c.stateDir, "data-dir") || env.SPOT_DATA_DIR || c.defaultData;
  c.currentModels = readPointer(c.stateDir, "models-dir") || env.OLLAMA_MODELS || c.defaultModels;
  c.stateFile = m.join(c.stateDir, "move.json");
  return c;
}

/** What a move would do, from the request alone: where from, where to, and whether the models travel too. */
export function planMove(ctx, { target, models = false }) {
  const m = modFor(ctx.platform);
  const old = ctx.current;
  const modelsInside = isInside(ctx.currentModels, old, ctx.platform);
  const plan = { old, target, models: null };
  if (modelsInside) {
    plan.models = { old: ctx.currentModels, new: m.join(target, m.relative(old, ctx.currentModels)), separate: false };
  } else if (models) {
    plan.models = { old: ctx.currentModels, new: m.join(target, MODELS_DIR_NAME), separate: true };
  }
  return plan;
}

// ---------- the move record ----------
const readState = (ctx) => readJson(ctx.stateFile) ?? {};
function saveState(ctx, patch, now = Date.now) {
  const next = { ...readState(ctx), ...patch, updatedAt: now() };
  writeAtomic(ctx.stateFile, JSON.stringify(next), 0o644);
  return next;
}

// ---------- waiting for WhatsApp to come back ----------
/** Counts accounts in a live-stats.json (what the worker writes every few seconds). */
export function readyCounts(stats) {
  const a = Array.isArray(stats?.accounts) ? stats.accounts : [];
  return { accounts: a.length, ready: a.filter((x) => x.status === "ready").length, qr: a.filter((x) => x.status === "qr").length, writtenAt: Number(stats?.writtenAt) || 0 };
}
/**
 * Polls the worker's stats file in the new folder until the worker reports again, every account that was ready before is
 * ready, and none asks for a QR. { ok, detail }.
 */
export async function waitHealthy({ file, since, expectReady, timeoutMs = 6 * 60_000, pollMs = 3000, read = (f) => readJson(f), wait = sleep, now = Date.now }) {
  const end = now() + timeoutMs;
  let last = null;
  for (;;) {
    const c = readyCounts(read(file));
    last = c;
    if (c.writtenAt >= since && c.qr === 0 && c.ready >= expectReady) return { ok: true, detail: c };
    if (now() >= end) break;
    await wait(pollMs);
  }
  const why = !last || last.writtenAt < since ? "the worker never started reporting from the new folder" : last.qr ? "WhatsApp asked for a QR scan" : `only ${last.ready} of ${expectReady} WhatsApp accounts came back`;
  return { ok: false, detail: last, error: `Checked for ${Math.round(timeoutMs / 60000)} minutes: ${why}.` };
}

// ---------- the move ----------
/**
 * Runs a move. Everything outside this file is injected, so tests drive it with fakes:
 *   ops.prepare / stop / persist / start   per-platform service control and configuration
 *   io.inspect / measure / copy / verify / health   the disk work
 * On any failure it switches back to the old folder, restarts, removes only the half-made copy, and reports what went wrong.
 */
export async function runMove({ ctx, request, ops, io, report = () => {}, now = Date.now }) {
  const plan = planMove(ctx, request);
  const { old, target } = plan;
  const started = now();
  let phase = "validating", stopped = false, switched = false, created = false;
  const step = (s, pct) => { phase = s; report({ step: s, pct }); saveState(ctx, { phase: "running", step: s, pct: pct ?? null, old, target, moveModels: Boolean(plan.models), modelsOld: plan.models?.old ?? null, modelsNew: plan.models?.new ?? null, startedAt: started, error: null }, now); };
  const swap = (p) => ({ from: p.old, to: p.target, modelsFrom: p.models?.old ?? null, modelsTo: p.models?.new ?? null });
  try {
    step("Checking the new folder", 1);
    const dataSize = await io.measure(old);
    const modelsSize = plan.models?.separate ? await io.measure(plan.models.old) : { bytes: 0, files: 0 };
    const need = dataSize.bytes + modelsSize.bytes + HEADROOM_BYTES;
    const chk = await io.inspect(target, { needBytes: need });
    if (!chk.ok) throw new Error(chk.error);
    if (chk.path !== target) throw new Error("The folder path changed while checking it.");
    const before = io.readyNow ? io.readyNow(old) : { ready: 0 };

    step("Stopping the worker", 4);
    stopped = true; // even a stop that fails halfway must be followed by a restart
    await ops.stop({ ...swap(plan), models: Boolean(plan.models?.separate) });
    // Nothing may write to the data folder from here on. A browser that is still closing keeps changing its files, so wait for quiet.
    if (io.quiet) { const q = await io.quiet(old); if (!q.ok) throw new Error(STILL_CLOSING); }
    const pictureBefore = io.fingerprint ? await io.fingerprint(old) : null;

    step("Preparing the new folder", 6);
    created = !chk.existed;
    await ops.prepare({ target, models: plan.models?.separate ? plan.models.new : null });
    makeFolder(target, { platform: ctx.platform });
    writeFileSync(path.join(target, MARKER), JSON.stringify({ from: old, at: now() }));
    if (io.own) io.own(path.join(target, MARKER));

    const total = dataSize.bytes + modelsSize.bytes;
    let done = 0;
    const prog = (base) => (p) => { const pct = total ? Math.min(100, Math.round(((base + p.bytes) / total) * 100)) : 100; step(`Copying data (${fmtGb(base + p.bytes)} of ${fmtGb(total)})`, 8 + Math.round(pct * 0.6)); };
    const c1 = await io.copy(old, target, { onProgress: prog(0), total: dataSize.bytes });
    done = c1.bytes;
    if (plan.models?.separate) await io.copy(plan.models.old, plan.models.new, { onProgress: prog(done), total: modelsSize.bytes });

    // If the original changed while it was being copied, something was still writing: that is a retry, not a bad copy.
    if (pictureBefore && !sameFingerprint(pictureBefore, await io.fingerprint(old))) throw new Error(STILL_CLOSING);

    step("Checking the copy", 70);
    const v = await io.verify(old, target, { ignore: plan.models?.separate ? [MODELS_DIR_NAME] : [] });
    if (!v.ok) throw new Error(`The copy doesn't match the original (${v.problems.slice(0, 3).join("; ")}).`);
    if (plan.models?.separate) {
      const vm = await io.verify(plan.models.old, plan.models.new, {});
      if (!vm.ok) throw new Error(`The copied AI models don't match the original (${vm.problems.slice(0, 3).join("; ")}).`);
    }
    // Small settings files may have changed while the console was running: copy them once more.
    await io.syncSmall(old, target);

    step("Switching to the new folder", 78);
    const sinceStart = now();
    await ops.persist({ ...swap(plan) });
    switched = true;
    step("Starting the worker", 82);
    await ops.start({ models: Boolean(plan.models?.separate), target });

    const hasKey = existsSync(path.join(target, "service-account.json"));
    if (hasKey) {
      step("Waiting for WhatsApp to come back", 88);
      const h = await io.health({ file: path.join(target, "live-stats.json"), since: sinceStart, expectReady: before.ready });
      if (!h.ok) throw new Error(h.error);
    }
    const next = saveState(ctx, { phase: "awaiting-cleanup", step: "Done", pct: 100, verified: true, error: null, finishedAt: now(), files: v.files, bytes: dataSize.bytes + modelsSize.bytes, rolledBack: false }, now);
    report({ step: "Done", pct: 100, done: true, state: next });
    return { ok: true, state: next };
  } catch (e) {
    const msg = e?.message || String(e);
    const where = phase;
    report({ step: "Something went wrong. Going back to the old folder", pct: null });
    const problems = [];
    try {
      if (switched) await ops.persist({ from: target, to: old, modelsFrom: plan.models?.new ?? null, modelsTo: plan.models?.old ?? null });
    } catch (e2) { problems.push(`couldn't switch the settings back: ${e2.message}`); }
    try {
      if (stopped || switched) await ops.start({ models: Boolean(plan.models?.separate), target: old });
    } catch (e3) { problems.push(`couldn't restart: ${e3.message}`); }
    try {
      // Only a half-made copy that carries our marker is ever removed.
      if (existsSync(path.join(target, MARKER)) && !isInside(old, target, ctx.platform)) {
        await io.remove(target, created);
      }
    } catch (e4) { problems.push(`couldn't clean up ${target}: ${e4.message}`); }
    const error = `${msg} (while: ${where.toLowerCase()}). The data is back on the old folder${problems.length ? `, but ${problems.join("; ")}` : ""}.`;
    const next = saveState(ctx, { phase: "failed", step: "Failed", error, rolledBack: true, finishedAt: now() }, now);
    report({ step: "Failed", error, done: true, state: next });
    return { ok: false, error, state: next };
  }
}

/**
 * Deletes the old copy, and only that: the folder recorded by a verified move, never the one in use. Refuses anything else.
 */
export async function runCleanup({ ctx, io, report = () => {}, now = Date.now }) {
  const st = readState(ctx);
  const refuse = (error) => { report({ step: "Failed", error, done: true }); return { ok: false, error }; };
  if (st.phase !== "awaiting-cleanup" || !st.verified || !st.old || !st.target) return refuse("There is no verified move waiting for cleanup.");
  if (pathKey(ctx.current, ctx.platform) !== pathKey(st.target, ctx.platform)) return refuse("The data isn't running from the new folder, so the old one is not deleted.");
  if (pathKey(st.old, ctx.platform) === pathKey(st.target, ctx.platform) || isInside(st.old, st.target, ctx.platform) || isInside(st.target, st.old, ctx.platform)) return refuse("The old and new folders overlap, so nothing is deleted.");
  if (!existsSync(path.join(st.target, MARKER))) return refuse("The new folder isn't the copy this move made, so nothing is deleted.");
  const victims = [{ dir: st.old, label: "old data" }];
  if (st.moveModels && st.modelsOld && st.modelsNew && !isInside(st.modelsOld, st.old, ctx.platform) && pathKey(st.modelsOld, ctx.platform) !== pathKey(st.modelsNew, ctx.platform) && !isInside(st.modelsOld, st.target, ctx.platform)) victims.push({ dir: st.modelsOld, label: "old AI models" });
  saveState(ctx, { phase: "cleaning", step: "Deleting the old copy", pct: 0 }, now);
  try {
    let i = 0;
    for (const v of victims) {
      report({ step: `Deleting the ${v.label}`, pct: Math.round((i / victims.length) * 100) });
      if (existsSync(v.dir)) await io.removeOld(v.dir);
      i++;
    }
    const next = saveState(ctx, { phase: "done", step: "Old copy deleted", pct: 100, cleanedAt: now(), error: null }, now);
    report({ step: "Old copy deleted", pct: 100, done: true, state: next });
    return { ok: true };
  } catch (e) {
    saveState(ctx, { phase: "awaiting-cleanup", step: "Cleanup stopped", error: `Couldn't delete everything: ${e.message}` }, now);
    return refuse(`Couldn't delete everything: ${e.message}`);
  }
}

// ---------- real disk work ----------
export function realIo(ctx, { run, chown = null, dry = false } = {}) {
  const p = ctx.platform;
  return {
    measure: (dir) => measure(dir, { platform: p }),
    inspect: (target, o) => inspectTarget(target, { platform: p, current: ctx.current, forbidden: ctx.forbidden, run, strictLinks: p === "linux" && process.getuid?.() === 0, ...o }),
    copy: (a, b, o) => copyTree(a, b, { platform: p, chown, ...o }),
    verify: (a, b, o) => verifyTree(a, b, { platform: p, ...o }),
    quiet: (dir) => (dry ? Promise.resolve({ ok: true }) : waitQuiet(dir, { platform: p })),
    fingerprint: (dir) => fingerprint(dir, { platform: p }),
    // Settings the console rewrites while we copy (console.json holds the auto-update switch).
    syncSmall: async (a, b) => { for (const f of ["console.json", "console-token", "service-account.json"]) { try { if (existsSync(path.join(a, f))) { writeFileSync(path.join(b, f), readFileSync(path.join(a, f)), { mode: 0o600 }); if (chown) lchownSync(path.join(b, f), chown.uid, chown.gid); } } catch { /* verified already */ } } },
    health: (o) => (dry ? Promise.resolve({ ok: true }) : waitHealthy(o)),
    own: (file) => { if (chown) { try { lchownSync(file, chown.uid, chown.gid); } catch { /* best effort */ } } },
    readyNow: (dir) => readyCounts(readJson(path.join(dir, "live-stats.json"))),
    remove: async (dir, created) => { await removeTree(dir, { platform: p }); if (created) { try { rmdirSync(dir); } catch { /* not empty or gone */ } } },
    removeOld: async (dir) => { await removeTree(dir, { platform: p }); try { rmdirSync(dir); } catch { /* may be a home directory or still in use */ } },
  };
}

// ---------- per-platform service control ----------
async function sh(cmd, args, o = {}) {
  try { const { stdout } = await exec(cmd, args, { timeout: 120_000, maxBuffer: 4 << 20, ...o }); return stdout.trim(); } catch (e) { if (o.strict) throw new Error(`${cmd} ${args.join(" ")}: ${(e.stderr || e.message).toString().trim().slice(0, 300)}`); return (e.stdout ?? "").toString().trim(); }
}

function writeEnvPaths(ctx, from, to, modelsFrom, modelsTo) {
  if (!existsSync(ctx.envFile)) return;
  const text = readFileSync(ctx.envFile, "utf8");
  const pairs = [[from, to]];
  if (modelsFrom && modelsTo) pairs.push([modelsFrom, modelsTo]);
  const next = rewriteEnvPaths(text, pairs, ctx.platform);
  if (next !== text) writeFileSync(ctx.envFile, next); // writeFileSync keeps the file's owner and mode
}

/**
 * From `ps -axo pid=,ppid=,command=` output: the browsers that use `dir` as their profile folder, plus everything below them
 * (renderers and helpers don't carry the folder in their command line, so they are found through their parent).
 */
export function browserPidsOn(psOut, dir, selfPid = process.pid) {
  const rows = [];
  for (const line of psOut.split("\n")) {
    const mm = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (mm) rows.push({ pid: Number(mm[1]), ppid: Number(mm[2]), cmd: mm[3] });
  }
  const hit = new Set(rows.filter((r) => /chrom/i.test(r.cmd) && r.cmd.includes(`--user-data-dir=${dir}`) && r.pid !== selfPid).map((r) => r.pid));
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (!hit.has(r.pid) && r.pid !== selfPid && hit.has(r.ppid)) { hit.add(r.pid); grew = true; }
  }
  return [...hit];
}

export function makeOps(ctx, { dry = false, log = console.log } = {}) {
  const win = ctx.platform === "win32", mac = ctx.platform === "darwin";
  const m = modFor(ctx.platform);
  const D = (what) => { log(`(dry run) ${what}`); };
  const ps = (script, env = {}) => (dry ? D(`powershell ${script.slice(0, 50)}…`) : sh("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { env: { ...process.env, ...env } }));
  const uid = process.getuid?.() ?? 0;
  const gui = `gui/${uid}`;
  const ctl = path.join(ctx.root, "spotctl");
  const ids = {};
  const idOf = async (user) => { if (!ids[user]) { const [u, g] = await Promise.all([sh("id", ["-u", user]), sh("id", ["-g", user])]); ids[user] = { uid: Number(u), gid: Number(g) }; } return ids[user]; };

  // Other programs' processes that hold files in `dir`: browsers WhatsApp left behind (with their helpers). Kills them, then
  // waits until they are really gone, and says so if they are not.
  async function killBrowsersOn(dir, { tries = 30, wait = sleep } = {}) {
    if (dry) return D(`kill browsers using ${dir}`);
    for (let i = 0; i < tries; i++) {
      const pids = browserPidsOn(await sh("ps", ["-axo", "pid=,ppid=,command="]), dir);
      if (!pids.length) return;
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
      await wait(1000);
    }
    throw new Error(STILL_CLOSING);
  }

  return {
    async stop({ from, models }) {
      if (win) {
        const out = await ps(`
$ErrorActionPreference = 'SilentlyContinue'
$old = $env:SPOT_OLD.TrimEnd('\\')
$chrome = $env:SPOT_CHROME
$ci = [StringComparison]::OrdinalIgnoreCase
function Kill-Tree($id) { & taskkill.exe /PID $id /T /F *> $null; Stop-Process -Id $id -Force }
# Wildcard-free matching (a folder name with [ ] must not break it). Chrome, Edge or Chromium running from our profile folders,
# including the crash handler; their helpers die with them (taskkill /T).
function Get-Browsers { Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -match '^(chrome|chromium|msedge|chrome_crashpad_handler|crashpad_handler)\\.exe$' -and (($chrome -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($chrome + '\\', $ci)) -or ($_.CommandLine -and $_.CommandLine.IndexOf($old, $ci) -ge 0)) } }
function Get-Workers { Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*SpotSolutions*' -and $_.CommandLine -notlike '*console*server.mjs*' -and $_.CommandLine -notlike '*move.mjs*' } }
Stop-ScheduledTask -TaskName SpotSolutionsWorker
# The launcher loop starts the worker again ~10 s after it dies, and that new browser would write into the folder being copied: it goes first.
Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.IndexOf('run-worker.ps1', $ci) -ge 0 } | ForEach-Object { Kill-Tree $_.ProcessId }
Get-Workers | ForEach-Object { Kill-Tree $_.ProcessId }
if ($env:SPOT_STOP_MODELS -eq '1') { Get-Process -Name 'ollama','ollama app' | Stop-Process -Force }
# Wait (up to ~40 s) until no browser or worker is left, killing whatever shows up again.
for ($i = 0; $i -lt 40; $i++) {
  $left = @(Get-Browsers) + @(Get-Workers)
  if (-not $left.Count) { break }
  $left | ForEach-Object { Kill-Tree $_.ProcessId }
  Start-Sleep 1
}
if (@(Get-Browsers).Count -or @(Get-Workers).Count) { Write-Output 'STILL_RUNNING' } else { Write-Output 'STOPPED' }`,
          { SPOT_CHROME: ctx.chrome, SPOT_OLD: from, SPOT_STOP_MODELS: models ? "1" : "0" });
        if (!dry && !/STOPPED/.test(String(out)) ) throw new Error(STILL_CLOSING);
      } else if (mac) {
        if (!dry) {
          await sh("launchctl", ["bootout", `${gui}/com.spotsolutions.worker`]);
          if (models) await sh("launchctl", ["bootout", `${gui}/com.spotsolutions.ollama`]);
        } else D("launchctl bootout worker");
        await killBrowsersOn(from);
      } else {
        if (!dry) { await sh("systemctl", ["stop", "spot-worker"]); if (models) await sh("systemctl", ["stop", "ollama"]); } else D("systemctl stop spot-worker");
        await killBrowsersOn(from);
      }
    },

    async prepare({ target, models }) {
      makeFolder(target, { platform: win ? "win32" : process.platform });
      if (models) makeFolder(models, { platform: win ? "win32" : process.platform });
      if (win) {
        if (!dry) {
          // Only SYSTEM and Administrators (by well-known SID, so it works in any language), inherited by everything copied in.
          await sh("icacls.exe", [target, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { strict: true });
          // Browser profiles nest deeper than 260 characters.
          await sh("reg.exe", ["add", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem", "/v", "LongPathsEnabled", "/t", "REG_DWORD", "/d", "1", "/f"]);
        } else D("icacls + LongPathsEnabled");
      } else {
        try { chmodSync(target, 0o700); } catch { /* not ours to change */ }
        if (!win && !mac && process.getuid?.() === 0 && !dry) {
          const spot = await idOf("spot");
          await sh("chown", [`${spot.uid}:${spot.gid}`, target], { strict: true });
        }
      }
    },

    async persist({ from, to, modelsFrom, modelsTo }) {
      writeEnvPaths(ctx, from, to, modelsFrom, modelsTo);
      writePointer(ctx.stateDir, "data-dir", to);
      if (modelsTo) writePointer(ctx.stateDir, "models-dir", modelsTo);
      if (win) {
        if (dry) return D("rewrite launchers, OLLAMA_MODELS");
        for (const f of ["run-worker.ps1", "run-console.ps1"]) {
          const file = path.win32.join(ctx.root, f);
          if (!existsSync(file)) continue;
          let t = readFileSync(file, "utf8");
          t = replacePaths(t, from, to, "win32");
          if (modelsFrom && modelsTo) t = replacePaths(t, modelsFrom, modelsTo, "win32");
          writeFileSync(file, t, "utf8"); // a leading BOM (PowerShell 5 needs it for non-ASCII paths) is part of t and survives
        }
        if (modelsTo) await ps("[Environment]::SetEnvironmentVariable('OLLAMA_MODELS', $env:SPOT_MODELS_NEW, 'Machine')", { SPOT_MODELS_NEW: modelsTo });
      } else if (mac) {
        if (dry) return D("spotctl apply");
        if (existsSync(ctl)) await sh("/bin/bash", [ctl, "apply"], { strict: true });
      } else {
        if (dry) return D("write systemd drop-ins");
        const q = (v) => `"${v.replace(/"/g, "")}"`;
        const dropin = (unit, text) => { const d = `/etc/systemd/system/${unit}.service.d`; mkdirSync(d, { recursive: true }); writeFileSync(`${d}/data.conf`, text); };
        dropin("spot-console", `[Service]\nEnvironment=${q(`SPOT_DATA_DIR=${to}`)}\n${modelsTo ? `Environment=${q(`OLLAMA_MODELS=${modelsTo}`)}\n` : ""}`);
        dropin("spot-worker", `[Unit]\nConditionPathExists=\nConditionPathExists=${to}/service-account.json\n`);
        if (modelsTo) {
          const d = "/etc/systemd/system/ollama.service.d";
          mkdirSync(d, { recursive: true });
          writeFileSync(`${d}/models.conf`, `[Service]\nEnvironment=${q(`OLLAMA_MODELS=${modelsTo}`)}\n`);
          const ol = await idOf("ollama").catch(() => null);
          if (ol?.uid) await sh("chown", ["-R", `${ol.uid}:${ol.gid}`, modelsTo]);
        }
        await sh("systemctl", ["daemon-reload"], { strict: true });
      }
    },

    async start({ models }) {
      if (dry) return D("start worker and restart console");
      if (win) {
        await ps(`
$ErrorActionPreference = 'SilentlyContinue'
Start-ScheduledTask -TaskName SpotSolutionsWorker
# The console's launcher loop keeps the old environment, so restart the whole task to pick up the new folder.
Stop-ScheduledTask -TaskName SpotSolutionsConsole
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*SpotSolutions*console*server.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep 2
Start-ScheduledTask -TaskName SpotSolutionsConsole`);
      } else if (mac) {
        if (existsSync(ctl)) await sh("/bin/bash", [ctl, "restart", "all"], { strict: true });
      } else {
        if (models) await sh("systemctl", ["start", "ollama"]);
        await sh("systemctl", ["restart", "spot-worker"]);
        await sh("systemctl", ["restart", "spot-console"]);
      }
    },
  };
}

// ---------- command line (what the task runners call) ----------
function writeProgress(ctx, files, o, chown = null) {
  for (const dir of files) {
    try {
      if (!existsSync(dir)) continue; // never create a folder just to report progress: the new folder must still be empty when it is checked
      const p = path.join(dir, "update.json");
      const cur = readJson(p) ?? {};
      const err = o.error ?? null;
      writeFileSync(p, JSON.stringify({ state: o.done ? (err ? "error" : "done") : "running", step: o.step ?? null, error: err, from: cur.from ?? null, to: null, startedAt: cur.startedAt ?? Date.now(), updatedAt: Date.now(), task: cur.task ?? "move-data" }));
      if (chown) lchownSync(p, chown.uid, chown.gid); // written as root, but read and rewritten by the console's user
    } catch { /* the folder may not exist yet */ }
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const task = argv[0];
  if (task !== "move-data" && task !== "move-cleanup") throw new Error("usage: move.mjs move-data|move-cleanup");
  const ctx = contextFor(process.platform, env);
  const dry = env.SPOT_MOVE_DRY_RUN === "1";
  const request = readJson(path.join(ctx.current, "task.json")) ?? {};
  const run = async (cmd, args) => (await exec(cmd, args, { timeout: 20_000 })).stdout;
  let chown = null;
  if (ctx.platform === "linux" && process.getuid?.() === 0 && !dry) {
    const [u, g] = await Promise.all([exec("id", ["-u", "spot"]), exec("id", ["-g", "spot"])]);
    chown = { uid: Number(u.stdout), gid: Number(g.stdout) };
  }
  if (task === "move-data") {
    // Never trust the request: it only supplies a path and a yes/no. Everything else comes from this machine.
    if (request.task !== "move-data" || typeof request.target !== "string") throw new Error("No move was requested.");
    const dirs = () => [ctx.current, readState(ctx).target].filter(Boolean);
    const res = await runMove({
      ctx, request: { target: request.target, models: request.models === true },
      ops: makeOps(ctx, { dry }), io: realIo(ctx, { run, chown, dry }),
      report: (o) => writeProgress(ctx, [...new Set(dirs())], o, chown),
    });
    return res.ok ? 0 : 1;
  }
  const res = await runCleanup({ ctx, io: realIo(ctx, { run, chown, dry }), report: (o) => writeProgress(ctx, [ctx.current], o, chown) });
  return res.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((c) => process.exit(c), (e) => { console.error(`move: ${e.message}`); process.exit(1); });
}
