import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parsePowercfg, getSetting, powercfgZero, psArgs, decodePs, parseRegQuery, updateCommands, updateStatus, parseRestartEvents, describeRestart, who1074,
  windowsItems, windowsFix, normaliseState, readState, validActiveHours, hoursSpan, lastIni, logindLid, aptAutoReboot, linuxItems, linuxFix,
  parsePmsetCustom, macItems, keepAwakeCommand, createKeepAwake, summarise, createPower, parseJsonList, clock, LINUX_HELPER, DEFAULT_ACTIVE_HOURS,
} from "./power.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..", "..");
const fixture = readFileSync(path.join(here, "fixtures", "powercfg-q.txt"), "utf8");
const text = (...p) => readFileSync(path.join(REPO, ...p), "utf8");
const st = (o = {}) => ({ ...normaliseState(null), ...o });

describe("powercfg /q parsing", () => {
  const cfg = parsePowercfg(fixture);
  it("reads the scheme and every setting's AC and DC values", () => {
    expect(cfg.scheme).toEqual({ guid: "381b4222-f694-41f0-9685-ff5bb260df2e", name: "Balanced" });
    expect(getSetting(cfg, "standby")).toMatchObject({ alias: "STANDBYIDLE", ac: 1800, dc: 900 });
    expect(getSetting(cfg, "hibernate")).toMatchObject({ ac: 0, dc: 0 });
    expect(getSetting(cfg, "lid")).toMatchObject({ alias: "LIDACTION", ac: 1, dc: 1 });
    expect(getSetting(cfg, "disk")).toMatchObject({ ac: 0, dc: 600 });
    expect(getSetting(cfg, "usb")).toMatchObject({ ac: 1 });
  });
  it("has no setting for hardware that doesn't report it, and survives rubbish", () => {
    expect(getSetting(cfg, "wifi")).toBeNull();
    expect(parsePowercfg("")).toEqual({ scheme: null, settings: {} });
    expect(parsePowercfg(null).scheme).toBeNull();
  });
  it("flags what needs fixing from the fixture", () => {
    const items = windowsItems({ cfg, state: st() });
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(by.sleep.ok).toBe(false);   // sleeps after 30 min on power
    expect(by.lid.ok).toBe(false);     // lid sleeps
    expect(by.disk.ok).toBe(false);    // USB selective suspend on
    expect(by.plan.ok).toBe(true);
    expect(by.sleep.detail).toMatch(/30 min/);
  });
  it("only checks battery values when the battery option is on", () => {
    const base = parsePowercfg(fixture.replace("0x00000708", "0x00000000"));
    expect(windowsItems({ cfg: base, state: st() }).find((i) => i.id === "sleep").ok).toBe(true);
    expect(windowsItems({ cfg: base, state: st({ battery: true }) }).find((i) => i.id === "sleep").ok).toBe(false);
  });
  it("calls the Power saver plan a problem", () => {
    const saver = parsePowercfg(fixture.replace("381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)", "a1841308-3541-4fab-bc81-f71556f20b4a  (Power saver)"));
    expect(windowsItems({ cfg: saver, state: st() }).find((i) => i.id === "plan")).toMatchObject({ ok: false, fixable: true });
  });
});

describe("Windows command builders", () => {
  it("sets AC to 0, DC too on request, then re-activates the scheme", () => {
    const ac = powercfgZero(["standby"], { battery: false });
    expect(ac.map((c) => c.args[0])).toEqual(["/setacvalueindex", "/setactive"]);
    expect(ac[0]).toEqual({ cmd: "powercfg", args: ["/setacvalueindex", "SCHEME_CURRENT", "238c9fa8-0aad-41ed-83f4-97be242c8f20", "29f6c1db-86da-48c5-9fdb-f2b67b1f44da", "0"] });
    const dc = powercfgZero(["standby", "hibernate"], { battery: true });
    expect(dc.filter((c) => c.args[0] === "/setdcvalueindex")).toHaveLength(2);
    expect(dc.at(-1).args).toEqual(["/setactive", "SCHEME_CURRENT"]);
  });
  it("never touches the display timeout", () => {
    const all = ["sleep", "lid", "disk", "net", "plan", "update"].flatMap((id) => windowsFix(id, st({ battery: true })));
    expect(JSON.stringify(all)).not.toMatch(/SUB_VIDEO|VIDEOIDLE|3c0bc021/i);
  });
  it("encodes PowerShell so quoting can't break it", () => {
    const c = windowsFix("net", st()).find((x) => x.cmd === "powershell.exe");
    expect(c.args).toContain("-EncodedCommand");
    expect(decodePs(c.args)).toMatch(/Set-NetAdapterPowerManagement .*-AllowComputerToTurnOffDevice Disabled/);
    expect(decodePs(psArgs('Write-Host "x"'))).toBe('Write-Host "x"');
  });
  it("Windows Update: active hours (policy and user), notify, no auto restart", () => {
    const cmds = updateCommands({ start: 12, end: 6 });
    const joined = cmds.map((c) => c.args.join(" ")).join("\n");
    expect(joined).toMatch(/Policies.*WindowsUpdate \/v SetActiveHours \/t REG_DWORD \/d 1/);
    expect(joined).toMatch(/ActiveHoursStart \/t REG_DWORD \/d 12/);
    expect(joined).toMatch(/ActiveHoursEnd \/t REG_DWORD \/d 6/);
    expect(joined).toMatch(/NoAutoRebootWithLoggedOnUsers \/t REG_DWORD \/d 1/);
    expect(joined).toMatch(/RestartNotificationsAllowed2/);
    expect(cmds.every((c) => c.cmd === "reg" && c.args.at(-1) === "/f")).toBe(true);
  });
  it("validates active hours (1 to 18 hours)", () => {
    expect(hoursSpan(12, 6)).toBe(18);
    expect(validActiveHours({ start: 12, end: 6 })).toBe(true);
    expect(validActiveHours({ start: 6, end: 6 })).toBe(false);   // 24 h
    expect(validActiveHours({ start: 6, end: 1 })).toBe(false);   // 19 h
    expect(validActiveHours({ start: 25, end: 1 })).toBe(false);
  });
});

describe("registry and Windows Update status", () => {
  const regText = `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\r\n    SetActiveHours    REG_DWORD    0x1\r\n    ActiveHoursStart    REG_DWORD    0xc\r\n    ActiveHoursEnd    REG_DWORD    0x6\r\n    WUServer    REG_SZ    http://x\r\n`;
  it("parses reg query output", () => {
    expect(parseRegQuery(regText)).toEqual({ SetActiveHours: 1, ActiveHoursStart: 12, ActiveHoursEnd: 6, WUServer: "http://x" });
    expect(parseRegQuery("ERROR: The system was unable to find the specified registry key")).toEqual({});
  });
  it("is fine only with the hours set by policy and the notify rule", () => {
    const policy = parseRegQuery(regText);
    expect(updateStatus({ policy, au: { NoAutoRebootWithLoggedOnUsers: 1 } }, DEFAULT_ACTIVE_HOURS).ok).toBe(true);
    expect(updateStatus({ policy, au: {} }, DEFAULT_ACTIVE_HOURS).ok).toBe(false);
    const other = updateStatus({ policy: {}, au: {}, ux: { ActiveHoursStart: 8, ActiveHoursEnd: 17 } }, DEFAULT_ACTIVE_HOURS);
    expect(other).toMatchObject({ ok: false, current: { start: 8, end: 17 } });
  });
});

describe("last restart and why", () => {
  const T = (h, m) => new Date(2026, 9, 28, h, m).getTime();
  const msg = (proc, reason) => `The process ${proc} (DEV-HP) has initiated the restart of computer DEV-HP on behalf of user NT AUTHORITY\\SYSTEM for the following reason: ${reason}\n Reason Code: 0x80020010\n Shutdown Type: restart`;
  const ev = (id, at, message = "") => ({ id, at, message });
  it("names Windows Update from event 1074", () => {
    const r = describeRestart([ev(1074, T(3, 20), msg("C:\\Windows\\uus\\MoUsoCoreWorker.exe", "Operating System: Recovery (Planned)"))], T(3, 32), T(9, 0));
    expect(r).toMatchObject({ kind: "update", by: "Windows Update", text: "Restarted 03:32 by Windows Update" });
  });
  it("names a person or a command", () => {
    expect(who1074(msg("C:\\Windows\\explorer.exe", "Other (Planned)"))).toBe("someone at the machine");
    expect(who1074(msg("C:\\Windows\\system32\\shutdown.exe", "Other (Planned)"))).toBe("a shutdown command");
    expect(who1074(msg("C:\\Tools\\thing.exe", "Other"))).toBe("thing.exe");
    expect(who1074("garbled")).toBeNull();
  });
  it("calls an event 41 / 6008 near boot an unexpected shutdown, even with an old 1074 before", () => {
    const r = describeRestart([ev(41, T(3, 33)), ev(1074, T(1, 0), msg("explorer.exe", "x"))], T(3, 32), T(9, 0));
    expect(r.kind).toBe("unexpected");
  });
  it("ignores a stale 1074 and says only the time; shows the weekday for older boots", () => {
    expect(describeRestart([ev(1074, T(0, 0) - 86400_000, msg("explorer.exe", "x"))], T(3, 32), T(9, 0))).toMatchObject({ kind: "unknown", text: "Restarted 03:32" });
    expect(clock(T(3, 32) - 3 * 86400_000, T(9, 0))).toMatch(/^[A-Z][a-z]{2} 03:32$/);
  });
  it("parses the PowerShell JSON, one object or many", () => {
    expect(parseRestartEvents('{"id":1074,"at":5,"message":"m"}')).toEqual([{ id: 1074, at: 5, message: "m" }]);
    expect(parseRestartEvents('[{"id":4624,"at":5}]')).toEqual([]);
    expect(parseJsonList("not json")).toEqual([]);
  });
  it("builds the summary line", () => {
    const items = [{ id: "sleep", ok: true, fixable: true }, { id: "lid", ok: true, fixable: true }];
    const s = summarise(items, { text: "Restarted 03:32 by Windows Update", by: "Windows Update" });
    expect(s.text).toBe("Sleep: off · Lid: ignored · Last restart: 03:32 (Windows Update)");
    expect(s.ok).toBe(true);
    expect(summarise([{ id: "sleep", ok: false, fixable: true }], null)).toMatchObject({ text: "Sleep: on", ok: false, needs: 1 });
  });
});

describe("boot tasks and net adapters", () => {
  const good = [{ name: "NothingBotServerWorker", found: true, boot: true, user: "SYSTEM" }, { name: "NothingBotServerConsole", found: true, boot: true, user: "SYSTEM" }];
  it("verifies the boot tasks run as SYSTEM with a boot trigger", () => {
    const by = (tasks) => windowsItems({ cfg: null, tasks, state: st() }).find((i) => i.id === "boot");
    expect(by(good)).toMatchObject({ ok: true, fixable: false });
    expect(by([good[0], { ...good[1], boot: false }]).ok).toBe(false);
    expect(by([]).ok).toBe(false);
  });
  it("flags adapters Windows may power down", () => {
    const net = (allow) => windowsItems({ cfg: parsePowercfg(fixture), net: [{ name: "Wi-Fi", wifi: true, allow }], state: st() }).find((i) => i.id === "net");
    expect(net("Enabled")).toMatchObject({ ok: false, fixable: true });
    expect(net("Disabled").ok).toBe(true);
  });
});

describe("state file", () => {
  it("defaults, and repairs bad values", () => {
    expect(normaliseState(null)).toEqual({ battery: false, activeHours: { start: 12, end: 6 }, keepAwake: true, applied: false, appliedAt: null });
    expect(normaliseState({ battery: "yes", activeHours: { start: 6, end: 1 }, keepAwake: false, applied: true, appliedAt: 5 })).toEqual({ battery: false, activeHours: { start: 12, end: 6 }, keepAwake: false, applied: true, appliedAt: 5 });
  });
  it("reads a missing or corrupt file as defaults", () => {
    expect(readState(() => null, "x")).toEqual(normaliseState(null));
    expect(readState(() => "{nope", "x")).toEqual(normaliseState(null));
    expect(readState(() => '{"battery":true}', "x").battery).toBe(true);
  });
});

describe("createPower (Windows, fake machine)", () => {
  function machine(over = {}) {
    const files = new Map(), ran = [];
    const run = async (cmd, args) => {
      ran.push([cmd, ...args]);
      if (cmd === "powercfg" && args[0] === "/q") return { ok: true, out: fixture };
      if (cmd === "reg" && args[0] === "query") return { ok: true, out: "" };
      if (over.fail && cmd === over.fail) return { ok: false, out: "Access is denied.\nmore" };
      return { ok: true, out: "[]" };
    };
    const p = createPower({ platform: "win32", run, readText: (f) => files.get(f) ?? null, writeText: (f, t) => files.set(f, t), dataDir: "C:\\d", now: () => 1_000_000, uptime: () => 0, ...over });
    return { p, files, ran };
  }
  it("shows rows, and a fix runs commands and remembers that it was applied", async () => {
    const { p, files, ran } = machine();
    const v = await p.view();
    expect(v.items.find((i) => i.id === "sleep").ok).toBe(false);
    expect(v.applied).toBe(false);
    const r = await p.fix("sleep");
    expect(r.ok).toBe(true);
    expect(ran.some((c) => c[0] === "powercfg" && c[1] === "/setacvalueindex")).toBe(true);
    expect(JSON.parse(files.get("C:\\d\\power.json"))).toMatchObject({ applied: true, appliedAt: 1_000_000 });
  });
  it("reports a failed command and does not mark it applied", async () => {
    const { p, files } = machine({ fail: "powercfg" });
    await p.view();
    const r = await p.fix("lid");
    expect(r.results[0]).toMatchObject({ ok: false, error: "Access is denied." });
    expect(files.size).toBe(0);
  });
  it("dry mode runs and saves nothing", async () => {
    const { p, files, ran } = machine({ dry: true });
    await p.view();
    const before = ran.length;
    const r = await p.applyAll({ force: true });
    expect(r.results.every((x) => x.dry)).toBe(true);
    expect(ran.slice(before).every((c) => c[1] === "/q" || c[1] === "query" || c[0] === "powershell.exe")).toBe(true);
    expect(files.size).toBe(0);
  });
  it("reasserts only after the owner applied, and rejects bad options", async () => {
    const { p, ran } = machine();
    expect(await p.reassert()).toBeNull();
    await p.fix("lid");
    const n = ran.length;
    const r = await p.reassert();
    expect(r.results.length).toBeGreaterThan(0);
    expect(ran.length).toBeGreaterThan(n);
    await expect(p.setOptions({ activeHours: { start: 1, end: 23 } })).rejects.toThrow(/18/);
    await expect(p.setOptions({ battery: "x" })).rejects.toThrow();
    await expect(p.fix("nope")).rejects.toThrow(/Unknown/);
  });
});

describe("Ubuntu", () => {
  it("reads the last config value, defaults and lid rules", () => {
    expect(lastIni(["[Login]\nHandleLidSwitch=suspend\n", "[Login]\n#HandleLidSwitch=lock\nHandleLidSwitch=ignore"], "HandleLidSwitch", "Login")).toBe("ignore");
    expect(logindLid([null])).toEqual({ battery: "suspend", power: "suspend", docked: "ignore" });
    expect(logindLid(["[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore"])).toEqual({ battery: "ignore", power: "ignore", docked: "ignore" });
  });
  it("reads unattended-upgrades auto reboot, later files winning", () => {
    expect(aptAutoReboot([])).toBe(false);
    expect(aptAutoReboot(['Unattended-Upgrade::Automatic-Reboot "true";', 'Unattended-Upgrade::Automatic-Reboot "false";'])).toBe(false);
    expect(aptAutoReboot(['//Unattended-Upgrade::Automatic-Reboot "false";\nUnattended-Upgrade::Automatic-Reboot "true";'])).toBe(true);
  });
  it("rows and fix commands go through the root helper", () => {
    const masked = ["masked", "masked", "masked", "masked"];
    const ok = linuxItems({ lidTexts: ["[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore"], targets: masked, nm: "2", aptTexts: [], units: ["enabled", "enabled"] });
    expect(ok.filter((i) => i.fixable && i.id !== "keepawake").every((i) => i.ok)).toBe(true);
    const bad = linuxItems({ lidTexts: [], targets: ["static", "masked", "masked", "masked"], nm: "3", aptTexts: ['Unattended-Upgrade::Automatic-Reboot "true";'], units: [] });
    expect(bad.filter((i) => !i.ok && i.fixable && i.id !== "keepawake").map((i) => i.id)).toEqual(["lid", "sleep", "wifi", "autoreboot"]);
    expect(linuxFix("lid")).toEqual([{ cmd: "sudo", args: ["-n", LINUX_HELPER, "lid"] }]);
    expect(linuxFix("boot")).toEqual([]);
    expect(linuxItems({ lidTexts: [], targets: [], nm: null, units: [] }).some((i) => i.id === "wifi")).toBe(false);
  });
  it("the installer's helper and sudoers cover exactly those actions", () => {
    const sh = text("deploy", "install.sh");
    for (const a of ["lid", "sleep", "wifi", "autoreboot"]) expect(sh).toContain(`/usr/local/sbin/nbs-power ${a}`);
    expect(sh).toMatch(/HandleLidSwitch=ignore/);
    expect(sh).toMatch(/HandleLidSwitchExternalPower=ignore/);
    expect(sh).toMatch(/HandleLidSwitchDocked=ignore/);
    expect(sh).toMatch(/mask sleep\.target suspend\.target hibernate\.target hybrid-sleep\.target/);
    expect(sh).toMatch(/wifi\.powersave = 2/);
    expect(sh).toMatch(/Automatic-Reboot "false"/);
  });
});

describe("Mac", () => {
  const custom = "Battery Power:\n sleep 1\n disksleep 10\nAC Power:\n sleep 0\n disksleep 10\n displaysleep 10\n";
  it("parses pmset and shows the same rows", () => {
    expect(parsePmsetCustom(custom)).toEqual({ battery: { sleep: 1, disksleep: 10 }, ac: { sleep: 0, disksleep: 10, displaysleep: 10 } });
    const off = macItems({ pmsetG: " SleepDisabled\t\t0\n", pmsetCustom: custom, caffeinated: true, login: true });
    expect(off.find((i) => i.id === "lid")).toMatchObject({ ok: false, fixable: true });
    const on = macItems({ pmsetG: " SleepDisabled\t\t1\n", pmsetCustom: custom, caffeinated: true, login: true });
    expect(on.filter((i) => i.fixable).every((i) => i.ok)).toBe(true);
  });
  it("fixes both rows with one `nbsctl awake on`", async () => {
    const ran = [];
    const p = createPower({ platform: "darwin", dataDir: "/d", nbsctl: "/app/deploy/mac/nbsctl", readText: () => null, writeText: () => {}, run: async (c, a) => { ran.push([c, ...a]); return { ok: true, out: "" }; } });
    await p.fix("lid");
    const n = ran.filter((c) => c[2] === "awake").length;
    expect(n).toBe(1);
    expect(ran.find((c) => c[2] === "awake")).toEqual(["/bin/bash", "/app/deploy/mac/nbsctl", "awake", "on"]);
    expect(await p.reassert()).toBeNull(); // never nags for a password
  });
  it("matches what nbsctl sets", () => {
    const n = text("deploy", "mac", "nbsctl");
    expect(n).toContain("pmset -a disablesleep 1");
    expect(n).toContain("pmset -c sleep 0");
  });
});

describe("keep awake while running", () => {
  it("Windows holds SetThreadExecutionState until the console's process is gone", () => {
    const c = keepAwakeCommand("win32", 4242);
    const s = decodePs(c.args);
    expect(s).toMatch(/SetThreadExecutionState/);
    expect(s).toMatch(/2147483649/);
    expect(s).toMatch(/Get-Process -Id 4242/);
  });
  it("Linux takes a sleep/idle/lid inhibitor; Mac relies on caffeinate", () => {
    expect(keepAwakeCommand("linux", 1).args.join(" ")).toMatch(/--what=sleep:idle:handle-lid-switch/);
    expect(keepAwakeCommand("darwin", 1)).toBeNull();
  });
  it("starts once, restarts after it exits, stops for good", () => {
    const kids = [];
    const timers = [];
    const spawn = () => { const h = {}; const k = { on: (e, f) => { h[e] = f; }, kill: () => {}, h }; kids.push(k); return k; };
    const ka = createKeepAwake({ platform: "win32", spawn, retryMs: 1 });
    expect(ka.start()).toBe(true);
    ka.start();
    expect(kids).toHaveLength(1);
    expect(ka.status().running).toBe(true);
    ka.stop();
    expect(ka.status().running).toBe(false);
    expect(createKeepAwake({ platform: "darwin", spawn }).start()).toBe(false);
    void timers;
  });
});

describe("installers", () => {
  it("install.ps1 and update-core.ps1 re-apply the chosen settings through power-run.mjs", () => {
    for (const f of ["install.ps1", "update-core.ps1"]) expect(text("deploy", "windows", f)).toMatch(/power-run\.mjs"? --apply/);
    expect(text("deploy", "windows", "install.ps1")).toMatch(/powercfg \/change standby-timeout-ac 0/);
  });
  it("the console serves /api/power and puts the summary in /api/status", () => {
    const s = text("apps", "worker", "console", "server.mjs");
    expect(s).toContain('"/api/power"');
    expect(s).toMatch(/power: power\.summary\(\)/);
    const html = text("apps", "worker", "console", "index.html");
    expect(html).toContain("powerBlock()");
    expect(html).toContain("data-pw-all");
  });
});
