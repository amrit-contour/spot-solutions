// "Stop server" and "Start server" in the console: stop WhatsApp cleanly and keep it stopped, then start it again.
//
// "Stopped" is remembered as NBS_WORKER_STOPPED=1 in the worker's .env (and NBS_MODEL_STOPPED=1 when the local model was
// stopped too). Everything that could start the worker on its own respects it: the Windows launcher loop, the launchd agent's
// wrapper, systemd (the unit is disabled), the updaters (nbsctl, update-core.ps1) and the data move (move.mjs). So a stopped
// server stays stopped across restarts of this console, updates and reboots, until Start.
//
// Per platform, a stop is: graceful first (the worker uploads each WhatsApp login to the vault and releases its lease on
// SIGTERM, or on seeing the flag on Windows), wait up to GRACE_MS, then force. The Windows force is move.mjs's WIN_STOP_SCRIPT.
// Everything outside this file is injected (run, active, env access, sleep), so tests drive it with fakes.
import { WIN_STOP_SCRIPT, winStopped, browserPidsOn } from "./move.mjs";

export const GRACE_MS = 30_000;
const POLL_MS = 1000;
export const WIN_TASK = "NothingBotServerWorker";
export const MAC_LABELS = { worker: "app.nothingbot.server.worker", ollama: "app.nothingbot.server.ollama" };
export const LINUX_UNITS = { worker: "nothing-bot-server-worker", ollama: "ollama" };
const NEEDS_UPDATE = "This server needs one update before it can be stopped or started from here. Run the install command again, then try again.";

const truthy = (v) => /^(1|true|yes)$/i.test(String(v ?? "").trim());
/** The owner stopped the server (from the console's env map). */
export const isStopped = (env) => truthy(env?.NBS_WORKER_STOPPED);
/** The local model was stopped together with the server. */
export const modelStopped = (env) => truthy(env?.NBS_MODEL_STOPPED);

/**
 * What the page shows. "stopped" and "stopping" follow the owner's flag; otherwise the worker is "running", "starting"
 * (Start was pressed a moment ago) or "down" (it should be running and isn't: the existing warning).
 */
export function workerState({ stopped, active, starting }) {
  if (stopped) return active ? "stopping" : "stopped";
  if (active) return "running";
  return starting ? "starting" : "down";
}

/** Every platform command, as plain data: [command, args]. */
export function commands(platform, { uid = 0, home = "" } = {}) {
  if (platform === "darwin") {
    const gui = `gui/${uid}`;
    return {
      disable: (svc) => ["launchctl", ["disable", `${gui}/${MAC_LABELS[svc]}`]],
      enable: (svc) => ["launchctl", ["enable", `${gui}/${MAC_LABELS[svc]}`]],
      bootout: (svc) => ["launchctl", ["bootout", `${gui}/${MAC_LABELS[svc]}`]], // SIGTERM, then launchd waits ExitTimeOut
      kill9: (svc) => ["launchctl", ["kill", "SIGKILL", `${gui}/${MAC_LABELS[svc]}`]],
      loaded: (svc) => ["launchctl", ["print", `${gui}/${MAC_LABELS[svc]}`]],
      bootstrap: (svc) => ["launchctl", ["bootstrap", gui, `${home}/Library/LaunchAgents/${MAC_LABELS[svc]}.plist`]],
      kickstart: (svc) => ["launchctl", ["kickstart", `${gui}/${MAC_LABELS[svc]}`]],
    };
  }
  if (platform === "win32") {
    const ps = (script) => ["powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]];
    return {
      // Waits (up to `seconds`) for the worker's node process to go by itself.
      waitGone: (seconds) => ps(`$ErrorActionPreference='SilentlyContinue'; for ($i=0; $i -lt ${seconds | 0}; $i++) { $w = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*NothingBotServer*src*index.ts*' }); if (-not $w.Count) { break }; Start-Sleep 1 }; Write-Output 'DONE'`),
      force: () => ps(WIN_STOP_SCRIPT),
      disableTask: () => ps(`Disable-ScheduledTask -TaskName ${WIN_TASK} -ErrorAction SilentlyContinue | Out-Null`),
      enableAndStart: () => ps(`$ErrorActionPreference='SilentlyContinue'; Enable-ScheduledTask -TaskName ${WIN_TASK} | Out-Null; if ((Get-ScheduledTask -TaskName ${WIN_TASK}).State -ne 'Running') { Start-ScheduledTask -TaskName ${WIN_TASK} }; Write-Output 'DONE'`),
    };
  }
  const sudo = (...a) => ["sudo", ["-n", "/usr/bin/systemctl", ...a]];
  return {
    // `disable --now` stops the unit (SIGTERM, then systemd waits TimeoutStopSec) and keeps it off after a reboot.
    disableNow: (svc) => sudo("disable", "--now", LINUX_UNITS[svc]),
    enableNow: (svc) => sudo("enable", "--now", LINUX_UNITS[svc]),
    kill9: (svc) => sudo("kill", "--signal=SIGKILL", LINUX_UNITS[svc]),
  };
}

/**
 * run(cmd, args, { timeout, env }) -> { ok, out } (never throws); active("worker") -> is it running right now;
 * readEnv() / writeEnv(patch) work on the worker's .env; killPid(pid) removes macOS browser leftovers.
 */
export function createWorkerControl({ platform, uid = 0, home = "", dataDir = "", chromeDir = "", run, active, readEnv, writeEnv, killPid = (pid) => process.kill(pid, "SIGKILL"), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, graceMs = GRACE_MS, dry = false }) {
  const win = platform === "win32", mac = platform === "darwin";
  const cmd = commands(platform, { uid, home });
  const go = (c, o) => run(c[0], c[1], o);
  let startedAt = 0, busy = null;

  async function view() {
    const env = readEnv();
    const stopped = isStopped(env);
    const a = await active("worker");
    return { state: workerState({ stopped, active: a, starting: now() - startedAt < 120_000 }), stopped, modelStopped: modelStopped(env), busy: busy ?? null };
  }

  // Polls until the worker is gone or `ms` has passed. True when it is gone.
  async function waitInactive(ms) {
    for (let waited = 0; ; waited += POLL_MS) {
      if (!(await active("worker"))) return true;
      if (waited >= ms) return false;
      await sleep(POLL_MS);
    }
  }

  async function sweepMacBrowsers() {
    if (!dataDir) return;
    for (let i = 0; i < 10; i++) {
      const r = await run("ps", ["-axo", "pid=,ppid=,command="], { timeout: 5000 });
      const pids = browserPidsOn(r.out ?? "", dataDir);
      if (!pids.length) return;
      for (const pid of pids) { try { killPid(pid); } catch { /* gone */ } }
      await sleep(500);
    }
  }

  async function stop({ models = false } = {}) {
    // The flag first: from this moment nothing (launcher loop, updater, a move) brings the worker back, and on Windows the worker
    // sees it and shuts itself down properly.
    writeEnv({ NBS_WORKER_STOPPED: "1", NBS_MODEL_STOPPED: models ? "1" : "0" });
    if (dry) return;
    const undo = (msg) => { writeEnv({ NBS_WORKER_STOPPED: "0", NBS_MODEL_STOPPED: "0" }); throw new Error(msg); };
    if (win) {
      await go(cmd.waitGone(Math.ceil(graceMs / 1000)), { timeout: graceMs + 15_000 });
      const r = await go(cmd.force(), { timeout: 90_000, env: { NBS_OLD: dataDir, NBS_CHROME: chromeDir, NBS_STOP_MODELS: models ? "1" : "0" } });
      if (!winStopped(r.out)) throw new Error("The server didn't stop in time. Something is still holding WhatsApp open: try again.");
      await go(cmd.disableTask(), { timeout: 20_000 });
      return;
    }
    if (mac) {
      await go(cmd.disable("worker"));
      const unloaded = go(cmd.bootout("worker"), { timeout: 120_000 }); // SIGTERM: the worker uploads its logins and lets go of its lease
      if (!(await waitInactive(graceMs))) await go(cmd.kill9("worker"));
      await unloaded;
      await sweepMacBrowsers();
      if (models) { await go(cmd.disable("ollama")); await go(cmd.bootout("ollama"), { timeout: 30_000 }); }
      return;
    }
    const stopping = go(cmd.disableNow("worker"), { timeout: 120_000 });
    if (!(await waitInactive(graceMs))) await go(cmd.kill9("worker"));
    const r = await stopping;
    if (!r.ok) undo(NEEDS_UPDATE); // sudo refused: the sudoers rule is from before this feature
    if (models) await go(cmd.disableNow("ollama"), { timeout: 60_000 });
  }

  async function start() {
    const withModel = modelStopped(readEnv());
    writeEnv({ NBS_WORKER_STOPPED: "0", NBS_MODEL_STOPPED: "0" });
    startedAt = now();
    if (dry) return;
    if (win) {
      const r = await go(cmd.enableAndStart(), { timeout: 30_000 });
      if (r.ok === false) throw new Error("Couldn't start the server. Try again, or restart this computer.");
      return; // the launcher loop starts Ollama (when wanted) and then the worker
    }
    if (mac) {
      for (const svc of withModel ? ["ollama", "worker"] : ["worker"]) {
        await go(cmd.enable(svc));
        if (!(await go(cmd.loaded(svc))).ok && !(await go(cmd.bootstrap(svc))).ok) throw new Error("Couldn't start the server. Open Nothing BOT Server, choose More, Update Nothing BOT Server, then try again.");
        await go(cmd.kickstart(svc));
      }
      return;
    }
    if (withModel) await go(cmd.enableNow("ollama"), { timeout: 60_000 });
    if (!(await go(cmd.enableNow("worker"), { timeout: 60_000 })).ok) {
      writeEnv({ NBS_WORKER_STOPPED: "1", NBS_MODEL_STOPPED: withModel ? "1" : "0" });
      throw new Error(NEEDS_UPDATE);
    }
  }

  /** One stop or start at a time. Returns the new state. */
  async function act(action, opts = {}) {
    if (busy) throw new Error(`The server is already ${busy === "stop" ? "stopping" : "starting"}. Give it a moment.`);
    busy = action;
    try {
      if (action === "stop") await stop(opts);
      else await start();
    } finally { busy = null; }
    return view();
  }

  return { view, act };
}
