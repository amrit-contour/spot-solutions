// Updates for this server: what's the latest release, is this one older, and start the platform's updater.
// The updaters themselves (nbsctl on macOS and Ubuntu, update.ps1 on Windows) do the download, the sha256
// check, the file swap and the restarts, outside this process so they survive restarting it. The same runners also do
// "move-data" and "move-cleanup" (move.mjs; the request, a folder path, rides in task.json). They report progress
// in DATA/update.json, which the page shows.
import "./envcompat.mjs";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statfsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const DIST_BASE = process.env.NBS_DIST_URL ?? "https://nothingbotcurating.web.app";
export const CHECK_EVERY_MS = 30 * 60_000;
const FIRST_CHECK_MS = 45_000;
/** After a failed update, automatic updates wait this long (a manual Update now still works). */
const FAILURE_BACKOFF_MS = 6 * 3_600_000;
const STALE_RUNNING_MS = 60 * 60_000;
/** A task still at "Starting" this long was never picked up by the platform's task runner. */
const STALE_START_MS = 5 * 60_000;
/** Servers in one fleet shouldn't all restart at once: each waits a stable 0 to 10 minutes after it first sees a release. */
const STAGGER_MAX_MS = 10 * 60_000;

/** A release as published in dl/nothing-bot-server.json, or null if it isn't one. */
export function parseLatest(j) {
  if (!j || typeof j !== "object") return null;
  const version = typeof j.version === "string" ? j.version.trim() : "";
  const sha256 = typeof j.sha256 === "string" ? j.sha256.trim().toLowerCase() : "";
  if (!/^[0-9a-zA-Z._-]{1,40}$/.test(version) || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  return {
    version,
    sha256,
    builtAt: typeof j.builtAt === "number" ? j.builtAt : null,
    size: typeof j.size === "number" ? j.size : null,
    model: typeof j.model === "string" && /^[A-Za-z0-9._:/-]{1,100}$/.test(j.model) ? j.model : null,
  };
}

/** Releases are commit ids, which have no order, so "newer" means "different". A development copy never updates itself. */
export const isUpdateAvailable = (current, latest) => Boolean(latest) && current !== "dev" && current !== "none" && latest.version !== current;

export function staggerMs(hostname) {
  const h = createHash("sha256").update(String(hostname)).digest();
  return ((h[0] << 8) | h[1]) % STAGGER_MAX_MS;
}

export function createUpdater({ version, data, hostname, platform, uid, macRoot, dryRun = false, fetchImpl = fetch, now = Date.now, log = console.log }) {
  const settingsFile = path.join(data, "console.json");
  const progressFile = path.join(data, "update.json");
  const taskFile = path.join(data, "task.json");
  const WIN = platform === "win32";
  const MAC = platform === "darwin";

  const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return {}; } };
  const settings = () => ({ autoUpdate: true, ...readJson(settingsFile) });
  const saveSettings = (patch) => { try { mkdirSync(data, { recursive: true }); writeFileSync(settingsFile, JSON.stringify({ ...readJson(settingsFile), ...patch })); } catch (e) { log(`[update] couldn't save settings: ${e.message}`); } };

  let latest = null, checkedAt = 0, checkError = null, detectedAt = 0, starting = false;

  async function check() {
    try {
      const r = await fetchImpl(`${DIST_BASE}/dl/nothing-bot-server.json?t=${now()}`, { signal: AbortSignal.timeout(15_000), headers: { "cache-control": "no-cache" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const parsed = parseLatest(await r.json());
      if (!parsed) throw new Error("not a release file");
      if (parsed.version !== latest?.version) detectedAt = now();
      latest = parsed;
      checkError = null;
    } catch (e) {
      checkError = e.message;
    }
    checkedAt = now();
    return latest;
  }

  /** What the updater script last reported. A run that stopped reporting long ago is treated as failed. */
  function progress() {
    const p = readJson(progressFile);
    if (p.state === "running" && now() - (p.updatedAt ?? p.startedAt ?? 0) > STALE_RUNNING_MS) return { ...p, state: "error", error: "The update stopped without finishing. Try again." };
    if (p.state === "running" && p.step === "Starting" && now() - (p.updatedAt ?? p.startedAt ?? 0) > STALE_START_MS) return { ...p, state: "error", error: "The task never started on this computer. Try again; if it keeps happening, run the installer again." };
    return p;
  }
  const running = () => starting || progress().state === "running";

  function view() {
    const s = settings(), p = progress();
    return {
      current: version,
      latest,
      checkedAt,
      checkError,
      available: isUpdateAvailable(version, latest),
      autoUpdate: s.autoUpdate !== false,
      dev: version === "dev" || version === "none",
      running: running(),
      progress: p.state ? { task: p.task ?? "update", state: p.state, step: p.step ?? null, error: p.error ?? null, from: p.from ?? null, to: p.to ?? null } : null,
    };
  }

  /** Hand the job to the platform's updater. It runs on its own, then restarts the worker and this console. */
  async function start({ by = "console", task = "update", extra = null } = {}) {
    if (running()) return { ok: true, already: true };
    if (task === "update" && (version === "dev" || version === "none")) throw new Error("This is a development copy. Update it with git.");
    // An update unpacks a new copy and may reinstall packages; on a nearly full disk that can leave WhatsApp
    // unable to save its login. Refuse below 2 GB free and say why.
    if (task === "update") {
      try {
        const st = statfsSync(data);
        const free = Number(st.bavail) * Number(st.bsize);
        if (free < 2 * 1024 ** 3) throw Object.assign(new Error(`Not enough free disk space to update safely (${(free / 1024 ** 3).toFixed(1)} GB free, needs 2 GB). Free up space, then try again.`), { lowDisk: true });
      } catch (e) {
        if (e && e.lowDisk) throw e;
      }
    }
    starting = true;
    try {
      mkdirSync(data, { recursive: true });
      writeFileSync(progressFile, JSON.stringify({ state: "running", step: "Starting", from: version, to: latest?.version ?? null, startedAt: now(), task }));
      writeFileSync(taskFile, JSON.stringify({ ...(extra ?? {}), task, by, at: now() }));
      log(`[update] ${task} started by ${by}`);
      await launch(task);
      return { ok: true };
    } catch (e) {
      writeFileSync(progressFile, JSON.stringify({ state: "error", error: e.message, from: version, startedAt: now() }));
      saveSettings({ lastFailure: now() });
      throw e;
    } finally {
      setTimeout(() => (starting = false), 5000);
    }
  }

  async function launch(task) {
    if (dryRun) { // tests: pretend the updater ran and finished
      setTimeout(() => writeFileSync(progressFile, JSON.stringify({ state: "done", from: version, to: latest?.version ?? null, startedAt: now(), task })), 4000).unref?.();
      return;
    }
    if (MAC) {
      const label = `gui/${uid}/app.nothingbot.server.update`;
      let loaded = true;
      try { await exec("launchctl", ["print", label], { timeout: 5000 }); } catch { loaded = false; }
      if (loaded) { await exec("launchctl", ["kickstart", label], { timeout: 15000 }); return; }
      const ctl = path.join(macRoot, "nbsctl");
      if (!existsSync(ctl)) throw new Error("This Mac needs one manual update first: open Nothing BOT Server and choose More, Update Nothing BOT Server. After that, updates work from here.");
      // Its own session, so launchd restarting this console doesn't take the updater with it.
      spawn("/bin/bash", [ctl, "task", task], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    if (WIN) {
      try { await exec("schtasks.exe", ["/run", "/tn", "NothingBotServerUpdate"], { timeout: 15000 }); }
      catch { throw new Error("This PC needs one manual update first: run the Nothing BOT Server installer again. After that, updates work from here."); }
      return;
    }
    try { await exec("sudo", ["-n", "/usr/bin/systemctl", "start", "--no-block", `nothing-bot-server-task@${task}.service`], { timeout: 15000 }); }
    catch { throw new Error("This server needs one manual update first: run the install command again. After that, updates work from here."); }
  }

  // ---- automatic updates ----
  let autoTimer = null;
  async function autoTick() {
    if (now() - checkedAt >= CHECK_EVERY_MS - 1000) await check();
    const s = settings(), v = view();
    if (!v.available || !s.autoUpdate || v.running) return;
    if (now() - (s.lastFailure ?? 0) < FAILURE_BACKOFF_MS) return;
    if (now() - detectedAt < staggerMs(hostname)) return; // not our turn yet; the next tick (or a shorter wait below) tries again
    try { await start({ by: "automatic" }); } catch (e) { log(`[update] automatic update failed to start: ${e.message}`); }
  }
  function schedule() {
    clearTimeout(autoTimer);
    // While a release is waiting for this server's turn, look again every minute (no network: the check itself is every 30 min).
    autoTimer = setTimeout(async () => { await autoTick().catch(() => undefined); schedule(); }, isUpdateAvailable(version, latest) && !running() ? 60_000 : CHECK_EVERY_MS);
    autoTimer.unref?.();
  }
  function begin() {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(async () => { await autoTick().catch(() => undefined); schedule(); }, FIRST_CHECK_MS);
    autoTimer.unref?.();
  }

  // A finished update leaves its mark: record success/failure so automatic updates back off after failures.
  const p0 = progress();
  if (p0.state === "error") saveSettings({ lastFailure: p0.startedAt ?? now() });
  if (p0.state === "done" && settings().lastFailure) saveSettings({ lastFailure: 0 });

  return { check, view, start, begin, setAuto: (on) => saveSettings({ autoUpdate: Boolean(on) }), progress };
}
