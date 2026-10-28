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
  // Only changed when the owner asks (display) or on a Modern Standby machine (netstandby). Not in the plain "zero" fixes.
  display: ["7516b95f-f776-4464-8c53-06167f40cc99", "3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e"], // Turn off display after (0 = never)
  netstandby: ["fea3413e-7e05-4911-9a71-700331f1c294", "f15576e8-98b7-4186-b944-eafa664402d9"], // Networking connectivity in Standby (0 off, 1 on, 2 managed by Windows)
};
/** `powercfg /q` leaves hidden settings out; this asks for the one in SUB_NONE by name (same output format). */
export const PS_NONE = "SUB_NONE";

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

/** Sets one setting to a value on AC (and DC when asked); the subgroup is given by alias where it has one (SUB_NONE). */
export function powercfgSet(key, value, { battery = false } = {}) {
  const [sub, id] = SETTINGS[key];
  const subArg = key === "netstandby" ? PS_NONE : sub;
  const cmds = [{ cmd: "powercfg", args: ["/setacvalueindex", "SCHEME_CURRENT", subArg, id, String(value)] }];
  if (battery) cmds.push({ cmd: "powercfg", args: ["/setdcvalueindex", "SCHEME_CURRENT", subArg, id, String(value)] });
  cmds.push({ cmd: "powercfg", args: ["/setactive", "SCHEME_CURRENT"] });
  return cmds;
}

/**
 * `powercfg /a`: which sleep states exist. Modern Standby shows as "Standby (S0 Low Power Idle)" in the available list (and the
 * classic S3 in the "not available" list, with the reason). Returns null when the text isn't powercfg's.
 */
export function parsePowercfgA(text) {
  const t = String(text ?? "");
  if (!/sleep states/i.test(t)) return null;
  const cut = t.search(/The following sleep states are not available/i);
  const avail = cut >= 0 ? t.slice(0, cut) : t, not = cut >= 0 ? t.slice(cut) : "";
  return {
    s0: /S0 Low Power Idle/i.test(avail),
    s0Network: /S0 Low Power Idle\)?\s*Network Connected/i.test(avail),
    s3: /\(S3\)/i.test(avail),
    s3Missing: /\(S3\)/i.test(not),
    hibernate: /^\s*Hibernate\s*$/im.test(avail),
  };
}

// ---------- Windows: PowerShell pieces ----------
/** powershell.exe arguments for a script, passed as -EncodedCommand (UTF-16LE base64) so no quoting can go wrong. */
export function psArgs(script) {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}
export const decodePs = (args) => Buffer.from(args[args.length - 1], "base64").toString("utf16le");
const ps = (script) => ({ cmd: "powershell.exe", args: psArgs(script) });

const NET_ADAPTERS = `Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { ($_.HardwareInterface -or $_.PhysicalMediaType -match '802\\.11') -and $_.InterfaceDescription -notmatch 'Bluetooth|Virtual|Hyper-V|VPN|TAP-' }`;
const NET_CLASS = `$cls = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e972-e325-11ce-bfc1-08002be10318}'; $keys = @(Get-ChildItem $cls -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue; [pscustomobject]@{ path = $_.PSPath; id = [string]$p.NetCfgInstanceId; pnp = $p.PnPCapabilities } });`;
/** Adapters (Wi-Fi and Ethernet) with what decides "may Windows turn it off": the PnPCapabilities registry value (matched by NetCfgInstanceId), the driver's own answer, and the real error text when that failed. */
export const PS_NET_READ = `${NET_CLASS} $r = @(${NET_ADAPTERS} | ForEach-Object { $a = $_; $err = ''; $allow = ''; try { $allow = [string](Get-NetAdapterPowerManagement -Name $a.Name -ErrorAction Stop).AllowComputerToTurnOffDevice } catch { $err = [string]$_.Exception.Message }; $k = $keys | Where-Object { $_.id -eq $a.InterfaceGuid } | Select-Object -First 1; [pscustomobject]@{ name = $a.Name; wifi = [bool]($a.PhysicalMediaType -match '802\\.11'); status = [string]$a.Status; allow = $allow; pnp = $(if ($k -and $null -ne $k.pnp) { [string]$k.pnp } else { '' }); error = $err } }); ConvertTo-Json -InputObject $r -Compress`;
/** The fix: the driver's setting (may be unsupported) AND the registry value 24 (0x18) that Windows reads at adapter start. Prints one JSON row per adapter with the real errors. */
export const PS_NET_FIX = `${NET_CLASS} $r = @(${NET_ADAPTERS} | ForEach-Object { $a = $_; $setErr = ''; $regErr = ''; $changed = $false; try { Set-NetAdapterPowerManagement -Name $a.Name -AllowComputerToTurnOffDevice Disabled -ErrorAction Stop } catch { $setErr = [string]$_.Exception.Message }; $k = $keys | Where-Object { $_.id -eq $a.InterfaceGuid } | Select-Object -First 1; if ($k) { try { if ($k.pnp -ne 24) { Set-ItemProperty -LiteralPath $k.path -Name PnPCapabilities -Value 24 -Type DWord -ErrorAction Stop; $changed = $true } } catch { $regErr = [string]$_.Exception.Message } } else { $regErr = 'No registry key for this adapter' }; [pscustomobject]@{ name = $a.Name; setError = $setErr; regError = $regErr; changed = $changed } }); ConvertTo-Json -InputObject $r -Compress`;
/** Restart the Wi-Fi adapters (the console drops for about ten seconds). Names are matched in PowerShell, never built from input. */
export const PS_WIFI_RESTART = `$w = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.PhysicalMediaType -match '802\\.11' }); if ($w.Count -eq 0) { Write-Output 'No Wi-Fi adapter'; exit 3 }; $w | ForEach-Object { Restart-NetAdapter -Name $_.Name -Confirm:$false -ErrorAction Stop }; Write-Output ('Restarted ' + (($w | ForEach-Object { $_.Name }) -join ', '))`;
/** The link, for the watchdog: the Wi-Fi adapter's status and the connection profile's IPv4 connectivity. */
export const PS_LINK_READ = `$a = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.PhysicalMediaType -match '802\\.11' -or $_.Status -eq 'Up' }); $p = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue); [pscustomobject]@{ status = (($a | ForEach-Object { [string]$_.Status }) -join ','); net = (($p | ForEach-Object { [string]$_.IPv4Connectivity }) -join ',') } | ConvertTo-Json -Compress`;
/** Last sleeps and wakes: Power-Troubleshooter 1 (resumed, with the wake source) and Kernel-Power 42/506 (going to sleep), 107/507 (resumed). */
export const PS_SLEEP_READ = `$e = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 1, 42, 107, 506, 507 } -MaxEvents 60 -ErrorAction SilentlyContinue | Where-Object { $_.ProviderName -match 'Kernel-Power|Power-Troubleshooter' } | Select-Object -First 12 | ForEach-Object { [pscustomobject]@{ id = $_.Id; at = ([DateTimeOffset]$_.TimeCreated).ToUnixTimeMilliseconds(); message = [string]$_.Message } }); ConvertTo-Json -InputObject $e -Compress`;
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
export function windowsItems({ cfg, net = [], netErr = "", modern = null, reg = {}, tasks = [], keep = null, state, now = Date.now() }) {
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
  const ns = netStatus(net, wifiPm, battery, netErr);
  items.push({ id: "net", title: "Wi-Fi never powered down", ok: ns.ok, fixable: !ns.ok && net.length > 0, detail: ns.detail });
  if (modern?.s0) {
    const ms = modernStatus(modern, g("netstandby"), g("display"), state);
    items.push({ id: "modern", title: "Network stays up in Modern Standby", ok: ms.ok, fixable: !ms.ok, detail: ms.detail });
  }
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
  items.push(keepAwakeItem(keep, "Windows won't idle-sleep while the server runs, even if a setting above is reverted. It doesn't hold the lid open, so keep the lid setting above.", now));
  return items;
}
/** "20s ago", "3 min ago". */
export function ago(ms, now) {
  const d = Math.max(0, Math.round((now - ms) / 1000));
  return d < 90 ? `${d}s ago` : d < 5400 ? `${Math.round(d / 60)} min ago` : `${Math.round(d / 360) / 10} h ago`;
}
export function keepAwakeItem(keep, okDetail, now = Date.now()) {
  const ok = Boolean(keep?.running) && !keep?.stale;
  let detail;
  if (ok) {
    const bits = ["helper running", keep.pid ? `pid ${keep.pid}` : null, keep.lastTick ? `last tick ${ago(keep.lastTick, now)}` : keep.tickFile ? "waiting for the first tick" : null].filter(Boolean);
    detail = `${bits.join(" · ")}. ${okDetail}`;
  } else if (keep?.enabled === false) detail = "Turned off.";
  else if (keep?.running && keep?.stale) detail = `The helper (pid ${keep.pid ?? "?"}) stopped ticking ${keep.lastTick ? ago(keep.lastTick, now) : "(never ticked)"}; it is being restarted.`;
  else detail = `Not running yet${keep?.failures ? ` (${keep.failures} failed start${keep.failures > 1 ? "s" : ""})` : ""}.${keep?.lastError ? ` ${keep.lastError}` : ""}`;
  return { id: "keepawake", title: "Keep awake while running", ok, fixable: true, detail };
}

// ---------- Windows: Wi-Fi power saving, honestly ----------
const PNP_OFF = 0x18; // PnPCapabilities: bit 3 (no wake-from-sleep management) and bit 4 (the OS may not turn the device off)
const pnpSet = (v) => { const n = Number.parseInt(String(v ?? ""), 10); return Number.isFinite(n) && (n & PNP_OFF) === PNP_OFF; };
const driverOff = (allow) => allow === "Disabled" || allow === "Unsupported";
/**
 * One adapter is fine when ANY of: the registry value is set, or the driver says Disabled/Unsupported and (for Wi-Fi) powercfg's wireless
 * power saving is Maximum Performance. The registry value is read at adapter start, so "pending" = set but the driver still says Enabled.
 */
export function adapterStatus(n, wifiPm, battery = false) {
  const reg = pnpSet(n.pnp);
  const driver = driverOff(n.allow);
  const pmOk = !n.wifi || zeroOk(wifiPm, battery);
  const ok = reg || (driver && pmOk);
  return { ok, reg, driver, pmOk, pending: reg && n.allow === "Enabled" };
}
export function netStatus(net, wifiPm, battery, netErr = "") {
  if (!net.length) return { ok: !netErr, detail: netErr ? `Couldn't read the network adapters: ${netErr}` : "No network adapter was found." };
  const rows = net.map((n) => ({ n, s: adapterStatus(n, wifiPm, battery) }));
  const bad = rows.filter((r) => !r.s.ok);
  const pending = rows.filter((r) => r.s.pending);
  const parts = [];
  for (const { n, s } of rows) {
    if (s.ok) parts.push(`${n.name}: ${s.reg ? "locked on in the registry" : n.allow === "Unsupported" ? "driver can't be turned off" : "turn-off disabled"}${s.pending ? " (applies after the adapter restarts)" : ""}`);
    else parts.push(`${n.name}: ${!s.reg && !s.driver ? `Windows may turn it off${n.allow ? ` (driver says ${n.allow})` : ""}` : "Wi-Fi power saving is on"}${n.error ? `. Windows said: ${n.error}` : ""}`);
  }
  return { ok: bad.length === 0, pending: pending.length > 0, detail: parts.join("; ") + "." };
}
/** Modern Standby (S0): the sleep timeouts don't matter, the network has to stay up when the screen is off. */
export function modernStatus(modern, netstandby, display, state) {
  const netOk = !netstandby || netstandby.ac === 1 || netstandby.ac === 2;
  const dispOk = !state.displayNever || !display || display.ac === 0;
  const parts = ["This laptop uses Modern Standby (S0): it can drop Wi-Fi when the screen turns off"];
  parts.push(netstandby ? `networking in standby is ${netstandby.ac === 1 ? "on" : netstandby.ac === 2 ? "managed by Windows" : "off"}` : "networking-in-standby isn't reported here");
  if (state.displayNever) parts.push(dispOk ? "screen never turns off on power" : "screen still turns off on power");
  return { ok: netOk && dispOk, detail: parts.join("; ") + "." };
}

/** Fix commands for a Windows row. */
export function windowsFix(id, state, { scheme } = {}) {
  switch (id) {
    case "plan": return [{ cmd: "powercfg", args: ["/setactive", "SCHEME_BALANCED"] }];
    case "sleep": return powercfgZero(["standby", "hibernate"], state);
    case "lid": return powercfgZero(["lid"], state);
    case "disk": return powercfgZero(["disk", "usb"], state);
    case "net": return [{ ...ps(PS_NET_FIX), after: netFixOutcome, timeout: 40000 }, ...powercfgZero(["wifi"], state)];
    case "modern": return [...powercfgSet("netstandby", 1, state).slice(0, -1), ...(state.displayNever ? powercfgSet("display", 0, state).slice(0, -1) : []), { cmd: "powercfg", args: ["/setactive", "SCHEME_CURRENT"] }];
    case "update": return updateCommands(state.activeHours);
    default: return [];
  }
}
/** What the net fix printed: a failure only when the registry value couldn't be set; the driver's refusal is a note (Set-NetAdapterPowerManagement is unsupported on many Wi-Fi drivers). */
export function netFixOutcome(out) {
  const rows = parseJsonList(out);
  if (!rows.length) return { error: String(out ?? "").trim().split(/\r?\n/)[0]?.slice(0, 200) || "The adapter script printed nothing." };
  const failed = rows.filter((r) => r.regError);
  const changed = rows.filter((r) => r.changed);
  if (failed.length && failed.length === rows.length) return { error: failed.map((r) => `${r.name}: ${r.regError}`).join("; ").slice(0, 300) };
  const note = [changed.length ? "Applies after the adapter restarts." : "", ...rows.filter((r) => r.setError).map((r) => `${r.name}: ${r.setError.split(/\r?\n/)[0]}`)].filter(Boolean).join(" ").slice(0, 300);
  return { note, restartNeeded: changed.length > 0 };
}
export const WIN_FIXABLE = ["plan", "sleep", "lid", "disk", "net", "modern", "update", "keepawake"];

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
const ES_AWAY = 2147483713; // ... | ES_AWAYMODE_REQUIRED (0x40): where the machine supports it, "away mode" keeps the network and the CPU running with the screen off
export const TICK_SECONDS = 20;
const psq = (t) => String(t).replace(/'/g, "''");
/**
 * The process that holds the machine awake while the console runs (and exits when it does), or null (Mac: caffeinate does it).
 * On Windows it writes the time to tickFile every few seconds, so the console can show (and check) that it is alive.
 */
export function keepAwakeCommand(platform, parentPid, tickFile = null) {
  if (platform === "win32") {
    const tick = tickFile ? `try { Set-Content -LiteralPath '${psq(tickFile)}' -Value ([string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) } catch { }; ` : "";
    const script = `Add-Type -Namespace NBS -Name Pw -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; while (Get-Process -Id ${Number(parentPid)} -ErrorAction SilentlyContinue) { $r = [NBS.Pw]::SetThreadExecutionState([uint32]${ES_AWAY}); if ($r -eq 0) { [void][NBS.Pw]::SetThreadExecutionState([uint32]${ES}) }; ${tick}Start-Sleep -Seconds ${TICK_SECONDS} }`;
    return { cmd: "powershell.exe", args: psArgs(script) };
  }
  if (platform === "linux") return { cmd: "systemd-inhibit", args: ["--what=sleep:idle:handle-lid-switch", "--who=Nothing BOT Server", "--why=The server must stay reachable", "--mode=block", "sleep", "infinity"] };
  return null;
}
export function createKeepAwake({ platform, spawn, parentPid = process.pid, enabled = () => true, retryMs = 15_000, log = () => {}, tickFile = null, readText = () => null, now = () => Date.now(), staleMs = 90_000 }) {
  let child = null, timer = null, stopped = true, failures = 0, startedAt = 0, lastError = null;
  const tf = platform === "win32" ? tickFile : null;
  const cmd = () => keepAwakeCommand(platform, parentPid, tf);
  const lastTick = () => { if (!tf) return null; const n = Number(String(readText(tf) ?? "").trim()); return Number.isFinite(n) && n > 0 ? n : null; };
  function launch() {
    const c = cmd();
    if (!c || stopped) return;
    try {
      const k = spawn(c.cmd, c.args);
      child = k; startedAt = now();
      log(`[power] keep-awake helper started (pid ${k?.pid ?? "?"})`);
      k.on?.("error", (e) => { failures++; lastError = e.message; log(`[power] keep-awake: ${e.message}`); if (child === k) child = null; });
      k.on?.("exit", (code) => { if (child === k) child = null; log(`[power] keep-awake helper exited (${code ?? "?"})`); if (!stopped) { timer = setTimeout(launch, retryMs); timer?.unref?.(); } });
    } catch (e) { failures++; lastError = e.message; log(`[power] keep-awake: ${e.message}`); child = null; }
  }
  const status = () => {
    const lt = lastTick();
    const stale = Boolean(child && tf && now() - Math.max(lt ?? 0, startedAt) > staleMs);
    return { running: Boolean(child), enabled: enabled(), supported: cmd() !== null, failures, lastError, pid: child?.pid ?? null, startedAt: child ? startedAt : null, lastTick: lt, tickFile: tf, stale };
  };
  return {
    supported: () => cmd() !== null,
    start() { if (!enabled() || !cmd()) return false; stopped = false; if (!child) launch(); return true; },
    stop() { stopped = true; clearTimeout(timer); try { child?.kill?.(); } catch { /* gone */ } child = null; },
    status,
    /** Called every half minute: a helper that stopped ticking is killed (its exit restarts it); one that never started is started. */
    check() {
      if (stopped || !enabled()) return status();
      if (!child) { clearTimeout(timer); launch(); return status(); }
      if (status().stale) { log(`[power] keep-awake helper (pid ${child.pid ?? "?"}) stopped ticking; restarting it`); try { child.kill?.(); } catch { /* gone */ } child = null; clearTimeout(timer); launch(); }
      return status();
    },
  };
}

// ---------- net operations: the link, and restarting Wi-Fi ----------
/** "up" | "limited" (connected, no internet) | "disconnected" | "unknown" from the platform's link text. */
export function parseLink(platform, text) {
  const t = String(text ?? "").trim();
  if (!t) return "unknown";
  if (platform === "win32") {
    let j; try { j = JSON.parse(t); } catch { return "unknown"; }
    const st = String(j?.status ?? "").split(",").filter(Boolean), net = String(j?.net ?? "");
    if (!st.includes("Up")) return "disconnected";
    return /Internet/i.test(net) ? "up" : "limited";
  }
  if (platform === "linux") {
    const l = t.split(/\r?\n/)[0].toLowerCase();
    if (/local only|site only|connecting/.test(l)) return "limited";
    if (/disconnected|asleep/.test(l)) return "disconnected";
    return l.startsWith("connected") ? "up" : "unknown";
  }
  // Mac: networksetup -getairportnetwork <dev>. Called only while the probe fails, so "associated" means connected without internet.
  if (/not associated|off\./i.test(t)) return "disconnected";
  return /Current (Wi-Fi|AirPort) Network/i.test(t) ? "limited" : "unknown";
}
/** The Wi-Fi device (en0) from `networksetup -listallhardwareports`. */
export function parseMacWifiDevice(text) {
  return /Hardware Port:\s*(?:Wi-Fi|AirPort)\s*\r?\n\s*Device:\s*(\w+)/i.exec(String(text ?? ""))?.[1] ?? null;
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
export function createNetOps({ platform, run, wait = sleepMs }) {
  const macDev = async () => parseMacWifiDevice((await run("networksetup", ["-listallhardwareports"])).out) ?? "en0";
  return {
    async link() {
      if (platform === "win32") return parseLink(platform, (await run(...Object.values(ps(PS_LINK_READ)), { timeout: 20000 })).out);
      if (platform === "linux") return parseLink(platform, (await run("nmcli", ["-t", "-f", "STATE", "general"])).out);
      return parseLink(platform, (await run("networksetup", ["-getairportnetwork", await macDev()])).out);
    },
    /** Turns the Wi-Fi radio off and on. Windows: Restart-NetAdapter; Ubuntu: the root helper (nmcli radio wifi off/on); Mac: networksetup. */
    async restartWifi() {
      if (platform === "win32") { const c = ps(PS_WIFI_RESTART); const r = await run(c.cmd, c.args, { timeout: 90000 }); return { ok: r.ok, out: r.out }; }
      if (platform === "linux") { const r = await run("sudo", ["-n", LINUX_HELPER, "wifi-restart"], { timeout: 60000 }); return { ok: r.ok, out: r.out }; }
      const dev = await macDev();
      const off = await run("networksetup", ["-setairportpower", dev, "off"]);
      await wait(3000);
      const on = await run("networksetup", ["-setairportpower", dev, "on"]);
      return { ok: off.ok && on.ok, out: (on.ok ? off.out : on.out) };
    },
  };
}

// ---------- network watchdog ----------
export const WD = { tickMs: 30_000, downMs: 180_000, retryMs: 15 * 60_000, gapMs: 120_000, keep: 20 };
/**
 * One watchdog tick, pure. w = { lastTick, downSince, restartedAt, outages: [{kind: "offline"|"gap", start, end|null, restarts, link}] };
 * obs = { online, link }. Returns { w, action: "restart"|null }. Rules: offline for over 3 minutes while the link is disconnected or limited
 * -> restart Wi-Fi once, then at most every 15 minutes. A silence longer than gapMs between ticks is logged as a gap (asleep, off, or the console stopped).
 */
export function watchdogStep(prev, obs, now, cfg = WD) {
  const w = { lastTick: prev?.lastTick ?? null, downSince: prev?.downSince ?? null, restartedAt: prev?.restartedAt ?? null, outages: (prev?.outages ?? []).map((o) => ({ ...o })) };
  const open = () => w.outages.findLast((o) => o.kind === "offline" && o.end == null);
  if (w.lastTick && now - w.lastTick > cfg.gapMs) {
    const o = open(); if (o) o.end = w.lastTick;
    w.outages.push({ kind: "gap", start: w.lastTick, end: now, restarts: 0, link: null });
    w.downSince = null;
  }
  let action = null;
  if (obs.online) {
    const o = open(); if (o) o.end = now;
    w.downSince = null;
  } else {
    if (w.downSince == null) w.downSince = now;
    let o = open();
    if (!o) { o = { kind: "offline", start: w.downSince, end: null, restarts: 0, link: obs.link ?? null }; w.outages.push(o); }
    o.link = obs.link ?? o.link;
    if (now - w.downSince >= cfg.downMs && (obs.link === "disconnected" || obs.link === "limited") && (w.restartedAt == null || now - w.restartedAt >= cfg.retryMs)) {
      action = "restart"; w.restartedAt = now; o.restarts++;
    }
  }
  w.lastTick = now;
  if (w.outages.length > cfg.keep) w.outages = w.outages.slice(-cfg.keep);
  return { w, action };
}
/** "Offline 02:10–02:24, Wi-Fi restarted" */
export function describeOutage(o, now) {
  if (o.kind === "gap") return `No heartbeat ${clock(o.start, now)}–${clock(o.end, now)} (asleep, off, or the console stopped)`;
  const span = o.end == null ? `since ${clock(o.start, now)} (still)` : `${clock(o.start, now)}–${clock(o.end, now)}`;
  const by = o.restarts ? `, Wi-Fi restarted${o.restarts > 1 ? ` ${o.restarts}x` : ""}` : o.link === "up" && o.end == null ? ", Wi-Fi connected (not restarted)" : "";
  return `Offline ${span}${by}`;
}
/**
 * deps: { probe() -> bool (DNS + HTTPS), link() -> string, restart() -> {ok, out}, readText, writeText, file, now, enabled, log }.
 * The outage log is a small JSON file (the last 20 entries).
 */
export function createWatchdog({ probe, link, restart, readText, writeText, file, now = () => Date.now(), enabled = () => true, log = () => {}, cfg = WD }) {
  let w = null, busy = false, timer = null, lastObs = null, lastRestartResult = null;
  const load = () => { try { const j = JSON.parse(readText(file) ?? "null"); return j && Array.isArray(j.outages) ? j : { outages: [] }; } catch { return { outages: [] }; } };
  const save = () => { try { writeText(file, JSON.stringify(w) + "\n"); } catch { /* read-only data folder */ } };
  async function tick() {
    if (busy || !enabled()) return null;
    busy = true;
    try {
      w ??= load();
      const online = await probe();
      const l = online ? "up" : await link();
      lastObs = { online, link: l, at: now() };
      const r = watchdogStep(w, { online, link: l }, now(), cfg);
      w = r.w; save();
      if (r.action === "restart") {
        log(`[power] offline for over ${Math.round(cfg.downMs / 60000)} min (${l}): restarting Wi-Fi`);
        const x = await restart();
        lastRestartResult = { ok: x.ok, at: now(), out: x.out };
        if (!x.ok) log(`[power] Wi-Fi restart failed: ${(x.out || "").split(/\r?\n/)[0]}`);
      }
      return r.action;
    } finally { busy = false; }
  }
  return {
    tick,
    start() { if (timer) return; tick().catch(() => {}); timer = setInterval(() => { tick().catch(() => {}); }, cfg.tickMs); timer.unref?.(); },
    stop() { clearInterval(timer); timer = null; },
    status() {
      const cur = w ?? load();
      const at = now();
      return { enabled: enabled(), running: Boolean(timer), lastTick: cur.lastTick ?? null, online: lastObs?.online ?? null, link: lastObs?.link ?? null, lastRestart: lastRestartResult,
        outages: cur.outages.slice(-5).reverse().map((o) => ({ ...o, text: describeOutage(o, at) })) };
    },
  };
}

// ---------- the last sleep and wake ----------
/** Windows System-log events -> [{ kind: "sleep"|"wake", at, source }]. */
export function parseSleepEvents(text) {
  return parseJsonList(text).map((e) => {
    const id = Number(e.id), at = Number(e.at), msg = String(e.message ?? "");
    const kind = id === 42 || id === 506 ? "sleep" : id === 1 || id === 107 || id === 507 ? "wake" : null;
    if (!kind || !Number.isFinite(at)) return null;
    return { kind, at, source: kind === "wake" ? /Wake Source:\s*(.+)/i.exec(msg)?.[1]?.trim() ?? null : null };
  }).filter(Boolean);
}
/** Ubuntu: `journalctl -k -o short-unix` lines "PM: suspend entry" / "PM: suspend exit". */
export function parseSleepJournal(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^(\d+)(?:\.\d+)?\s.*PM: suspend (entry|exit)/.exec(line);
    if (m) out.push({ kind: m[2] === "entry" ? "sleep" : "wake", at: Number(m[1]) * 1000, source: null });
  }
  return out;
}
/** Mac: `pmset -g log` lines "2026-10-28 02:10:11 +0100 Sleep ..." / "... Wake ...". */
export function parsePmsetLog(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) [+-]\d{4}\s+(Sleep|Wake)\s+(.*)$/.exec(line);
    if (!m) continue;
    const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
    out.push({ kind: m[7].toLowerCase(), at, source: m[7] === "Wake" ? /Wake from ([^[]+?)(?:\s*\[|\s*due|$)/i.exec(m[8])?.[1]?.trim() ?? null : null });
  }
  return out;
}
export function describeSleep(events, now = Date.now()) {
  const ev = [...events].sort((a, b) => b.at - a.at);
  const slept = ev.find((e) => e.kind === "sleep"), woke = ev.find((e) => e.kind === "wake");
  if (!slept && !woke) return { sleptAt: null, wokeAt: null, source: null, text: "No sleep or wake in the system log." };
  const bits = [];
  if (slept) bits.push(`slept ${clock(slept.at, now)}`);
  if (woke) bits.push(`woke ${clock(woke.at, now)}${woke.source ? ` (${woke.source})` : ""}`);
  return { sleptAt: slept?.at ?? null, wokeAt: woke?.at ?? null, source: woke?.source ?? null, text: `Last ${bits.join(", ")}` };
}

// ---------- state: what the owner chose ----------
/** Rows the owner can turn off (the boot row can't be: it only reports). */
export const ENFORCE_IDS = ["plan", "sleep", "lid", "disk", "net", "modern", "update", "keepawake", "wifi", "autoreboot", "watchdog"];
/** Is the block open? The owner's last choice stands while the machine is in the state it was in when they chose; otherwise open exactly when something needs fixing. */
export function blockOpen(ui, needs) {
  const bad = needs > 0;
  if (!ui || typeof ui.open !== "boolean" || ui.forNeeds !== bad) return bad;
  return ui.open;
}
export function normaliseState(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const enforce = {};
  for (const id of ENFORCE_IDS) if (r.enforce?.[id] === false) enforce[id] = false;
  const ui = r.ui && typeof r.ui.open === "boolean" && typeof r.ui.forNeeds === "boolean" ? { open: r.ui.open, forNeeds: r.ui.forNeeds } : null;
  return {
    battery: r.battery === true,
    activeHours: validActiveHours(r.activeHours) ? { start: r.activeHours.start, end: r.activeHours.end } : { ...DEFAULT_ACTIVE_HOURS },
    keepAwake: r.keepAwake !== false && enforce.keepawake !== false,
    displayNever: r.displayNever === true,
    enforce, ui,
    applied: r.applied === true,
    appliedAt: Number.isFinite(r.appliedAt) ? r.appliedAt : null,
  };
}
/** Rows the owner turned off stay in the list (so they can be turned back on) but never warn and are never fixed. */
export function applyEnforce(items, state) {
  return items.map((i) => (state.enforce?.[i.id] === false ? { ...i, ok: true, fixable: false, ignored: true } : { ...i, ignored: false }));
}
export function readState(readText, file) {
  try { return normaliseState(JSON.parse(readText(file) ?? "null")); } catch { return normaliseState(null); }
}

/** The watchdog's row: always fine (it only reports), with the last outage in the text. */
export function watchdogItem(wd, now = Date.now()) {
  const last = wd?.outages?.[0];
  const base = "Checks the internet every 30 s (DNS and HTTPS to Google); if it is down over 3 min with the link down, restarts Wi-Fi (at most every 15 min).";
  const detail = !wd ? "Not running." : `${base}${last ? ` Last: ${last.text}.` : " No outages logged."}${wd.link && wd.online === false ? ` Offline now (link ${wd.link}).` : ""}`;
  void now;
  return { id: "watchdog", title: "Network watchdog", ok: true, fixable: false, detail };
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
  const { platform, run, readText, listDir = () => [], exists = () => false, writeText, dataDir, now = () => Date.now(), uptime = () => 0, dry = false, keepAwake = null, watchdog = null, netOps = null } = deps;
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
      const [q, qh, a, net, ux, pol, au, ev, tasks, sl] = await Promise.all([
        run("powercfg", ["/q"], { timeout: 15000 }),
        run("powercfg", ["/qh", "SCHEME_CURRENT", PS_NONE, SETTINGS.netstandby[1]], { timeout: 15000 }),
        run("powercfg", ["/a"], { timeout: 15000 }),
        run(...Object.values(ps(PS_NET_READ)), { timeout: 30000 }),
        run("reg", ["query", REG.ux]), run("reg", ["query", REG.policy]), run("reg", ["query", REG.au]),
        run(...Object.values(ps(PS_RESTART_READ)), { timeout: 20000 }),
        run(...Object.values(ps(PS_TASKS_READ)), { timeout: 20000 }),
        run(...Object.values(ps(PS_SLEEP_READ)), { timeout: 20000 }),
      ]);
      const cfg = parsePowercfg(q.out);
      const hidden = parsePowercfg(qh.out);
      for (const [k, v] of Object.entries(hidden.settings)) if (!cfg.settings[k]) cfg.settings[k] = v;
      const netList = parseJsonList(net.out);
      const netErr = !net.ok ? (net.out || "the adapter query failed").split(/\r?\n/)[0].slice(0, 200) : !netList.length && /\S/.test(net.out) && net.out.trim() !== "[]" ? net.out.trim().split(/\r?\n/)[0].slice(0, 200) : "";
      const items = windowsItems({ cfg, net: netList, netErr, modern: parsePowercfgA(a.out), reg: { ux: parseRegQuery(ux.out), policy: parseRegQuery(pol.out), au: parseRegQuery(au.out) }, tasks: parseJsonList(tasks.out), keep, state: st, now: now() });
      return { st, items, lastRestart: describeRestart(parseRestartEvents(ev.out), bootAt, now()), pendingRestart: null, sleep: describeSleep(parseSleepEvents(sl.out), now()), modern: parsePowercfgA(a.out)?.s0 === true };
    }
    if (MAC) {
      const [g, custom] = await Promise.all([run("pmset", ["-g"]), run("pmset", ["-g", "custom"])]);
      const agent = readText(`${deps.home ?? ""}/Library/LaunchAgents/app.nothingbot.server.console.plist`) ?? "";
      const items = macItems({ pmsetG: g.out, pmsetCustom: custom.out, caffeinated: /caffeinate/.test(agent), login: exists(`${deps.macRoot ?? ""}/.start-at-login`), keep });
      const pl = await run("pmset", ["-g", "log"], { timeout: 20000 });
      return { st, items, lastRestart: { at: bootAt, kind: "unknown", by: null, text: `Restarted ${clock(bootAt, now())}` }, pendingRestart: null, sleep: describeSleep(parsePmsetLog(pl.out), now()), modern: false };
    }
    const [targets, units] = await Promise.all([run("systemctl", ["is-enabled", ...LINUX_TARGETS]), run("systemctl", ["is-enabled", "nothing-bot-server-worker", "nothing-bot-server-console"])]);
    const lidTexts = [readText("/etc/systemd/logind.conf"), ...cat("/etc/systemd/logind.conf.d", (n) => n.endsWith(".conf"))];
    const hasNm = exists("/etc/NetworkManager");
    const nmTexts = hasNm ? [readText("/etc/NetworkManager/NetworkManager.conf"), ...cat("/etc/NetworkManager/conf.d", (n) => n.endsWith(".conf"))] : [];
    const items = linuxItems({
      lidTexts, targets: targets.out.split(/\r?\n/).map((s) => s.trim()), nm: hasNm ? lastIni(nmTexts, "wifi.powersave", "connection") ?? "" : null,
      aptTexts: cat("/etc/apt/apt.conf.d"), units: units.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean), keep, rebootRequired: exists("/var/run/reboot-required"),
    });
    const jl = await run("journalctl", ["-k", "--since", "-7 days", "-o", "short-unix", "--no-pager", "-g", "PM: suspend (entry|exit)"], { timeout: 15000 });
    return { st, items, lastRestart: { at: bootAt, kind: "unknown", by: null, text: `Restarted ${clock(bootAt, now())}` }, pendingRestart: exists("/var/run/reboot-required"), sleep: describeSleep(parseSleepJournal(jl.out), now()), modern: false };
  }

  let cache = null, inflight = null;
  async function view() {
    const r = await read();
    const wd = watchdog ? watchdog.status() : null;
    const withWd = [...r.items, watchdogItem(wd, now())];
    const items = applyEnforce(withWd, r.st);
    const summary = summarise(items, r.lastRestart);
    const toggles = items.filter((i) => ENFORCE_IDS.includes(i.id)).map((i) => ({ id: i.id, title: i.title, on: !i.ignored }));
    const v = {
      platform, at: now(), items, lastRestart: r.lastRestart, pendingRestart: r.pendingRestart, summary, sleep: r.sleep ?? null,
      options: { battery: r.st.battery, activeHours: r.st.activeHours, canBattery: WIN, canActiveHours: WIN, displayNever: r.st.displayNever, canDisplay: Boolean(r.modern) },
      toggles, open: blockOpen(r.st.ui, summary.needs), watchdog: wd, canRestartNet: true,
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
      let ok = true, error = null, note = null;
      for (const c of cmds) {
        const key = c.key ?? null;
        if (key && done.has(key)) continue;
        const r = await run(c.cmd, c.args, { timeout: c.timeout ?? 30000 });
        if (key) done.add(key);
        if (c.after) {
          const o = c.after(r.out) ?? {};
          if (o.note) note = o.note;
          if (o.error) { ok = false; error = o.error; break; }
          continue; // the script's own errors are judged by after(), not by its exit code
        }
        if (!r.ok) { ok = false; error = (r.out || `${c.cmd} failed`).split(/\r?\n/)[0].slice(0, 200); break; }
      }
      results.push({ id, ok, ...(error ? { error } : {}), ...(note ? { note } : {}) });
    }
    if (!dry && results.some((r) => r.ok)) save({ ...st, applied: true, appliedAt: now() });
    return results;
  }
  const idsAll = () => fixable();
  const enforced = (ids, st) => ids.filter((id) => st.enforce[id.toLowerCase()] !== false);

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
      let ids = enforced(idsAll(), state());
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
      if (patch.displayNever !== undefined) { if (typeof patch.displayNever !== "boolean") throw Object.assign(new Error("displayNever must be true or false"), { status: 400 }); st.displayNever = patch.displayNever; }
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
    /** Turns enforcing one row on or off. Off: it never warns, is never fixed, and (keep-awake, watchdog) its helper stops. */
    async setEnforce(id, on) {
      if (!ENFORCE_IDS.includes(id)) throw Object.assign(new Error("Unknown item"), { status: 400 });
      if (typeof on !== "boolean") throw Object.assign(new Error("on must be true or false"), { status: 400 });
      const st = state();
      if (on) delete st.enforce[id]; else st.enforce[id] = false;
      if (id === "keepawake") {
        st.keepAwake = on;
        if (!dry) { if (on) keepAwake?.start(); else keepAwake?.stop(); }
      }
      if (!dry) save(st);
      return view();
    },
    /** The owner opened or closed the block: remembered while the machine stays in the same good/bad state. */
    async setUi(open) {
      if (typeof open !== "boolean") throw Object.assign(new Error("open must be true or false"), { status: 400 });
      const cur = await view();
      const st = state();
      st.ui = { open, forNeeds: cur.summary.needs > 0 };
      if (!dry) save(st);
      return view();
    },
    /** Restarts the Wi-Fi radio now (the console drops for a few seconds). */
    async restartNet() {
      if (!netOps) throw Object.assign(new Error("Not available here"), { status: 400 });
      if (dry) return { ok: true, results: [{ id: "restart-net", ok: true, dry: true }], view: await view() };
      const r = await netOps.restartWifi();
      return { ok: r.ok, results: [{ id: "restart-net", ok: r.ok, ...(r.ok ? { note: (r.out || "Wi-Fi restarted.").split(/\r?\n/)[0].slice(0, 200) } : { error: (r.out || "The restart failed.").split(/\r?\n/)[0].slice(0, 200) }) }], view: await view() };
    },
    state,
  };
  return api;
}
