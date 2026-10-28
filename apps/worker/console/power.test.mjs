import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parsePowercfg, getSetting, powercfgZero, psArgs, decodePs, parseRegQuery, updateCommands, updateStatus, parseRestartEvents, describeRestart, who1074,
  windowsItems, windowsFix, normaliseState, readState, validActiveHours, hoursSpan, lastIni, logindLid, aptAutoReboot, linuxItems, linuxFix,
  parsePmsetCustom, macItems, keepAwakeCommand, createKeepAwake, summarise, createPower, parseJsonList, clock, LINUX_HELPER, DEFAULT_ACTIVE_HOURS,
  parsePowercfgA, powercfgSet, adapterStatus, netStatus, netFixOutcome, PS_NET_READ, PS_NET_FIX, parseLink, parseMacWifiDevice, createNetOps, watchdogStep, describeOutage, createWatchdog,
  parseSleepEvents, parseSleepJournal, parsePmsetLog, describeSleep, blockOpen, applyEnforce, keepAwakeItem, WD,
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
    expect(normaliseState(null)).toEqual({ battery: false, activeHours: { start: 12, end: 6 }, keepAwake: true, displayNever: false, enforce: {}, ui: null, applied: false, appliedAt: null });
    expect(normaliseState({ battery: "yes", activeHours: { start: 6, end: 1 }, keepAwake: false, applied: true, appliedAt: 5 })).toMatchObject({ battery: false, activeHours: { start: 12, end: 6 }, keepAwake: false, applied: true, appliedAt: 5 });
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
    expect(ran.slice(before).every((c) => c[1] === "/q" || c[1] === "/qh" || c[1] === "/a" || c[1] === "query" || c[0] === "powershell.exe")).toBe(true);
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

const fx = (n) => readFileSync(path.join(here, "fixtures", n), "utf8");

describe("powercfg /a: Modern Standby", () => {
  it("sees S0 Low Power Idle when it is available", () => {
    expect(parsePowercfgA(fx("powercfg-a-s0.txt"))).toMatchObject({ s0: true, s0Network: true, s3: false, s3Missing: true, hibernate: true });
  });
  it("sees classic S3 and no S0 (the S0 line is only in the not-available list)", () => {
    expect(parsePowercfgA(fx("powercfg-a-s3.txt"))).toMatchObject({ s0: false, s3: true });
  });
  it("is null for text that isn't powercfg's", () => {
    expect(parsePowercfgA("[]")).toBeNull();
    expect(parsePowercfgA(null)).toBeNull();
  });
  const s0 = parsePowercfgA(fx("powercfg-a-s0.txt"));
  it("adds the Modern Standby row only on S0, and fixes networking-in-standby (plus the screen only if opted in)", () => {
    const ids = (m) => windowsItems({ cfg: parsePowercfg(fixture), modern: m, state: st() }).map((i) => i.id);
    expect(ids(s0)).toContain("modern");
    expect(ids(parsePowercfgA(fx("powercfg-a-s3.txt")))).not.toContain("modern");
    expect(ids(null)).not.toContain("modern");
    const flat = (stt) => windowsFix("modern", stt).map((c) => c.args.join(" ")).join("\n");
    expect(flat(st())).toMatch(/SUB_NONE f15576e8-98b7-4186-b944-eafa664402d9 1/);
    expect(flat(st())).not.toMatch(/3c0bc021/);
    expect(flat(st({ displayNever: true }))).toMatch(/7516b95f-f776-4464-8c53-06167f40cc99 3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e 0/);
    expect(windowsFix("modern", st()).at(-1).args).toEqual(["/setactive", "SCHEME_CURRENT"]);
  });
  it("is fine once networking in standby is on or managed", () => {
    const row = (ac) => { const cfg = parsePowercfg(fixture); cfg.settings["f15576e8-98b7-4186-b944-eafa664402d9"] = { ac, dc: ac }; return windowsItems({ cfg, modern: s0, state: st() }).find((i) => i.id === "modern"); };
    expect(row(0).ok).toBe(false);
    expect(row(1).ok).toBe(true);
    expect(row(2).ok).toBe(true);
  });
  it("powercfgSet sets AC, DC on request, then activates", () => {
    expect(powercfgSet("display", 0, { battery: true }).map((c) => c.args[0])).toEqual(["/setacvalueindex", "/setdcvalueindex", "/setactive"]);
  });
});

describe("Wi-Fi row: the check reads where the fix writes", () => {
  const wifiPm0 = { ac: 0, dc: 0 }, wifiPm3 = { ac: 3, dc: 3 };
  it("accepts the PnPCapabilities registry value (0x18, also 24 as text) by itself", () => {
    expect(adapterStatus({ wifi: true, allow: "Enabled", pnp: "24" }, wifiPm3).ok).toBe(true);
    expect(adapterStatus({ wifi: true, allow: "Enabled", pnp: "56" }, wifiPm3).ok).toBe(true); // 0x38 includes both bits
    expect(adapterStatus({ wifi: true, allow: "Enabled", pnp: "16" }, wifiPm0).ok).toBe(false);
    expect(adapterStatus({ wifi: true, allow: "Enabled", pnp: "" }, wifiPm0).ok).toBe(false);
  });
  it("says the registry change applies after the adapter restarts", () => {
    const r = netStatus([{ name: "Wi-Fi", wifi: true, allow: "Enabled", pnp: "24" }], null, false);
    expect(r).toMatchObject({ ok: true, pending: true });
    expect(r.detail).toMatch(/applies after the adapter restarts/);
  });
  it("accepts Disabled or Unsupported only together with powercfg maximum performance", () => {
    for (const allow of ["Disabled", "Unsupported"]) {
      expect(adapterStatus({ wifi: true, allow, pnp: "" }, wifiPm0).ok).toBe(true);
      expect(adapterStatus({ wifi: true, allow, pnp: "" }, wifiPm3).ok).toBe(false);
    }
    expect(adapterStatus({ wifi: false, allow: "Unsupported", pnp: "" }, wifiPm3).ok).toBe(true); // Ethernet: no powercfg Wi-Fi setting
  });
  it("reads the Unsupported fixture (the old check never turned green on Enabled, and the driver refuses the setter)", () => {
    const net = parseJsonList(fx("net-pm-wifi-unsupported.json"));
    const wifi = netStatus([net[0]], wifiPm3, false);
    expect(wifi.ok).toBe(false);
    expect(wifi.detail).toMatch(/Wi-Fi power saving is on/);
    expect(netStatus([net[0]], wifiPm0, false).ok).toBe(true);
    const eth = netStatus([net[1]], null, false);
    expect(eth.ok).toBe(false);
    expect(eth.detail).toMatch(/Windows said: Set failed/); // the real error text reaches the row
  });
  it("shows the PowerShell error instead of a silent row when the query itself failed", () => {
    const row = windowsItems({ cfg: parsePowercfg(fixture), net: [], netErr: "Get-NetAdapter : Access is denied", state: st() }).find((i) => i.id === "net");
    expect(row.ok).toBe(false);
    expect(row.detail).toMatch(/Access is denied/);
  });
  it("the scripts match adapters by NetCfgInstanceId, set PnPCapabilities 24, and report real errors", () => {
    expect(PS_NET_READ).toMatch(/NetCfgInstanceId/);
    expect(PS_NET_READ).toMatch(/\{4d36e972-e325-11ce-bfc1-08002be10318\}/);
    expect(PS_NET_READ).toMatch(/InterfaceGuid/);
    expect(PS_NET_READ).toMatch(/Exception\.Message/);
    expect(PS_NET_FIX).toMatch(/Set-ItemProperty[^;]*PnPCapabilities -Value 24 -Type DWord/);
    expect(PS_NET_FIX).toMatch(/AllowComputerToTurnOffDevice Disabled/);
  });
  it("the fix: a driver refusal is a note; only a registry failure on every adapter is an error", () => {
    expect(netFixOutcome(JSON.stringify([{ name: "Wi-Fi", setError: "Not supported", regError: "", changed: true }]))).toMatchObject({ restartNeeded: true, note: expect.stringMatching(/after the adapter restarts.*Not supported/) });
    expect(netFixOutcome(JSON.stringify([{ name: "Wi-Fi", setError: "", regError: "Access denied", changed: false }])).error).toMatch(/Wi-Fi: Access denied/);
    expect(netFixOutcome("boom").error).toBe("boom");
    expect(netFixOutcome("").error).toMatch(/printed nothing/);
  });
  it("a fix run through createPower surfaces the note, and a failed registry write as the row's error", async () => {
    const mk = (out) => createPower({ platform: "win32", dataDir: "C:\\d", now: () => 1, readText: () => null, writeText: () => {}, run: async (cmd, args) => (cmd === "powershell.exe" && decodePs(args).includes("Set-ItemProperty") ? { ok: true, out } : { ok: true, out: cmd === "powercfg" && args[0] === "/q" ? fixture : "[]" }) });
    const okRun = await mk(JSON.stringify([{ name: "Wi-Fi", setError: "x", regError: "", changed: true }])).fix("net");
    expect(okRun.results[0]).toMatchObject({ ok: true, note: expect.stringMatching(/restarts/) });
    const bad = await mk(JSON.stringify([{ name: "Wi-Fi", setError: "", regError: "Access denied", changed: false }])).fix("net");
    expect(bad.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/Access denied/) });
  });
});

describe("keep-awake helper ticks", () => {
  it("writes a tick file, asks for away mode and falls back", () => {
    const sc = decodePs(keepAwakeCommand("win32", 7, "C:\\d\\keepawake.tick").args);
    expect(sc).toMatch(/Set-Content -LiteralPath 'C:\\d\\keepawake\.tick'/);
    expect(sc).toMatch(/2147483713/); // ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED
    expect(sc).toMatch(/if \(\$r -eq 0\)[^}]*2147483649/);
  });
  it("shows pid and last tick in the row, and restarts a helper that stopped ticking", () => {
    let t = 1_000_000, tick = String(t), kills = 0, spawned = 0;
    const spawn = () => { spawned++; const k = { pid: 100 + spawned, on() {}, kill: () => { kills++; } }; return k; };
    const ka = createKeepAwake({ platform: "win32", spawn, tickFile: "t", readText: () => tick, now: () => t, staleMs: 90_000 });
    ka.start();
    t += 20_000;
    const s = ka.status();
    expect(s).toMatchObject({ running: true, pid: 101, stale: false });
    const row = keepAwakeItem(s, "ok", t);
    expect(row.ok).toBe(true);
    expect(row.detail).toMatch(/helper running · pid 101 · last tick 20s ago/);
    t += 200_000; // never ticked again
    expect(ka.status().stale).toBe(true);
    expect(keepAwakeItem(ka.status(), "ok", t).ok).toBe(false);
    ka.check();
    expect(kills).toBe(1);
    expect(spawned).toBe(2);
    expect(ka.status()).toMatchObject({ pid: 102, stale: false });
  });
});

describe("network watchdog", () => {
  const M = 60_000;
  const run = (steps) => {
    let w = null; const actions = [];
    for (const [at, online, link] of steps) { const r = watchdogStep(w, { online, link }, at, WD); w = r.w; actions.push(r.action); }
    return { w, actions };
  };
  const ticks = (from, to, online, link) => { const a = []; for (let t = from; t <= to; t += 30_000) a.push([t, online, link]); return a; };
  it("does nothing while online, and logs a short blip without restarting", () => {
    const r = run([...ticks(0, 60_000, true, "up"), ...ticks(90_000, 150_000, false, "limited"), ...ticks(180_000, 240_000, true, "up")]);
    expect(r.actions.every((a) => a === null)).toBe(true);
    expect(r.w.outages).toHaveLength(1);
    expect(r.w.outages[0]).toMatchObject({ kind: "offline", start: 90_000, end: 180_000, restarts: 0 });
  });
  it("restarts Wi-Fi once after 3 minutes down with the link disconnected or limited", () => {
    const r = run(ticks(0, 6 * M, false, "disconnected"));
    expect(r.actions.filter(Boolean)).toEqual(["restart"]);
    expect(r.actions.indexOf("restart")).toBe(6); // t = 180 s
  });
  it("then waits at least 15 minutes between restarts", () => {
    const r = run(ticks(0, 40 * M, false, "limited"));
    const times = r.actions.map((a, i) => (a ? i * 30_000 : null)).filter((x) => x !== null);
    expect(times).toEqual([180_000, 180_000 + 15 * M, 180_000 + 30 * M]);
    expect(r.w.outages[0].restarts).toBe(3);
  });
  it("does not restart when the adapter looks fine (the internet is down upstream)", () => {
    const r = run(ticks(0, 10 * M, false, "up"));
    expect(r.actions.every((a) => a === null)).toBe(true);
    expect(r.w.outages[0].link).toBe("up");
  });
  it("keeps the restart backoff across outages", () => {
    const r = run([...ticks(0, 4 * M, false, "disconnected"), ...ticks(4.5 * M, 5 * M, true, "up"), ...ticks(5.5 * M, 12 * M, false, "disconnected")]);
    expect(r.actions.filter(Boolean)).toHaveLength(1);
  });
  it("logs a silence between ticks as a heartbeat gap (asleep, off, or the console stopped)", () => {
    const r = run([[0, true, "up"], [30_000, true, "up"], [30_000 + 14 * M, true, "up"]]);
    expect(r.w.outages).toEqual([{ kind: "gap", start: 30_000, end: 30_000 + 14 * M, restarts: 0, link: null }]);
  });
  it("keeps only the last 20 outages", () => {
    let w = null;
    for (let i = 0; i < 30; i++) w = watchdogStep(w, { online: true, link: "up" }, i * 10 * M, WD).w;
    expect(w.outages).toHaveLength(WD.keep);
  });
  it("words outages the way the block shows them", () => {
    const now = new Date(2026, 9, 28, 12, 0).getTime(), at = (h, m) => new Date(2026, 9, 28, h, m).getTime();
    expect(describeOutage({ kind: "offline", start: at(2, 10), end: at(2, 24), restarts: 1 }, now)).toBe("Offline 02:10–02:24, Wi-Fi restarted");
    expect(describeOutage({ kind: "offline", start: at(2, 10), end: null, restarts: 0, link: "up" }, now)).toMatch(/^Offline since 02:10 \(still\), Wi-Fi connected/);
    expect(describeOutage({ kind: "gap", start: at(2, 10), end: at(2, 24) }, now)).toMatch(/^No heartbeat 02:10–02:24/);
  });
  it("createWatchdog probes, restarts, persists and reports the last five", async () => {
    let t = 0, online = false, restarts = 0; const files = new Map();
    const wd = createWatchdog({
      probe: async () => online, link: async () => "disconnected", restart: async () => { restarts++; return { ok: true, out: "" }; },
      readText: (f) => files.get(f) ?? null, writeText: (f, x) => files.set(f, x), file: "o.json", now: () => t,
    });
    for (t = 0; t <= 4 * M; t += 30_000) await wd.tick();
    expect(restarts).toBe(1);
    online = true; t += 30_000; await wd.tick();
    const s = wd.status();
    expect(s.outages).toHaveLength(1);
    expect(s.outages[0].text).toMatch(/^Offline .*, Wi-Fi restarted$/);
    // a new process reads the same log
    const again = createWatchdog({ probe: async () => true, link: async () => "up", restart: async () => ({ ok: true }), readText: (f) => files.get(f) ?? null, writeText: () => {}, file: "o.json", now: () => t });
    expect(again.status().outages).toHaveLength(1);
  });
  it("is off when disabled", async () => {
    let probed = 0;
    const wd = createWatchdog({ probe: async () => { probed++; return true; }, link: async () => "up", restart: async () => ({ ok: true }), readText: () => null, writeText: () => {}, file: "x", enabled: () => false });
    await wd.tick();
    expect(probed).toBe(0);
  });
});

describe("link and restart per OS", () => {
  it("reads the Windows link: not Up is disconnected; Up without an Internet profile is limited", () => {
    expect(parseLink("win32", '{"status":"Disconnected","net":""}')).toBe("disconnected");
    expect(parseLink("win32", '{"status":"Up","net":"LocalNetwork"}')).toBe("limited");
    expect(parseLink("win32", '{"status":"Up","net":"Internet"}')).toBe("up");
    expect(parseLink("win32", "garbage")).toBe("unknown");
  });
  it("reads nmcli and networksetup", () => {
    expect(parseLink("linux", "connected")).toBe("up");
    expect(parseLink("linux", "connected (site only)")).toBe("limited");
    expect(parseLink("linux", "disconnected")).toBe("disconnected");
    expect(parseLink("darwin", "You are not associated with an AirPort network.")).toBe("disconnected");
    expect(parseLink("darwin", "Current Wi-Fi Network: Home")).toBe("limited");
    expect(parseMacWifiDevice("Hardware Port: Ethernet\nDevice: en5\n\nHardware Port: Wi-Fi\nDevice: en0\nEthernet Address: aa")).toBe("en0");
  });
  it("restarts Wi-Fi: Restart-NetAdapter on Windows, the root helper on Ubuntu, networksetup off/on on a Mac", async () => {
    const calls = [];
    const mk = (platform) => createNetOps({ platform, wait: async () => {}, run: async (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, out: cmd === "networksetup" && args[0] === "-listallhardwareports" ? "Hardware Port: Wi-Fi\nDevice: en1\n" : "" }; } });
    await mk("win32").restartWifi();
    expect(decodePs(calls.at(-1).slice(1))).toMatch(/Restart-NetAdapter/);
    await mk("linux").restartWifi();
    expect(calls.at(-1)).toEqual(["sudo", "-n", LINUX_HELPER, "wifi-restart"]);
    calls.length = 0;
    await mk("darwin").restartWifi();
    expect(calls.filter((c) => c[1] === "-setairportpower")).toEqual([["networksetup", "-setairportpower", "en1", "off"], ["networksetup", "-setairportpower", "en1", "on"]]);
  });
  it("the Ubuntu helper and sudoers know wifi-restart (nmcli radio wifi off/on)", () => {
    const sh = text("deploy", "install.sh");
    expect(sh).toContain("/usr/local/sbin/nbs-power wifi-restart");
    expect(sh).toMatch(/nmcli radio wifi off; sleep 3; nmcli radio wifi on/);
  });
});

describe("last sleep and wake", () => {
  it("reads the Windows events (Power-Troubleshooter 1 carries the wake source)", () => {
    const ev = parseSleepEvents(JSON.stringify([
      { id: 1, at: 2000, message: "The system has resumed from sleep.\nWake Source: Device -Intel(R) Wireless" }, { id: 42, at: 1000, message: "" }, { id: 107, at: 1999, message: "" }, { id: 4, at: 5, message: "" },
    ]));
    expect(ev).toHaveLength(3);
    const d = describeSleep(ev, 3000);
    expect(d).toMatchObject({ sleptAt: 1000, wokeAt: 2000, source: "Device -Intel(R) Wireless" });
    expect(d.text).toMatch(/^Last slept .*, woke .*\(Device -Intel/);
  });
  it("says so when the log has nothing", () => {
    expect(describeSleep([], 1).text).toMatch(/No sleep or wake/);
  });
  it("reads journal and pmset lines", () => {
    expect(parseSleepJournal("1761600000.123 host kernel: PM: suspend entry (deep)\n1761600600.5 host kernel: PM: suspend exit")).toEqual([{ kind: "sleep", at: 1761600000000, source: null }, { kind: "wake", at: 1761600600000, source: null }]);
    const p = parsePmsetLog("2026-10-28 02:10:11 +0100 Sleep               \tEntering Sleep state due to 'Clamshell Sleep'\n2026-10-28 02:24:00 +0100 Wake                \tWake from Deep Idle [CDNVA] due to EC.LidOpen");
    expect(p.map((e) => e.kind)).toEqual(["sleep", "wake"]);
    expect(p[1].source).toBe("Deep Idle");
  });
});

describe("collapsible and customisable", () => {
  it("is collapsed when everything is fine and open when something needs fixing", () => {
    expect(blockOpen(null, 0)).toBe(false);
    expect(blockOpen(null, 2)).toBe(true);
  });
  it("remembers the owner's choice while the state is the same, and goes back to automatic when it changes", () => {
    expect(blockOpen({ open: true, forNeeds: false }, 0)).toBe(true);
    expect(blockOpen({ open: false, forNeeds: true }, 3)).toBe(false);
    expect(blockOpen({ open: false, forNeeds: false }, 1)).toBe(true); // a problem appeared: open again
  });
  it("ignored rows never warn and are never fixed", () => {
    const items = applyEnforce([{ id: "net", ok: false, fixable: true }, { id: "lid", ok: false, fixable: true }, { id: "boot", ok: false, fixable: false }], st({ enforce: { net: false } }));
    expect(items[0]).toMatchObject({ ok: true, fixable: false, ignored: true });
    expect(items[1]).toMatchObject({ ok: false, fixable: true, ignored: false });
    expect(summarise(items, null).needs).toBe(1);
  });
  function machine() {
    const files = new Map();
    const run = async (cmd, args) => ({ ok: true, out: cmd === "powercfg" && args[0] === "/q" ? fixture : "[]" });
    const ka = { starts: 0, stops: 0, start() { this.starts++; return true; }, stop() { this.stops++; }, status: () => ({ running: true, pid: 5 }), supported: () => true };
    const p = createPower({ platform: "win32", run, readText: (f) => files.get(f) ?? null, writeText: (f, t) => files.set(f, t), dataDir: "C:\\d", now: () => 1_000_000, keepAwake: ka });
    return { p, files, ka };
  }
  it("persists the choices in power.json and applies only the enabled items", async () => {
    const { p, files } = machine();
    const v0 = await p.view();
    expect(v0.open).toBe(true); // the fixture has things to fix
    expect(v0.toggles.map((t) => t.id)).toEqual(expect.arrayContaining(["sleep", "lid", "net", "update", "keepawake", "watchdog"]));
    await p.setEnforce("lid", false);
    await p.setEnforce("net", false);
    const v = await p.view();
    expect(v.items.find((i) => i.id === "lid")).toMatchObject({ ignored: true, ok: true });
    expect(v.toggles.find((t) => t.id === "lid").on).toBe(false);
    expect(JSON.parse(files.get("C:\\d\\power.json")).enforce).toEqual({ lid: false, net: false });
    const ran = [];
    const run2 = async (cmd, args) => { ran.push([cmd, ...args]); return { ok: true, out: cmd === "powercfg" && args[0] === "/q" ? fixture : "[]" }; };
    const p2 = createPower({ platform: "win32", run: run2, readText: (f) => files.get(f) ?? null, writeText: (f, t) => files.set(f, t), dataDir: "C:\\d", now: () => 1 });
    const r = await p2.applyAll({ force: true });
    expect(r.results.map((x) => x.id)).not.toContain("lid");
    expect(r.results.map((x) => x.id)).not.toContain("net");
    expect(r.results.map((x) => x.id)).toContain("sleep");
    const lidSet = ran.filter((c) => c[0] === "powercfg" && c.includes("5ca83367-6e45-459f-a27b-476b1d01c936"));
    expect(lidSet).toHaveLength(0);
    const n = ran.length;
    await p2.reassert();
    expect(ran.slice(n).some((c) => c.includes("5ca83367-6e45-459f-a27b-476b1d01c936"))).toBe(false);
  });
  it("turning keep-awake off stops the helper and turning it on starts it", async () => {
    const { p, ka } = machine();
    await p.setEnforce("keepawake", false);
    expect(ka.stops).toBe(1);
    expect(p.state().keepAwake).toBe(false);
    await p.setEnforce("keepawake", true);
    expect(ka.starts).toBe(1);
    expect(p.state().keepAwake).toBe(true);
    await expect(p.setEnforce("boot", false)).rejects.toThrow(/Unknown/);
    await expect(p.setEnforce("lid", "x")).rejects.toThrow();
  });
  it("remembers collapse in power.json, per good/bad state", async () => {
    const { p, files } = machine();
    await p.setUi(false);
    expect(JSON.parse(files.get("C:\\d\\power.json")).ui).toEqual({ open: false, forNeeds: true });
    expect((await p.view()).open).toBe(false);
    await expect(p.setUi("no")).rejects.toThrow();
  });
  it("the block is collapsible with a toggle, a customise list and a Restart Wi-Fi button", () => {
    const html = text("apps", "worker", "console", "index.html");
    for (const k of ["data-pw-toggle", "data-pw-enf", "data-pw-restartnet", "aria-expanded"]) expect(html).toContain(k);
    const s = text("apps", "worker", "console", "server.mjs");
    expect(s).toMatch(/b\.action === "enforce"/);
    expect(s).toMatch(/b\.action === "restart-net"/);
    expect(s).toMatch(/watchdog\.start\(\)/);
    expect(s).toMatch(/keepAwake\.check\(\)/);
  });
  it("Ubuntu and Mac get the same toggles and the watchdog row", async () => {
    for (const platform of ["linux", "darwin"]) {
      const p = createPower({ platform, run: async () => ({ ok: true, out: "" }), readText: () => null, writeText: () => {}, dataDir: "/d", home: "/h", now: () => 1, watchdog: { status: () => ({ outages: [{ text: "Offline 02:10–02:24, Wi-Fi restarted" }], link: null, online: true }) } });
      const v = await p.view();
      expect(v.toggles.map((t) => t.id)).toContain("watchdog");
      expect(v.toggles.map((t) => t.id)).toContain("lid");
      expect(v.items.find((i) => i.id === "watchdog").detail).toMatch(/Offline 02:10–02:24, Wi-Fi restarted/);
      expect(typeof v.open).toBe("boolean");
    }
  });
});
