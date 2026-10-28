// "Stay on": keep this machine awake and reachable. The console's Power card (GET/POST /api/power) and power-run.mjs (installer and
// updater) are built on this. Pure parsers and command builders first (tested with fixtures), then createPower(), which reads the machine
// and runs the fixes through injected functions.
//
// Windows: powercfg (sleep, hibernate, lid, disk, USB), Set-NetAdapterPowerManagement, Windows Update's active hours and restart
// policy (registry), the last restart and why (System log events 1074 / 6008 / 41), the boot tasks. The console runs as SYSTEM, so every
// fix is made directly. Ubuntu: logind lid, masked sleep targets, NetworkManager wifi.powersave, unattended-upgrades; the fixes go
// through the root helper /usr/local/sbin/nbs-power (installed by install.sh, listed in sudoers). Mac: pmset, through `nbsctl awake on`
// (it asks for an admin password, as in the Mac app).
//
// State (what the owner chose) lives in <data>/power.json: battery too, the active-hours window, the keep-awake fallback.

export const STATE_FILE = "power.json";
export const LINUX_HELPER = "/usr/local/sbin/nbs-power";

// ---------- Windows: powercfg ----------
export const SCHEME = { balanced: "381b4222-f694-41f0-9685-ff5bb260df2e", powerSaver: "a1841308-3541-4fab-bc81-f71556f20b4a", high: "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c" };
/** Settings the card reads and sets: [subgroup GUID, setting GUID]. Display-off (VIDEOIDLE) is deliberately absent: the screen may sleep. */
export const SETTINGS = {
  standby: ["238c9fa8-0aad-41ed-83f4-97be242c8f20", "29f6c1db-86da-48c5-9fdb-f2b67b1f44da"], // Sleep after (seconds, 0 = never)
  hibernate: ["238c9fa8-0aad-41ed-83f4-97be242c8f20", "9d7815a6-7ee4-497e-8888-515a05f02364"], // Hibernate after
  lid: ["4f971e89-eebd-4455-a8de-9e59040e7347", "5ca83367-6e45-459f-a27b-476b1d01c936"], // Lid close action (0 = do nothing)
  disk: ["0012ee47-9041-4b5d-9b77-535fba8b1442", "6738e2c4-e8a5-4a42-b16a-e040e769756e"], // Turn off hard disk after
  usb: ["2a737441-1930-4402-8d77-b2bebba308a3", "48e6b7a6-50f5-4782-a5d4-53bb8f07e226"], // USB selective suspend (0 = disabled)
  wifi: ["19cbb8fa-5279-450e-9fac-8a3d5fedd0c1", "12bbebe6-58d6-4636-95bb-3217ef867c1a"], // Wireless adapter power saving (0 = maximum performance)
};

const hexOrInt = (s) => { const t = String(s).trim(); const n = /^0x/i.test(t) ? parseInt(t, 16) : parseInt(t, 10); return Number.isFinite(n) ? n : null; };

/**
 * Parses `powercfg /q` (the active scheme). Returns { scheme: {guid, name}|null, settings: { <setting guid>: {name, alias, subgroup, ac, dc} } }
 * where ac/dc are the current index values as numbers (null when the line is missing). English output only, which is what the servers run.
 */
export function parsePowercfg(text) {
  const out = { scheme: null, settings: {} };
  let sub = null, cur = null, target = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if ((m = /^Power Scheme GUID:\s*([0-9a-f-]{36})\s*(?:\((.*)\))?/i.exec(line))) { out.scheme = { guid: m[1].toLowerCase(), name: (m[2] ?? "").trim() }; target = "scheme"; cur = null; continue; }
    if ((m = /^Subgroup GUID:\s*([0-9a-f-]{36})\s*(?:\((.*)\))?/i.exec(line))) { sub = m[1].toLowerCase(); cur = null; target = "sub"; continue; }
    if ((m = /^Power Setting GUID:\s*([0-9a-f-]{36})\s*(?:\((.*)\))?/i.exec(line))) {
      cur = out.settings[m[1].toLowerCase()] = { name: (m[2] ?? "").trim(), alias: null, subgroup: sub, ac: null, dc: null };
      target = "setting"; continue;
    }
    if ((m = /^GUID Alias:\s*(\S+)/i.exec(line))) { if (target === "setting" && cur) cur.alias = m[1]; continue; }
    if (cur && (m = /^Current (AC|DC) Power Setting Index:\s*(\S+)/i.exec(line))) cur[m[1].toLowerCase()] = hexOrInt(m[2]);
  }
  return out;
}
/** The parsed setting for a key of SETTINGS, or null when this hardware doesn't have it. */
export const getSetting = (parsed, key) => parsed?.settings?.[SETTINGS[key][1]] ?? null;

/** powercfg set commands for keys, to 0 (never / do nothing / off) on AC and, when battery is true, DC; ends with /setactive. */
export function powercfgZero(keys, { battery = false } = {}) {
  const cmds = [];
  for (const k of keys) {
    const [sub, id] = SETTINGS[k];
    cmds.push({ cmd: "powercfg", args: ["/setacvalueindex", "SCHEME_CURRENT", sub, id, "0"] });
    if (battery) cmds.push({ cmd: "powercfg", args: ["/setdcvalueindex", "SCHEME_CURRENT", sub, id, "0"] });
  }
  cmds.push({ cmd: "powercfg", args: ["/setactive", "SCHEME_CURRENT"] });
  return cmds;
}

// ---------- Windows: PowerShell pieces ----------
/** powershell.exe arguments for a script, passed as -EncodedCommand (UTF-16LE base64) so no quoting can go wrong. */
export function psArgs(script) {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}
export const decodePs = (args) => Buffer.from(args[args.length - 1], "base64").toString("utf16le");
const ps = (script) => ({ cmd: "powershell.exe", args: psArgs(script) });

export const PS_NET_READ = `$r = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-NetAdapterPowerManagement -Name $_.Name -ErrorAction SilentlyContinue; [pscustomobject]@{ name = $_.Name; wifi = [bool]($_.PhysicalMediaType -match '802\\.11'); allow = [string]$p.AllowComputerToTurnOffDevice } }); ConvertTo-Json -InputObject $r -Compress`;
export const PS_NET_FIX = `Get-NetAdapter -Physical -ErrorAction SilentlyContinue | ForEach-Object { try { Set-NetAdapterPowerManagement -Name $_.Name -AllowComputerToTurnOffDevice Disabled -ErrorAction Stop } catch { } }`;
export const PS_RESTART_READ = `$e = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 1074, 6008, 41 } -MaxEvents 8 -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ id = $_.Id; at = ([DateTimeOffset]$_.TimeCreated).ToUnixTimeMilliseconds(); message = [string]$_.Message } }); ConvertTo-Json -InputObject $e -Compress`;
export const BOOT_TASKS = ["NothingBotServerWorker", "NothingBotServerConsole"];
export const PS_TASKS_READ = `$r = @('${BOOT_TASKS.join("','")}' | ForEach-Object { $t = Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue; [pscustomobject]@{ name = $_; found = [bool]$t; state = [string]$t.State; boot = [bool]($t.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' }); user = [string]$t.Principal.UserId; logon = [string]$t.Principal.LogonType } }); ConvertTo-Json -InputObject $r -Compress`;

/** JSON out of PowerShell: always an array (ConvertTo-Json may still give one object); [] when it isn't JSON. */
export function parseJsonList(text) {
  try { const v = JSON.parse(String(text ?? "").trim()); return Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []; } catch { return []; }
}

// ---------- Windows: registry (reg query / reg add) ----------
export const REG = {
  ux: "HKLM\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings",
  policy: "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate",
  au: "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU",
};
/** `reg query KEY` -> { ValueName: number | string }. DWORDs come back as numbers. */
export function parseRegQuery(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_(\w+)\s+(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2] === "DWORD" ? hexOrInt(m[3]) : m[3];
  }
  return out;
}
const regDword = (key, name, v) => ({ cmd: "reg", args: ["add", key, "/v", name, "/t", "REG_DWORD", "/d", String(v), "/f"] });

/** Active hours as hours 0-23: how long the window is (1-18; Windows allows at most 18). */
export const hoursSpan = (start, end) => ((end - start + 24) % 24) || 24;
const validHour = (h) => Number.isInteger(h) && h >= 0 && h <= 23;
export const validActiveHours = (a) => Boolean(a) && validHour(a.start) && validHour(a.end) && hoursSpan(a.start, a.end) <= 18;
export const DEFAULT_ACTIVE_HOURS = { start: 12, end: 6 }; // 12:00 to 06:00, the longest window Windows allows: the curator's whole night

/**
 * Windows Update: no restarts inside the active hours (policy and the user setting, so "smart active hours" can't move them),
 * a notification before restarting, and no automatic restart while someone is signed in.
 */
export function updateCommands({ start, end }) {
  return [
    regDword(REG.policy, "SetActiveHours", 1), regDword(REG.policy, "ActiveHoursStart", start), regDword(REG.policy, "ActiveHoursEnd", end),
    regDword(REG.au, "NoAutoRebootWithLoggedOnUsers", 1),
    regDword(REG.ux, "ActiveHoursStart", start), regDword(REG.ux, "ActiveHoursEnd", end),
    regDword(REG.ux, "SmartActiveHoursState", 2), // 2 = off, so Windows doesn't re-learn the hours
    regDword(REG.ux, "RestartNotificationsAllowed2", 1),
  ];
}
export function updateStatus({ policy = {}, au = {}, ux = {} }, want) {
  const hoursSet = policy.SetActiveHours === 1 && policy.ActiveHoursStart === want.start && policy.ActiveHoursEnd === want.end;
  const notify = au.NoAutoRebootWithLoggedOnUsers === 1;
  const cur = hoursSet ? want : validHour(ux.ActiveHoursStart) && validHour(ux.ActiveHoursEnd) ? { start: ux.ActiveHoursStart, end: ux.ActiveHoursEnd } : null;
  return { ok: hoursSet && notify, hoursSet, notify, current: cur };
}

// ---------- Windows: why it restarted ----------
const hh = (h) => String(h).padStart(2, "0") + ":00";
const hm = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "03:32" for today, "Tue 03:32" for another day. */
export function clock(ms, now) {
  const a = new Date(ms), b = new Date(now);
  return a.toDateString() === b.toDateString() ? hm(ms) : `${DAYS[a.getDay()]} ${hm(ms)}`;
}
export function parseRestartEvents(text) {
  return parseJsonList(text).map((e) => ({ id: Number(e.id), at: Number(e.at), message: String(e.message ?? "") })).filter((e) => Number.isFinite(e.at) && [1074, 6008, 41].includes(e.id));
}
const UPDATE_PROC = /MoUsoCoreWorker|TrustedInstaller|wuauclt|usoclient|musnotification|UpdateOrchestrator|WaaSMedic|SetupHost|windows10upgrade/i;
const UPDATE_REASON = /Operating System:\s*(Upgrade|Recovery|Reconfiguration)|Windows Update|Application:\s*Maintenance/i;
/** Who started the restart (event 1074's text) as a short phrase, or null when the text can't be read. */
export function who1074(message) {
  const proc = /process\s+(.+?)\s+\(/i.exec(message)?.[1] ?? "";
  const reason = /following reason:\s*(.+)/i.exec(message)?.[1]?.trim() ?? "";
  if (UPDATE_PROC.test(proc) || UPDATE_REASON.test(reason)) return "Windows Update";
  if (/shutdown\.exe/i.test(proc)) return "a shutdown command";
  if (/explorer\.exe|winlogon|LogonUI|sihost/i.test(proc)) return "someone at the machine";
  const name = proc.split(/[\\/]/).pop();
  return name || null;
}
/**
 * The last restart: { at, by, kind: "update"|"planned"|"unexpected"|"unknown", text }. `bootAt` is when this boot started. Events are the System
 * log's 1074 (a planned restart and who asked), 6008 and 41 (the previous shutdown was unexpected: power loss or a crash).
 */
export function describeRestart(events, bootAt, now = Date.now()) {
  const when = clock(bootAt, now);
  const near = (e) => Math.abs(e.at - bootAt) < 15 * 60_000;
  const crash = events.find((e) => (e.id === 6008 || e.id === 41) && near(e));
  if (crash) return { at: bootAt, kind: "unexpected", by: "a power loss or crash", text: `Restarted ${when} (unexpected: power loss or crash)` };
  const planned = events.filter((e) => e.id === 1074 && e.at <= bootAt + 60_000 && bootAt - e.at < 6 * 3600_000).sort((a, b) => b.at - a.at)[0];
  if (planned) {
    const by = who1074(planned.message);
    const kind = by === "Windows Update" ? "update" : "planned";
    return { at: bootAt, kind, by, text: by ? `Restarted ${when} by ${by}` : `Restarted ${when}` };
  }
  return { at: bootAt, kind: "unknown", by: null, text: `Restarted ${when}` };
}

// ---------- Windows: the card's rows ----------
const secs = (s) => (s === 0 ? "never" : s == null ? "?" : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round((s / 3600) * 10) / 10} h`);
const LID = { 0: "does nothing", 1: "sleeps", 2: "hibernates", 3: "shuts down" };
const both = (s, f, battery) => (battery ? `on power ${f(s.ac)}, on battery ${f(s.dc)}` : `on power ${f(s.ac)}`);
const zeroOk = (s, battery) => !s || (s.ac === 0 && (!battery || s.dc === 0));

/** Rows for Windows from what was read. Every row: { id, title, ok, detail, fixable }. */
export function windowsItems({ cfg, net = [], reg = {}, tasks = [], keep = null, state }) {
  const battery = state.battery;
  const items = [];
  const g = (k) => getSetting(cfg, k);
  if (!cfg?.scheme) {
    items.push({ id: "sleep", title: "Sleep and hibernate off", ok: false, detail: "Couldn't read the power settings (powercfg gave no answer).", fixable: true });
  }
  const scheme = cfg?.scheme;
  if (scheme) {
    const saver = scheme.guid === SCHEME.powerSaver;
    items.push({ id: "plan", title: "Power plan", ok: !saver, detail: saver ? `"${scheme.name}" slows the machine down; Balanced is used instead.` : `${scheme.name || "Active plan"}. The screen is still allowed to turn off.`, fixable: saver });
    const st = g("standby"), hb = g("hibernate");
    const sleepOk = zeroOk(st, battery) && zeroOk(hb, battery);
    items.push({
      id: "sleep", title: "Sleep and hibernate off", ok: sleepOk, fixable: !sleepOk,
      detail: st || hb ? `Sleep ${both(st ?? { ac: null, dc: null }, secs, battery)}; hibernate ${both(hb ?? { ac: null, dc: null }, secs, battery)}.` : "Not on this hardware.",
    });
    const lid = g("lid");
    const lidOk = zeroOk(lid, battery);
    items.push({ id: "lid", title: "Closing the lid does nothing", ok: lidOk, fixable: !lidOk, detail: lid ? `Closing the lid ${LID[lid.ac] ?? "?"} on power${battery ? `, ${LID[lid.dc] ?? "?"} on battery` : ""}.` : "No lid on this machine." });
    const disk = g("disk"), usb = g("usb");
    const diskOk = zeroOk(disk, battery) && zeroOk(usb, battery);
    items.push({
      id: "disk", title: "Disk and USB stay powered", ok: diskOk, fixable: !diskOk,
      detail: `Hard disk off after ${disk ? both(disk, secs, battery) : "n/a"}; USB selective suspend ${usb ? both(usb, (v) => (v === 0 ? "off" : "on"), battery) : "n/a"}.`,
    });
  }
  const wifiPm = g("wifi");
  const asleep = net.filter((n) => n.allow === "Enabled");
  const netOk = asleep.length === 0 && zeroOk(wifiPm, battery);
  items.push({
    id: "net", title: "Wi-Fi never powered down", ok: netOk, fixable: !netOk,
    detail: net.length ? (asleep.length ? `Windows may turn off: ${asleep.map((n) => n.name).join(", ")}.` : `${net.map((n) => n.name).join(", ")}: can't be turned off to save power.`) + (wifiPm && wifiPm.ac !== 0 ? " Wi-Fi power saving is on." : "") : "No network adapter was found.",
  });
  const u = updateStatus(reg, state.activeHours);
  items.push({
    id: "update", title: "Windows Update restarts", ok: u.ok, fixable: !u.ok,
    detail: u.ok ? `No restarts ${hh(state.activeHours.start)} to ${hh(state.activeHours.end)}; notifies before restarting.` : `${u.current ? `Active hours are ${hh(u.current.start)} to ${hh(u.current.end)}` : "Active hours aren't set"}, so Windows can restart in the night. Wanted: ${hh(state.activeHours.start)} to ${hh(state.activeHours.end)}.`,
  });
  const found = tasks.filter((t) => t.found);
  const bootOk = tasks.length > 0 && found.length === tasks.length && found.every((t) => t.boot && /SYSTEM/i.test(t.user) );
  items.push({
    id: "boot", title: "Starts at boot, no sign-in", ok: bootOk, fixable: false,
    detail: bootOk ? "The worker and console are scheduled to start with Windows, as SYSTEM." : tasks.length ? `Check: ${tasks.filter((t) => !t.found || !t.boot || !/SYSTEM/i.test(t.user)).map((t) => t.name).join(", ")}. Run the installer again to repair.` : "Couldn't read the scheduled tasks.",
  });
  items.push(keepAwakeItem(keep, "Windows won't idle-sleep while the server runs, even if a setting above is reverted. It doesn't hold the lid open, so keep the lid setting above."));
  return items;
}
export function keepAwakeItem(keep, okDetail) {
  const ok = Boolean(keep?.running);
  return { id: "keepawake", title: "Keep awake while running", ok, fixable: true, detail: ok ? okDetail : keep?.enabled === false ? "Turned off." : "Not running yet." };
}
/** Fix commands for a Windows row. */
export function windowsFix(id, state, { scheme } = {}) {
  switch (id) {
    case "plan": return [{ cmd: "powercfg", args: ["/setactive", "SCHEME_BALANCED"] }];
    case "sleep": return powercfgZero(["standby", "hibernate"], state);
    case "lid": return powercfgZero(["lid"], state);
    case "disk": return powercfgZero(["disk", "usb"], state);
    case "net": return [ps(PS_NET_FIX), ...powercfgZero(["wifi"], state)];
    case "update": return updateCommands(state.activeHours);
    default: return [];
  }
}
export const WIN_FIXABLE = ["plan", "sleep", "lid", "disk", "net", "update", "keepawake"];

// ---------- Ubuntu ----------
export const LINUX_TARGETS = ["sleep.target", "suspend.target", "hibernate.target", "hybrid-sleep.target"];
/** The last value of key in a list of config texts (later files win), in a [Section] if given. */
export function lastIni(texts, key, section = null) {
  let val = null, sec = null;
  for (const t of texts) for (const raw of String(t ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const s = /^\[(.+)\]$/.exec(line);
    if (s) { sec = s[1]; continue; }
    const m = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (m && m[1].toLowerCase() === key.toLowerCase() && (section === null || sec === section)) val = m[2].trim();
  }
  return val;
}
/** Lid handling from logind configs: { battery, power, docked } (systemd's defaults when unset). */
export function logindLid(texts) {
  const base = lastIni(texts, "HandleLidSwitch", "Login") ?? "suspend";
  return { battery: base, power: lastIni(texts, "HandleLidSwitchExternalPower", "Login") ?? base, docked: lastIni(texts, "HandleLidSwitchDocked", "Login") ?? "ignore" };
}
/** `Unattended-Upgrade::Automatic-Reboot "true";` -> true. Later files win; unset is false. */
export function aptAutoReboot(texts) {
  let v = false;
  for (const t of texts) for (const m of String(t ?? "").matchAll(/Unattended-Upgrade::Automatic-Reboot\s+"?(true|false)"?\s*;/gi)) v = m[1].toLowerCase() === "true";
  return v;
}
export function linuxItems({ lidTexts, targets = [], nm = null, aptTexts = [], units = [], keep = null, rebootRequired = false }) {
  const lid = logindLid(lidTexts);
  const lidOk = lid.battery === "ignore" && lid.power === "ignore" && lid.docked === "ignore";
  const masked = LINUX_TARGETS.filter((_, i) => targets[i] === "masked");
  const sleepOk = masked.length === LINUX_TARGETS.length;
  const items = [
    { id: "lid", title: "Closing the lid does nothing", ok: lidOk, fixable: !lidOk, detail: lidOk ? "logind ignores the lid (battery, power and docked)." : `logind: lid ${lid.battery}, on power ${lid.power}, docked ${lid.docked}.` },
    { id: "sleep", title: "Sleep and hibernate off", ok: sleepOk, fixable: !sleepOk, detail: sleepOk ? "sleep, suspend, hibernate and hybrid-sleep are masked." : `Not masked: ${LINUX_TARGETS.filter((t) => !masked.includes(t)).join(", ")}.` },
  ];
  if (nm !== null) {
    const ok = nm === "2";
    items.push({ id: "wifi", title: "Wi-Fi never powered down", ok, fixable: !ok, detail: ok ? "NetworkManager wifi.powersave is off." : `NetworkManager wifi.powersave is ${nm === "" ? "unset (the driver decides)" : nm}; 2 turns it off.` });
  }
  const reboot = aptAutoReboot(aptTexts);
  items.push({ id: "autoreboot", title: "No automatic restart after updates", ok: !reboot, fixable: reboot, detail: reboot ? "unattended-upgrades restarts the machine by itself." : rebootRequired ? "unattended-upgrades won't restart it. A restart is waiting (updates need it): do it when it suits." : "unattended-upgrades won't restart it." });
  items.push({ id: "boot", title: "Starts at boot", ok: units.length > 0 && units.every((u) => u === "enabled"), fixable: false, detail: units.length && units.every((u) => u === "enabled") ? "The worker and console are enabled in systemd." : "Run the installer again to repair the services." });
  items.push(keepAwakeItem(keep, "A sleep/idle inhibitor lock is held while the console runs."));
  return items;
}
/** The helper's argument for a Linux row (it only knows these). */
export const LINUX_FIX = { lid: "lid", sleep: "sleep", wifi: "wifi", autoreboot: "autoreboot" };
export const LINUX_FIXABLE = ["lid", "sleep", "wifi", "autoreboot", "keepawake"];
export const linuxFix = (id) => (LINUX_FIX[id] ? [{ cmd: "sudo", args: ["-n", LINUX_HELPER, LINUX_FIX[id]] }] : []);

// ---------- Mac ----------
/** `pmset -g custom`: { ac: {sleep, disksleep, displaysleep}, battery: {...} } (minutes, 0 = never). */
export function parsePmsetCustom(text) {
  const out = { ac: {}, battery: {} };
  let sec = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (/^AC Power:/i.test(line)) { sec = out.ac; continue; }
    if (/^Battery Power:/i.test(line)) { sec = out.battery; continue; }
    const m = /^(\w+)\s+(\d+)\b/.exec(line);
    if (sec && m) sec[m[1]] = Number(m[2]);
  }
  return out;
}
/** `pmset -g`: SleepDisabled 1 means `pmset disablesleep 1` is in force (it also holds the lid open). */
export const pmsetSleepDisabled = (text) => /^\s*SleepDisabled\s+1\b/m.test(String(text ?? ""));
export function macItems({ pmsetG, pmsetCustom, caffeinated, login, keep }) {
  const off = pmsetSleepDisabled(pmsetG);
  const c = parsePmsetCustom(pmsetCustom);
  const acNever = c.ac.sleep === 0;
  return [
    { id: "lid", title: "Closing the lid does nothing", ok: off, fixable: !off, detail: off ? "Sleep is disabled (pmset disablesleep), so the Mac keeps running with the lid closed." : "The Mac sleeps with the lid closed." },
    { id: "sleep", title: "Sleep off on power", ok: acNever || off, fixable: !(acNever || off), detail: c.ac.sleep == null ? "Couldn't read the sleep setting." : acNever ? "System sleep on power: never." : off ? `System sleep on power: ${c.ac.sleep} min, but disablesleep overrides it.` : `System sleep on power: after ${c.ac.sleep} min.` },
    { id: "boot", title: "Starts at login", ok: Boolean(login), fixable: false, detail: login ? "The server starts when you sign in (Mac app: Start at login)." : "Turn on Start at login in the Nothing BOT Server app." },
    { id: "keepawake", title: "Keep awake while running", ok: Boolean(caffeinated), fixable: false, detail: caffeinated ? "The console runs under caffeinate, so the Mac doesn't idle-sleep while the server runs." : "Run Set up again from the Nothing BOT Server app to repair." },
  ];
}
export const macFix = (nbsctl) => [{ cmd: "/bin/bash", args: [nbsctl, "awake", "on"], key: "awake-on", timeout: 120_000 }];

// ---------- keep-awake fallback ----------
const ES = 2147483649; // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
/** The process that holds the machine awake while the console runs (and exits when it does), or null (Mac: caffeinate does it). */
export function keepAwakeCommand(platform, parentPid) {
  if (platform === "win32") {
    const script = `Add-Type -Namespace NBS -Name Pw -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; while (Get-Process -Id ${Number(parentPid)} -ErrorAction SilentlyContinue) { [void][NBS.Pw]::SetThreadExecutionState([uint32]${ES}); Start-Sleep -Seconds 30 }`;
    return { cmd: "powershell.exe", args: psArgs(script) };
  }
  if (platform === "linux") return { cmd: "systemd-inhibit", args: ["--what=sleep:idle:handle-lid-switch", "--who=Nothing BOT Server", "--why=The server must stay reachable", "--mode=block", "sleep", "infinity"] };
  return null;
}
export function createKeepAwake({ platform, spawn, parentPid = process.pid, enabled = () => true, retryMs = 15_000, log = () => {} }) {
  let child = null, timer = null, stopped = true, failures = 0;
  const cmd = () => keepAwakeCommand(platform, parentPid);
  function launch() {
    const c = cmd();
    if (!c || stopped) return;
    try {
      child = spawn(c.cmd, c.args);
      child.on?.("error", (e) => { failures++; log(`[power] keep-awake: ${e.message}`); child = null; });
      child.on?.("exit", () => { child = null; if (!stopped) timer = setTimeout(launch, retryMs); timer?.unref?.(); });
    } catch (e) { failures++; log(`[power] keep-awake: ${e.message}`); child = null; }
  }
  return {
    supported: () => cmd() !== null,
    start() { if (!enabled() || !cmd()) return false; stopped = false; if (!child) launch(); return true; },
    stop() { stopped = true; clearTimeout(timer); try { child?.kill?.(); } catch { /* gone */ } child = null; },
    status: () => ({ running: Boolean(child), enabled: enabled(), supported: cmd() !== null, failures }),
  };
}

// ---------- state: what the owner chose ----------
export function normaliseState(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    battery: r.battery === true,
    activeHours: validActiveHours(r.activeHours) ? { start: r.activeHours.start, end: r.activeHours.end } : { ...DEFAULT_ACTIVE_HOURS },
    keepAwake: r.keepAwake !== false,
    applied: r.applied === true,
    appliedAt: Number.isFinite(r.appliedAt) ? r.appliedAt : null,
  };
}
export function readState(readText, file) {
  try { return normaliseState(JSON.parse(readText(file) ?? "null")); } catch { return normaliseState(null); }
}

// ---------- the summary line ("Sleep: off · Lid: ignored · Last restart: 03:32 (Windows Update)") ----------
export function summarise(items, lastRestart) {
  const by = (id) => items.find((i) => i.id === id);
  const parts = [];
  const s = by("sleep"), l = by("lid");
  if (s) parts.push(`Sleep: ${s.ok ? "off" : "on"}`);
  if (l) parts.push(`Lid: ${l.ok ? "ignored" : "sleeps"}`);
  if (lastRestart) {
    const t = lastRestart.text.replace(/^Restarted\s+/, "");
    parts.push(`Last restart: ${lastRestart.by ? t.replace(/\s+by\s+(.*)$/, " ($1)") : t}`);
  }
  const needs = items.filter((i) => !i.ok && i.fixable).length;
  return { text: parts.join(" · "), ok: items.every((i) => i.ok || !i.fixable), needs };
}

// ---------- the machine ----------
/**
 * deps: { platform, run(cmd, args, {timeout}) -> {ok, out}, readText(path) -> string|null, listDir(path) -> string[], exists(path),
 * writeText(path, text), dataDir, nbsctl, macRoot, now(), uptime(), dry, keepAwake: {status(), start(), stop()}, parentLog }
 */
export function createPower(deps) {
  const { platform, run, readText, listDir = () => [], exists = () => false, writeText, dataDir, now = () => Date.now(), uptime = () => 0, dry = false, keepAwake = null } = deps;
  const stateFile = `${dataDir}${platform === "win32" ? "\\" : "/"}${STATE_FILE}`;
  const WIN = platform === "win32", MAC = platform === "darwin";
  const state = () => readState(readText, stateFile);
  const save = (s) => { try { writeText(stateFile, JSON.stringify(s, null, 2) + "\n"); } catch { /* read-only data folder: the settings still apply */ } };
  const cat = (dir, filter = () => true) => { let names = []; try { names = listDir(dir).filter(filter).sort(); } catch { /* none */ } return names.map((n) => readText(`${dir}/${n}`)); };

  async function read() {
    const st = state();
    const keep = keepAwake ? keepAwake.status() : null;
    const bootAt = now() - uptime() * 1000;
    if (WIN) {
      const [q, net, ux, pol, au, ev, tasks] = await Promise.all([
        run("powercfg", ["/q"], { timeout: 15000 }),
        run(...Object.values(ps(PS_NET_READ)), { timeout: 20000 }),
        run("reg", ["query", REG.ux]), run("reg", ["query", REG.policy]), run("reg", ["query", REG.au]),
        run(...Object.values(ps(PS_RESTART_READ)), { timeout: 20000 }),
        run(...Object.values(ps(PS_TASKS_READ)), { timeout: 20000 }),
      ]);
      const items = windowsItems({ cfg: parsePowercfg(q.out), net: parseJsonList(net.out), reg: { ux: parseRegQuery(ux.out), policy: parseRegQuery(pol.out), au: parseRegQuery(au.out) }, tasks: parseJsonList(tasks.out), keep, state: st });
      return { st, items, lastRestart: describeRestart(parseRestartEvents(ev.out), bootAt, now()), pendingRestart: null };
    }
    if (MAC) {
      const [g, custom] = await Promise.all([run("pmset", ["-g"]), run("pmset", ["-g", "custom"])]);
      const agent = readText(`${deps.home ?? ""}/Library/LaunchAgents/app.nothingbot.server.console.plist`) ?? "";
      const items = macItems({ pmsetG: g.out, pmsetCustom: custom.out, caffeinated: /caffeinate/.test(agent), login: exists(`${deps.macRoot ?? ""}/.start-at-login`), keep });
      return { st, items, lastRestart: { at: bootAt, kind: "unknown", by: null, text: `Restarted ${clock(bootAt, now())}` }, pendingRestart: null };
    }
    const [targets, units] = await Promise.all([run("systemctl", ["is-enabled", ...LINUX_TARGETS]), run("systemctl", ["is-enabled", "nothing-bot-server-worker", "nothing-bot-server-console"])]);
    const lidTexts = [readText("/etc/systemd/logind.conf"), ...cat("/etc/systemd/logind.conf.d", (n) => n.endsWith(".conf"))];
    const hasNm = exists("/etc/NetworkManager");
    const nmTexts = hasNm ? [readText("/etc/NetworkManager/NetworkManager.conf"), ...cat("/etc/NetworkManager/conf.d", (n) => n.endsWith(".conf"))] : [];
    const items = linuxItems({
      lidTexts, targets: targets.out.split(/\r?\n/).map((s) => s.trim()), nm: hasNm ? lastIni(nmTexts, "wifi.powersave", "connection") ?? "" : null,
      aptTexts: cat("/etc/apt/apt.conf.d"), units: units.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean), keep, rebootRequired: exists("/var/run/reboot-required"),
    });
    return { st, items, lastRestart: { at: bootAt, kind: "unknown", by: null, text: `Restarted ${clock(bootAt, now())}` }, pendingRestart: exists("/var/run/reboot-required") };
  }

  let cache = null, inflight = null;
  async function view() {
    const r = await read();
    const summary = summarise(r.items, r.lastRestart);
    const v = {
      platform, at: now(), items: r.items, lastRestart: r.lastRestart, pendingRestart: r.pendingRestart, summary,
      options: { battery: r.st.battery, activeHours: r.st.activeHours, canBattery: WIN, canActiveHours: WIN },
      applied: r.st.applied, appliedAt: r.st.appliedAt, dry,
    };
    cache = v;
    return v;
  }

  const fixCommands = (id, st) => {
    if (WIN) return windowsFix(id, st);
    if (MAC) return id === "lid" || id === "sleep" ? macFix(deps.nbsctl) : [];
    return linuxFix(id);
  };
  const fixable = () => (WIN ? WIN_FIXABLE : MAC ? ["lid", "sleep"] : LINUX_FIXABLE);

  /** Runs the fixes for ids (in order), one result each; the same command is never run twice (Mac: both rows are one `awake on`). */
  async function runFixes(ids) {
    const st = state();
    const done = new Set(), results = [];
    for (const id of ids) {
      if (id === "keepawake") {
        if (!dry) { st.keepAwake = true; keepAwake?.start(); }
        results.push({ id, ok: Boolean(keepAwake?.supported?.() ?? true), ...(dry ? { dry: true } : {}) });
        continue;
      }
      const cmds = fixCommands(id, st);
      if (!cmds.length) { results.push({ id, ok: false, error: "Nothing to fix here." }); continue; }
      if (dry) { results.push({ id, ok: true, dry: true }); continue; }
      let ok = true, error = null;
      for (const c of cmds) {
        const key = c.key ?? null;
        if (key && done.has(key)) continue;
        const r = await run(c.cmd, c.args, { timeout: c.timeout ?? 30000 });
        if (key) done.add(key);
        if (!r.ok) { ok = false; error = (r.out || `${c.cmd} failed`).split(/\r?\n/)[0].slice(0, 200); break; }
      }
      results.push({ id, ok, ...(error ? { error } : {}) });
    }
    if (!dry && results.some((r) => r.ok)) save({ ...st, applied: true, appliedAt: now() });
    return results;
  }
  const idsAll = () => fixable();

  const api = {
    view,
    /** Last row summary without touching the machine; refreshes in the background when older than a minute. */
    summary() {
      if ((!cache || now() - cache.at > 60_000) && !inflight) inflight = view().catch(() => {}).finally(() => { inflight = null; });
      return cache ? { ...cache.summary, lastRestart: cache.lastRestart } : null;
    },
    async fix(id) {
      if (!idsAll().includes(id)) throw Object.assign(new Error("Unknown item"), { status: 400 });
      const results = await runFixes([id]);
      return { ok: results.every((r) => r.ok), results, view: await view() };
    },
    /** force: every fixable row; otherwise only the rows that read as needing a fix. */
    async applyAll({ force = false } = {}) {
      let ids = idsAll();
      if (!force) { const cur = await view(); ids = cur.items.filter((i) => !i.ok && i.fixable).map((i) => i.id); }
      const results = ids.length ? await runFixes(ids) : [];
      return { ok: results.every((r) => r.ok), results, view: await view() };
    },
    /** Quietly puts back whatever Windows Update (or anything else) changed. Never on a Mac (it would ask for a password each time). */
    async reassert() {
      if (dry || MAC || !state().applied) return null;
      const cur = await view();
      const ids = cur.items.filter((i) => !i.ok && i.fixable && i.id !== "keepawake").map((i) => i.id);
      if (!ids.length) return { ok: true, results: [] };
      const results = await runFixes(ids);
      return { ok: results.every((r) => r.ok), results };
    },
    async setOptions(patch) {
      const st = state();
      if (patch.battery !== undefined) { if (typeof patch.battery !== "boolean") throw Object.assign(new Error("battery must be true or false"), { status: 400 }); st.battery = patch.battery; }
      if (patch.activeHours !== undefined) {
        const a = { start: Number(patch.activeHours?.start), end: Number(patch.activeHours?.end) };
        if (!validActiveHours(a)) throw Object.assign(new Error("Active hours must be whole hours, 1 to 18 hours long (Windows allows at most 18)."), { status: 400 });
        st.activeHours = a;
      }
      if (!dry) save(st);
      // Already applied once: put the new choice into force now (battery on or off, other hours).
      if (!dry && st.applied && WIN) await api.applyAll();
      return view();
    },
    state,
  };
  return api;
}
