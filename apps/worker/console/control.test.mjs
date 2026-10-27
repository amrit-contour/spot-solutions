import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commands, createWorkerControl, isStopped, modelStopped, modelState, workerState, UNMANAGED, WIN_MODEL_STOP_SCRIPT, LINUX_UNITS, MAC_LABELS } from "./control.mjs";
import { WIN_STOP_SCRIPT, workerStopped, contextFor } from "./move.mjs";

const REPO = path.join(import.meta.dirname, "..", "..", "..");
const text = (...p) => readFileSync(path.join(REPO, ...p), "utf8");

/** A fake machine: records every command, answers from a script, and keeps an in-memory .env. */
function rig(platform, { activeUntil = 0, fail = () => false, out = {}, managed = true, env0 = {} } = {}) {
  const calls = [], env = { ...env0 };
  let t = 0, polls = 0;
  const ctl = createWorkerControl({
    platform, uid: 501, home: "/Users/me", dataDir: "/data", chromeDir: "C:\\chrome",
    run: async (cmd, args, o) => { const line = [cmd, ...args].join(" "); calls.push({ line, o }); return { ok: !fail(line), out: Object.entries(out).find(([k]) => line.includes(k))?.[1] ?? "" }; },
    // the worker stays up for `activeUntil` polls (a slow shutdown), then is gone
    active: async () => { calls.push({ line: "active?" }); return ++polls <= activeUntil; },
    readEnv: () => ({ ...env }),
    writeEnv: (p) => Object.assign(env, p),
    sleep: async (ms) => { t += ms; },
    now: () => t,
    graceMs: 30_000,
    killPid: () => {}, ollamaExe: "C:\\ollama.exe", modelManaged: () => managed,
  });
  return { ctl, calls, env, lines: () => calls.filter((c) => c.line !== "active?").map((c) => c.line) };
}

describe("the stopped flag", () => {
  it("reads NBS_WORKER_STOPPED and NBS_MODEL_STOPPED", () => {
    expect(isStopped({ NBS_WORKER_STOPPED: "1" })).toBe(true);
    expect(isStopped({ NBS_WORKER_STOPPED: "true" })).toBe(true);
    expect(isStopped({ NBS_WORKER_STOPPED: "0" })).toBe(false);
    expect(isStopped({})).toBe(false);
    expect(modelStopped({ NBS_MODEL_STOPPED: "1" })).toBe(true);
    expect(modelStopped({})).toBe(false);
  });
  it("shows running, stopping, stopped, starting or down", () => {
    expect(workerState({ stopped: false, active: true, starting: false })).toBe("running");
    expect(workerState({ stopped: false, active: false, starting: true })).toBe("starting");
    expect(workerState({ stopped: false, active: false, starting: false })).toBe("down");
    expect(workerState({ stopped: true, active: true, starting: false })).toBe("stopping");
    expect(workerState({ stopped: true, active: false, starting: true })).toBe("stopped"); // a stop beats a stale start
  });
  it("is what a data move honours (move.mjs reads the same .env)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nbs-ctl-"));
    const ctx = { ...contextFor("linux", {}), envFile: path.join(dir, ".env") };
    expect(workerStopped(ctx)).toBe(false);
    writeFileSync(ctx.envFile, "A=1\nNBS_WORKER_STOPPED=1\n");
    expect(workerStopped(ctx)).toBe(true);
    writeFileSync(ctx.envFile, "NBS_WORKER_STOPPED=0\r\n");
    expect(workerStopped(ctx)).toBe(false);
  });
});

describe("platform command builders", () => {
  it("macOS: launchd in this user's GUI domain", () => {
    const c = commands("darwin", { uid: 501, home: "/Users/me" });
    expect(c.disable("worker")).toEqual(["launchctl", ["disable", `gui/501/${MAC_LABELS.worker}`]]);
    expect(c.bootout("ollama")[1]).toEqual(["bootout", `gui/501/${MAC_LABELS.ollama}`]);
    expect(c.kill9("worker")[1]).toEqual(["kill", "SIGKILL", `gui/501/${MAC_LABELS.worker}`]);
    expect(c.bootstrap("worker")[1]).toEqual(["bootstrap", "gui/501", `/Users/me/Library/LaunchAgents/${MAC_LABELS.worker}.plist`]);
  });
  it("Ubuntu: only the exact sudo systemctl commands the sudoers rule allows", () => {
    const c = commands("linux");
    expect(c.disableNow("worker")).toEqual(["sudo", ["-n", "/usr/bin/systemctl", "disable", "--now", "nothing-bot-server-worker"]]);
    expect(c.enableNow("ollama")[1].slice(2)).toEqual(["enable", "--now", "ollama"]);
    expect(c.kill9("worker")[1].slice(2)).toEqual(["kill", "--signal=SIGKILL", "nothing-bot-server-worker"]);
    for (const [, args] of [c.disableNow("worker"), c.enableNow("worker"), c.kill9("worker"), c.disableNow("ollama"), c.enableNow("ollama")]) {
      const rule = `/usr/bin/systemctl ${args.slice(2).join(" ")}`;
      expect(text("deploy", "ubuntu", "nbsctl")).toContain(rule);
      expect(text("deploy", "install.sh")).toContain(rule);
    }
  });
  it("Windows: the shared stop script, the task and PowerShell", () => {
    const c = commands("win32");
    expect(c.force()[1].at(-1)).toBe(WIN_STOP_SCRIPT);
    expect(WIN_STOP_SCRIPT).toContain("taskkill.exe /PID $id /T /F");
    expect(WIN_STOP_SCRIPT).toContain("run-worker.ps1");
    expect(WIN_STOP_SCRIPT).toContain("$old -and"); // an empty folder must not match every process
    expect(c.disableTask()[1].at(-1)).toContain("Disable-ScheduledTask -TaskName NothingBotServerWorker");
    expect(c.enableAndStart()[1].at(-1)).toContain("Start-ScheduledTask -TaskName NothingBotServerWorker");
    expect(c.waitGone(30)[1].at(-1)).toContain("-lt 30");
  });
  it("the launchers and updaters all look at the flag", () => {
    expect(text("deploy", "windows", "install.ps1")).toContain("NBS_WORKER_STOPPED");
    expect(text("deploy", "windows", "update-core.ps1")).toContain("function Start-Worker");
    expect(text("deploy", "windows", "update-core.ps1").match(/Start-ScheduledTask -TaskName \$WorkerTask/g)).toHaveLength(1); // only inside Start-Worker
    expect(text("deploy", "mac", "nbsctl")).toContain("worker_stopped");
    expect(text("deploy", "windows", "install.ps1")).toContain("NBS_MODEL_STOPPED");
    expect(text("deploy", "windows", "install.ps1")).toContain("-not (No-Local) -and -not (Model-Stopped)) {");
    // OLLAMA_MODELS is read from the models-dir pointer each time Ollama starts, never baked in; a wrong-folder Ollama is restarted.
    for (const f of ["install.ps1", "update-core.ps1"]) {
      const s = text("deploy", "windows", f);
      expect(s).toContain("function Models-Dir");
      expect(s).toContain("Ollama-Wrong");
      expect(s).toContain("'ollama app'");
    }
    expect(text("deploy", "windows", "install.ps1")).not.toMatch(/^\$env:OLLAMA_MODELS = '__MODELS__'/m);
    expect(text("deploy", "windows", "update-core.ps1")).toContain("function Test-OllamaWrongFolder");
    expect(text("deploy", "windows", "update-core.ps1")).toContain("NBS_MODEL_STOPPED"); // Update-Launcher patches old launchers
    expect(text("deploy", "windows", "update-core.ps1")).toContain("function Test-ModelStopped");
    expect(text("deploy", "mac", "nbsctl")).toContain("model_stopped");
    expect(text("deploy", "ubuntu", "nbsctl")).toContain("model_stopped");
    expect(text("deploy", "install.sh")).toContain("NBS_MODEL_STOPPED");
    expect(text("deploy", "ubuntu", "nbsctl")).not.toContain("sysctl_ restart nothing-bot-server-worker || true\n");
    expect(LINUX_UNITS.worker).toBe("nothing-bot-server-worker");
  });
});

describe("stop and start", () => {
  it("Ubuntu: disables the unit, waits for a clean exit, never forces a worker that left in time", async () => {
    const r = rig("linux", { activeUntil: 3 });
    const v = await r.ctl.act("stop");
    expect(r.lines()).toEqual(["sudo -n /usr/bin/systemctl disable --now nothing-bot-server-worker"]);
    expect(r.env).toEqual({ NBS_WORKER_STOPPED: "1" }); // the model flag is left alone
    expect(v.state).toBe("stopped");
  });
  it("Ubuntu: forces after about 30 s", async () => {
    const r = rig("linux", { activeUntil: 1000 });
    await r.ctl.act("stop", { models: true });
    const l = r.lines();
    expect(l[0]).toContain("disable --now nothing-bot-server-worker");
    expect(l).toContain("sudo -n /usr/bin/systemctl kill --signal=SIGKILL nothing-bot-server-worker");
    expect(l.at(-1)).toContain("disable --now ollama");
    expect(r.env.NBS_MODEL_STOPPED).toBe("1");
    expect(r.calls.filter((c) => c.line === "active?").length).toBeGreaterThan(29);
  });
  it("Ubuntu: an old sudoers rule undoes the stop and says what to do", async () => {
    const r = rig("linux", { fail: (l) => l.includes("disable --now") });
    await expect(r.ctl.act("stop")).rejects.toThrow(/needs one update/);
    expect(r.env.NBS_WORKER_STOPPED).toBe("0");
    expect((await r.ctl.view()).stopped).toBe(false);
  });
  it("Ubuntu: Start re-enables the worker, and Ollama if the stop took it down", async () => {
    const r = rig("linux", { activeUntil: 0 });
    await r.ctl.act("stop", { models: true });
    r.calls.length = 0;
    await r.ctl.act("start");
    expect(r.lines()).toEqual(["sudo -n /usr/bin/systemctl enable --now ollama", "sudo -n /usr/bin/systemctl enable --now nothing-bot-server-worker"]);
    expect(r.env).toMatchObject({ NBS_WORKER_STOPPED: "0", NBS_MODEL_STOPPED: "0" });
  });
  it("macOS: disable, unload (SIGTERM), force only if needed, optional Ollama", async () => {
    const r = rig("darwin", { activeUntil: 0, out: { "ps -axo": "" } });
    await r.ctl.act("stop", { models: true });
    expect(r.lines().filter((l) => l.startsWith("launchctl"))).toEqual([
      `launchctl disable gui/501/${MAC_LABELS.worker}`, `launchctl bootout gui/501/${MAC_LABELS.worker}`,
      `launchctl disable gui/501/${MAC_LABELS.ollama}`, `launchctl bootout gui/501/${MAC_LABELS.ollama}`,
    ]);
    const slow = rig("darwin", { activeUntil: 1000 });
    await slow.ctl.act("stop");
    expect(slow.lines()).toContain(`launchctl kill SIGKILL gui/501/${MAC_LABELS.worker}`);
  });
  it("macOS: sweeps WhatsApp's leftover browsers", async () => {
    const killed = [];
    const ctl = createWorkerControl({
      platform: "darwin", uid: 1, dataDir: "/data", run: async (cmd) => ({ ok: true, out: cmd === "ps" && !killed.length ? "10 1 /x/Chrome --user-data-dir=/data/wwebjs/s\n11 10 /x/Chrome Helper" : "" }),
      active: async () => false, readEnv: () => ({}), writeEnv: () => {}, sleep: async () => {}, killPid: (p) => killed.push(p),
    });
    await ctl.act("stop");
    expect(killed.sort()).toEqual([10, 11]);
  });
  it("macOS: Start enables, loads if needed and kicks the agent", async () => {
    const r = rig("darwin", { fail: (l) => l.startsWith("launchctl print") });
    await r.ctl.act("start");
    expect(r.lines()).toEqual([
      `launchctl enable gui/501/${MAC_LABELS.worker}`, `launchctl print gui/501/${MAC_LABELS.worker}`,
      `launchctl bootstrap gui/501 /Users/me/Library/LaunchAgents/${MAC_LABELS.worker}.plist`, `launchctl kickstart gui/501/${MAC_LABELS.worker}`,
    ]);
  });
  it("Windows: lets the worker leave by itself, then the shared force script, then disables the task", async () => {
    const r = rig("win32", { out: { "Write-Output 'STOPPED'": "STOPPED" } });
    await r.ctl.act("stop", { models: true });
    const l = r.calls.filter((c) => c.line !== "active?");
    expect(l[0].line).toContain("Start-Sleep 1"); // the grace wait
    expect(l[1].line).toContain("taskkill.exe");
    expect(l[1].o.env).toEqual({ NBS_OLD: "/data", NBS_CHROME: "C:\\chrome", NBS_STOP_MODELS: "1" });
    expect(l[2].line).toContain("Disable-ScheduledTask");
    expect(r.env.NBS_WORKER_STOPPED).toBe("1");
  });
  it("Windows: says so when something still holds WhatsApp open", async () => {
    const r = rig("win32", { out: { taskkill: "STILL_RUNNING" } });
    await expect(r.ctl.act("stop")).rejects.toThrow(/didn't stop in time/);
  });
  it("Windows: Start enables and starts the launcher task", async () => {
    const r = rig("win32");
    await r.ctl.act("start");
    expect(r.lines()).toHaveLength(1);
    expect(r.lines()[0]).toContain("Enable-ScheduledTask");
    expect((await r.ctl.view()).state).toBe("starting");
  });
  it("does one thing at a time, and a dry run only keeps the flag", async () => {
    const r = rig("linux", { activeUntil: 5 });
    const first = r.ctl.act("stop");
    await expect(r.ctl.act("start")).rejects.toThrow(/already stopping/);
    await first;
    const d = createWorkerControl({ platform: "linux", dry: true, run: async () => { throw new Error("ran"); }, active: async () => false, readEnv: () => ({ NBS_WORKER_STOPPED: "1" }), writeEnv: () => {} });
    await expect(d.act("start")).resolves.toMatchObject({ stopped: true }); // (the fake env doesn't change)
  });
});

describe("Ollama on its own (model-stop / model-start)", () => {
  it("shows running, stopping, stopped, starting or down", () => {
    expect(modelState({ stopped: false, up: true, starting: false })).toBe("running");
    expect(modelState({ stopped: false, up: false, starting: true })).toBe("starting");
    expect(modelState({ stopped: false, up: false, starting: false })).toBe("down");
    expect(modelState({ stopped: true, up: true, starting: false })).toBe("stopping");
    expect(modelState({ stopped: true, up: false, starting: true })).toBe("stopped");
  });
  it("Ubuntu: disable --now / enable --now ollama, the worker is not touched, the flag is kept", async () => {
    const r = rig("linux", { env0: { NBS_WORKER_STOPPED: "0" } });
    const v = await r.ctl.act("model-stop");
    expect(r.lines()).toEqual(["sudo -n /usr/bin/systemctl disable --now ollama"]);
    expect(r.env).toMatchObject({ NBS_MODEL_STOPPED: "1", NBS_WORKER_STOPPED: "0" });
    expect(v.model).toMatchObject({ stopped: true, managed: true });
    r.calls.length = 0;
    await r.ctl.act("model-start");
    expect(r.lines()).toEqual(["sudo -n /usr/bin/systemctl enable --now ollama"]);
    expect(r.env.NBS_MODEL_STOPPED).toBe("0");
  });
  it("Ubuntu: an old sudoers rule undoes the flag and says what to do", async () => {
    const r = rig("linux", { fail: (l) => l.includes("disable --now ollama") });
    await expect(r.ctl.act("model-stop")).rejects.toThrow(/needs one update/);
    expect(r.env.NBS_MODEL_STOPPED).toBe("0");
    const s = rig("linux", { env0: { NBS_MODEL_STOPPED: "1" }, fail: (l) => l.includes("enable --now ollama") });
    await expect(s.ctl.act("model-start")).rejects.toThrow(/needs one update/);
    expect(s.env.NBS_MODEL_STOPPED).toBe("1");
  });
  it("macOS: disable and unload, then enable, load if needed and kick", async () => {
    const r = rig("darwin");
    await r.ctl.act("model-stop");
    expect(r.lines()).toEqual([`launchctl disable gui/501/${MAC_LABELS.ollama}`, `launchctl bootout gui/501/${MAC_LABELS.ollama}`]);
    r.calls.length = 0;
    await r.ctl.act("model-start");
    expect(r.lines()).toEqual([`launchctl enable gui/501/${MAC_LABELS.ollama}`, `launchctl print gui/501/${MAC_LABELS.ollama}`, `launchctl kickstart gui/501/${MAC_LABELS.ollama}`]);
  });
  it("macOS: the user's own Ollama is not ours to stop or start", async () => {
    const r = rig("darwin", { managed: false });
    await expect(r.ctl.act("model-stop")).rejects.toThrow(UNMANAGED);
    await expect(r.ctl.act("model-start")).rejects.toThrow(/isn't managed by Nothing BOT Server/);
    expect(r.lines()).toEqual([]);
    expect(r.env.NBS_MODEL_STOPPED).toBeUndefined();
    expect((await r.ctl.view()).model.managed).toBe(false);
  });
  it("Windows: sets the flag and stops Ollama by path; Start clears it and launches Ollama", async () => {
    const r = rig("win32");
    await r.ctl.act("model-stop");
    expect(r.lines()).toEqual([expect.stringContaining("ollama app.exe")]);
    expect(WIN_MODEL_STOP_SCRIPT).toContain("ExecutablePath -like '*ollama*'");
    expect(r.env.NBS_MODEL_STOPPED).toBe("1");
    r.calls.length = 0;
    await r.ctl.act("model-start");
    expect(r.lines()[0]).toContain("Start-Process -FilePath 'C:\\ollama.exe' -ArgumentList serve");
    expect(r.env.NBS_MODEL_STOPPED).toBe("0");
    expect(commands("win32").startModel("C:\\it's\\o.exe")[1].at(-1)).toContain("'C:\\it''s\\o.exe'");
  });
  it("stopping the worker alone leaves the model flag; Stop server (models) sets it; Start with models:false leaves it", async () => {
    const r = rig("linux", { env0: { NBS_MODEL_STOPPED: "1" } });
    await r.ctl.act("stop");
    expect(r.env.NBS_MODEL_STOPPED).toBe("1"); // already stopped by the owner: untouched
    r.calls.length = 0;
    await r.ctl.act("start", { models: false });
    expect(r.lines()).toEqual(["sudo -n /usr/bin/systemctl enable --now nothing-bot-server-worker"]);
    expect(r.env).toMatchObject({ NBS_WORKER_STOPPED: "0", NBS_MODEL_STOPPED: "1" });
    const s = rig("linux");
    await s.ctl.act("stop");
    expect(s.env.NBS_MODEL_STOPPED).toBeUndefined();
    await s.ctl.act("stop", { models: true });
    expect(s.env.NBS_MODEL_STOPPED).toBe("1");
    await s.ctl.act("start", { models: true });
    expect(s.env).toMatchObject({ NBS_WORKER_STOPPED: "0", NBS_MODEL_STOPPED: "0" });
  });
  it("a worker stop that fails restores the model flag it found", async () => {
    const r = rig("linux", { env0: { NBS_MODEL_STOPPED: "1" }, fail: (l) => l.includes("disable --now") });
    await expect(r.ctl.act("stop", { models: true })).rejects.toThrow(/needs one update/);
    expect(r.env.NBS_MODEL_STOPPED).toBe("1");
  });
  it("Stop server leaves an unmanaged Ollama alone and does not set the model flag", async () => {
    const r = rig("darwin", { managed: false, out: { "ps -axo": "" } });
    await r.ctl.act("stop", { models: true });
    expect(r.lines().some((l) => l.includes("ollama"))).toBe(false);
    expect(r.env.NBS_MODEL_STOPPED).toBeUndefined();
  });
  it("the view says the model is stopped for good until Start", async () => {
    const r = rig("linux", { env0: { NBS_MODEL_STOPPED: "1" } });
    expect((await r.ctl.view()).model.state).toBe("stopped");
  });
});
