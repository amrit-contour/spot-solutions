#!/usr/bin/env node
// Where should Nothing BOT Server keep its data and AI models? The installers' data-location step, one copy for Windows, macOS and Ubuntu.
//
// The installers (install.ps1, install.sh, nbsctl setup) fetch this file next to the installer, run it once Node is present, and read
// the answer from --out. Node built-ins only. It
//   - lists the disks with free space and pre-selects the one with the most room (one Enter accepts it),
//   - refuses cloud-synced folders (OneDrive, iCloud Drive, Dropbox, Google Drive...), removable / USB / network drives and the
//     program folder, with one line on why,
//   - shows free space against what is needed (about 5 GB with the default model) and asks before going ahead on less,
//   - writes the same data-dir / models-dir pointer files the console's "Move data" writes (apps/worker/console/move.mjs), into the
//     same state folder, which every launcher and updater already reads.
// Only fresh installs ask. An existing pointer, or an install that is already there, is kept as it is.
//
//   node datadir.mjs choose --state-dir D --program-root R --default-data P [--default-models P] [--program-dir P] [--forbid P ...]
//        [--model gemma3:4b] [--no-local] [--no-models] [--data-dir PATH] [--yes] [--out result.json]
//   node datadir.mjs list    the disks it sees and what it would suggest (touches nothing)
//
// Unattended: --data-dir PATH (or env NBS_DATA_DIR) uses that folder, still refusing the bad places; --yes (or NBS_YES=1) accepts the
// suggestion. With neither, and nobody to ask, the default folder is used.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, openSync, closeSync, createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";

const execP = promisify(execFile);
export const GB = 1e9;
export const DEFAULT_MODEL = "gemma3:4b";
/** The folders under the chosen base folder, so the data and the models sit side by side (Windows' default layout too). */
export const DATA_SUB = "data";
export const MODELS_SUB = "ollama";
/** What the server itself needs besides the model: WhatsApp logins, backups, logs, a spare. */
export const DATA_BYTES = 1.7 * GB;
/** Gemini-only server: no model, just the data. */
export const DATA_ONLY_BYTES = 2 * GB;
/** Download sizes of the models people use, in bytes. An unknown model is estimated from its parameter count, else the default's. */
const MODEL_BYTES = { "gemma3:270m": 0.29 * GB, "gemma3:1b": 0.82 * GB, "gemma3:4b": 3.3 * GB, "gemma3:12b": 8.1 * GB, "gemma3:27b": 17 * GB, "gemma3n:e2b": 5.6 * GB, "gemma3n:e4b": 7.5 * GB };

/** Bytes the data and the model need, in total. About 5 GB with gemma3:4b. */
export function requiredBytes({ model = DEFAULT_MODEL, noLocal = false, modelsPresent = false } = {}) {
  if (noLocal) return DATA_ONLY_BYTES;
  if (modelsPresent) return DATA_BYTES;
  const name = String(model || DEFAULT_MODEL).toLowerCase();
  let m = MODEL_BYTES[name] ?? MODEL_BYTES[name.replace(/-.*$/, "")] ?? null;
  if (m == null) {
    const b = /:(\d+(?:\.\d+)?)b\b/.exec(name);
    m = b ? Number(b[1]) * 0.82 * GB : MODEL_BYTES[DEFAULT_MODEL];
  }
  return Math.round(m + DATA_BYTES);
}
export const fmtSize = (b) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : b >= 1e9 ? `${(b / 1e9).toFixed(b >= 1e11 ? 0 : 1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

// ---------- paths ----------
const modFor = (platform) => (platform === "win32" ? path.win32 : path.posix);
const caseInsensitive = (platform) => platform === "win32" || platform === "darwin";
export function pathKey(p, platform = process.platform) {
  const m = modFor(platform);
  let s = m.normalize(String(p));
  if (s.length > m.parse(s).root.length) s = s.replace(/[\\/]+$/, "");
  return caseInsensitive(platform) ? s.toLowerCase() : s;
}
export function isInside(child, parent, platform = process.platform) {
  const c = pathKey(child, platform), p = pathKey(parent, platform);
  if (c === p) return true;
  const sep = modFor(platform).sep;
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}
const segmentsOf = (p, platform) => { const m = modFor(platform); return p.slice(m.parse(p).root.length).split(platform === "win32" ? /[\\/]+/ : /\/+/).filter(Boolean); };

// ---------- the blocklist ----------
/** Folder names that mean "a cloud service keeps a copy of this in sync". WhatsApp's browser profile can't live in one. */
const CLOUD_NAMES = [
  [/^onedrive([ _-].*)?$/i, "OneDrive"],
  [/^dropbox([ _(-].*)?$/i, "Dropbox"],
  [/^(google ?drive|googledrive([ _-].*)?|my drive|shared drives?)$/i, "Google Drive"],
  [/^(icloud ?drive|iclouddrive|mobile documents|com~apple~clouddocs)$/i, "iCloud Drive"],
  [/^(box|box sync)$/i, "Box"],
  [/^pcloud( drive)?$/i, "pCloud"],
  [/^mega(sync)?$/i, "MEGA"],
  [/^cloudstorage$/i, "a cloud storage provider"],
];
const CLOUD_VOLUME_LABELS = /^(google ?drive|onedrive|dropbox|icloud ?drive|pcloud|box)\b/i;
export const cloudWhy = (what) => `${what} keeps this folder in sync and locks files, which would corrupt WhatsApp's login. Pick a folder outside it.`;

/** The name of the cloud service a path sits in (by folder name, or inside the OneDrive* folders Windows reports in the environment), else null. */
export function cloudProvider(p, { platform = process.platform, env = process.env } = {}) {
  if (platform === "win32") {
    for (const k of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) if (env[k] && isInside(p, env[k], platform)) return "OneDrive";
  }
  for (const s of segmentsOf(p, platform)) for (const [re, name] of CLOUD_NAMES) if (re.test(s)) return name;
  return null;
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const WIN_SYSTEM_DIRS = new Set(["windows", "program files", "program files (x86)", "programdata", "$recycle.bin", "system volume information", "recovery"]);
const POSIX_SYSTEM_ROOTS = new Set(["bin", "boot", "dev", "etc", "lib", "lib32", "lib64", "proc", "root", "run", "sbin", "sys", "usr"]);
const MAC_SYSTEM_ROOTS = new Set(["system", "library", "applications", "private", "cores", "bin", "sbin", "usr", "dev", "etc", "var"]);
const MAX_PATH_CHARS = 200;

/** The text of a folder path, no disk: { ok, path } with the cleaned path, or { ok: false, error }. */
export function cleanPath(input, { platform = process.platform, home = os.homedir() } = {}) {
  const fail = (error) => ({ ok: false, error });
  if (typeof input !== "string") return fail("Enter a folder path.");
  let p = input.trim();
  if (/^(["'])(.*)\1$/.test(p)) p = p.slice(1, -1).trim();
  if (!p) return fail("Enter a folder path.");
  if (/[\u0000-\u001f\u007f]/.test(p)) return fail("That path has characters a folder name can't have.");
  const win = platform === "win32";
  const m = modFor(platform);
  if (win) {
    if (/^[\\/]{2}/.test(p)) return fail("That is a network path. Use a folder on a drive inside this computer, like D:\\Nothing BOT Server: WhatsApp's browser needs a local disk.");
    if (!/^[A-Za-z]:[\\/]/.test(p)) return fail("Use the full path, starting with the drive letter, for example D:\\Nothing BOT Server.");
    p = p.replace(/\//g, "\\");
  } else {
    if (p === "~" || p.startsWith("~/")) p = m.join(home, p.slice(1));
    if (!p.startsWith("/")) return fail("Use the full path, starting with /, for example /mnt/disk/nothing-bot-server.");
  }
  const root = m.parse(p).root;
  const segs = segmentsOf(p, platform);
  if (segs.some((s) => s === "..")) return fail("Leave out '..' from the path.");
  const real = segs.filter((s) => s !== ".");
  if (!real.length) return fail("Pick a folder on the drive, not the whole drive.");
  const bad = win ? /[<>:"|?*'`$%&;]/ : /["'`$%&;<>\\]/;
  for (const s of real) {
    if (bad.test(s)) return fail(`Folder names can't contain ${win ? "< > : \" | ? * ' ` $ % & ;" : "\" ' ` $ % & ; < > \\"}. Rename "${s}".`);
    if (win && (/[. ]$/.test(s) || WIN_RESERVED.test(s))) return fail(`"${s}" isn't a name Windows allows for a folder.`);
  }
  let out = m.normalize(p);
  if (out.length > root.length) out = out.replace(/[\\/]+$/, "");
  if (out.length > MAX_PATH_CHARS) return fail(`That path is too long (${out.length} characters; keep it under ${MAX_PATH_CHARS}). WhatsApp's browser profile nests deeply.`);
  const first = real[0].toLowerCase();
  if (win && WIN_SYSTEM_DIRS.has(first)) return fail("Don't use a Windows system folder. Make a folder like D:\\Nothing BOT Server.");
  if (platform === "darwin" && MAC_SYSTEM_ROOTS.has(first) && !(first === "var" && real[1] === "lib")) return fail("Don't use a system folder. Use a folder in your home or on another internal disk.");
  if (platform === "linux" && POSIX_SYSTEM_ROOTS.has(first)) return fail("Don't use a system folder. Use a folder on a data disk, like /mnt/disk/nothing-bot-server.");
  if (platform === "linux" && first === "home" && real.length >= 3) return fail("The server runs as its own account, which can't read inside a user's home folder. Use a folder on a data disk, like /mnt/disk/nothing-bot-server.");
  return { ok: true, path: out };
}

// ---------- disks ----------
/**
 * What a "volume" is here: { mount, device, fsType, free, total, system, removable, network, label, internal }.
 * parseWindowsVolumes / parseMacVolumes / parseLinuxVolumes turn what the system tools print into that; listVolumes runs the tools.
 */
const NETWORK_FS = new Set(["nfs", "nfs4", "cifs", "smb", "smb3", "smbfs", "afpfs", "webdav", "sshfs", "fuse.sshfs", "9p", "afs", "ceph", "glusterfs", "fuse.rclone", "davfs", "davfs2"]);
const LINUX_DATA_FS = new Set(["ext2", "ext3", "ext4", "xfs", "btrfs", "f2fs", "zfs", "jfs", "reiserfs"]);

export function parseWindowsVolumes(json, { systemDrive = "C:" } = {}) {
  let rows;
  try { rows = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(rows)) rows = rows ? [rows] : [];
  return rows.filter((r) => r && /^[A-Za-z]:$/.test(String(r.id ?? ""))).map((r) => {
    const id = String(r.id).toUpperCase();
    const type = Number(r.type);
    const bus = String(r.bus ?? "").toUpperCase();
    return {
      mount: `${id}\\`, device: id, fsType: r.fs ? String(r.fs) : null, free: Number(r.free) || 0, total: Number(r.size) || 0,
      system: id === systemDrive.toUpperCase(), removable: type === 2 || type === 5 || bus === "USB" || bus === "1394", network: type === 4,
      driveType: type, label: r.label ? String(r.label) : "", bus,
    };
  });
}

/** `df -kP` text, `mount` text, and the `diskutil info` text for each mount (a map). */
export function parseMacVolumes(dfText, mountText, infoByMount = {}) {
  const fsTypes = new Map();
  for (const line of String(mountText || "").split("\n")) {
    const m = /^(.*?) on (\/.*?) \(([^)]*)\)\s*$/.exec(line);
    if (m) fsTypes.set(m[2], { source: m[1], type: m[3].split(",")[0].trim().toLowerCase(), opts: m[3] });
  }
  const out = [];
  const rootDevice = String(dfText || "").split("\n").map((l) => l.trim().split(/\s+/)).find((f) => f.length >= 6 && f.slice(5).join(" ") === "/")?.[0] ?? "";
  for (const line of String(dfText || "").split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const mount = f.slice(5).join(" ");
    if (mount !== "/" && !/^\/Volumes\/[^/.][^/]*$/.test(mount)) continue;
    if (/TimeMachine|localsnapshots/i.test(mount)) continue;
    const mt = fsTypes.get(mount) ?? { source: f[0], type: "", opts: "" };
    // Hidden volumes (Recovery...) and other volumes of the system's own APFS container share the system disk's space.
    if (/nobrowse/.test(mt.opts)) continue;
    const container = (d) => /^\/dev\/disk(\d+)s/.exec(d)?.[1];
    if (mount !== "/" && container(f[0]) && container(f[0]) === container(rootDevice)) continue;
    const info = String(infoByMount[mount] ?? "");
    const network = NETWORK_FS.has(mt.type) || /^\/\//.test(f[0]) || /^[^/\s]+:\//.test(f[0]);
    const location = /Device Location:\s*(\w+)/i.exec(info)?.[1]?.toLowerCase();
    const internalFlag = /Internal:\s*(Yes|No)/i.exec(info)?.[1]?.toLowerCase();
    const external = location === "external" || internalFlag === "no" || /Removable Media:\s*Removable/i.test(info) || /Protocol:\s*(USB|Thunderbolt|SD)/i.test(info);
    const system = mount === "/";
    out.push({
      mount, device: f[0], fsType: mt.type || null, free: (Number(f[3]) || 0) * 1024, total: (Number(f[1]) || 0) * 1024,
      system, removable: !system && !network && (external || (!info && mount.startsWith("/Volumes/"))), network, label: system ? "Macintosh HD" : mount.slice("/Volumes/".length), internal: !external,
    });
  }
  return out;
}

const unescapeFindmnt = (s) => s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
/** `findmnt -rb -o TARGET,SOURCE,FSTYPE,AVAIL,SIZE,OPTIONS` text and `lsblk -P -o NAME,PKNAME,RM,HOTPLUG,TRAN` text. */
export function parseLinuxVolumes(findmntText, lsblkText = "") {
  const blk = new Map();
  for (const line of String(lsblkText || "").split("\n")) {
    if (!line.trim()) continue;
    const kv = {};
    for (const m of line.matchAll(/(\w+)="([^"]*)"/g)) kv[m[1]] = m[2];
    if (kv.NAME) blk.set(kv.NAME, kv);
  }
  const removableDevice = (src) => {
    let name = src.replace(/\[.*\]$/, "").replace(/^\/dev\/(mapper\/)?/, "");
    for (let i = 0; i < 6 && name && blk.has(name); i++) {
      const r = blk.get(name);
      if (r.RM === "1" || r.HOTPLUG === "1" || /usb/i.test(r.TRAN || "")) return true;
      name = r.PKNAME;
    }
    return false;
  };
  const seen = new Map();
  for (const line of String(findmntText || "").split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5) continue;
    const mount = unescapeFindmnt(f[0]), device = unescapeFindmnt(f[1]), fsType = f[2].toLowerCase();
    const free = Number(f[3]), total = Number(f[4]), opts = f[5] || "";
    const network = NETWORK_FS.has(fsType) || /^\/\//.test(device) || /^[^/\s]+:\//.test(device);
    if (!network && !device.startsWith("/dev/")) continue;
    if (/^\/dev\/(loop|ram|zram)/.test(device)) continue;
    if (/^\/(boot|snap|run|sys|proc|dev|var\/snap|var\/lib\/(docker|snapd|containers|lxcfs))(\/|$)/.test(mount)) continue;
    if (/(^|,)ro(,|$)/.test(opts)) continue;
    if (!network && !LINUX_DATA_FS.has(fsType) && !["vfat", "exfat", "ntfs", "ntfs3", "fuseblk", "msdos"].includes(fsType)) continue;
    const v = {
      mount, device, fsType, free: Number.isFinite(free) ? free : 0, total: Number.isFinite(total) ? total : 0, system: mount === "/", network,
      removable: !network && (/^\/(media|run\/media)\//.test(mount) || removableDevice(device)), label: "",
    };
    const prev = seen.get(device);
    if (!prev || v.system || (!prev.system && v.mount.length < prev.mount.length)) seen.set(device, v);
  }
  return [...seen.values()];
}

/** Runs the system tools for this platform. `run(cmd, args)` returns stdout (injectable). */
export async function listVolumes({ platform = process.platform, run = defaultRun, env = process.env } = {}) {
  if (platform === "win32") {
    const script = "$bus=@{}; try { Get-Partition | Where-Object DriveLetter | ForEach-Object { $bus[[string]$_.DriveLetter] = [string](Get-Disk -Number $_.DiskNumber).BusType } } catch {}; "
      + "Get-CimInstance Win32_LogicalDisk | ForEach-Object { [pscustomobject]@{ id=$_.DeviceID; type=[int]$_.DriveType; free=[double]$_.FreeSpace; size=[double]$_.Size; fs=$_.FileSystem; label=$_.VolumeName; bus=$bus[$_.DeviceID.Substring(0,1)] } } | ConvertTo-Json -Compress";
    const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    return parseWindowsVolumes(out, { systemDrive: env.SystemDrive || env.SYSTEMDRIVE || "C:" });
  }
  if (platform === "darwin") {
    const [df, mount] = await Promise.all([run("df", ["-kP"]), run("mount", []).catch(() => "")]);
    const base = parseMacVolumes(df, mount);
    const info = {};
    for (const v of base) if (!v.system && !v.network) info[v.mount] = await run("diskutil", ["info", v.mount]).catch(() => "");
    return parseMacVolumes(df, mount, info);
  }
  const findmnt = await run("findmnt", ["-rb", "-o", "TARGET,SOURCE,FSTYPE,AVAIL,SIZE,OPTIONS"]);
  const lsblk = await run("lsblk", ["-P", "-o", "NAME,PKNAME,RM,HOTPLUG,TRAN"]).catch(() => "");
  return parseLinuxVolumes(findmnt, lsblk);
}
async function defaultRun(cmd, args) {
  const { stdout } = await execP(cmd, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  return stdout;
}

/** Why a volume can't hold the data, or null. */
export function volumeProblem(v, { platform = process.platform } = {}) {
  if (v.network) return "a network drive (WhatsApp's browser needs a disk inside this computer)";
  if (v.removable) return platform === "win32" ? "a removable or USB drive (it can be unplugged while the server runs)" : "a removable or external drive (it can be unplugged while the server runs)";
  if (CLOUD_VOLUME_LABELS.test(v.label || "")) return "a cloud-synced drive";
  const t = String(v.fsType ?? "").toLowerCase();
  if (platform === "win32" && (t === "fat32" || t === "fat")) return "formatted as FAT32 (no folder permissions, 4 GB file limit)";
  if (platform === "darwin" && ["msdos", "exfat", "ntfs"].includes(t)) return `formatted as ${t.toUpperCase()}, which can't keep WhatsApp's login safely`;
  if (platform === "linux" && ["vfat", "exfat", "ntfs", "ntfs3", "fuseblk", "msdos"].includes(t)) return `formatted as ${t}, which has no Linux file permissions`;
  if (!v.total) return "not ready";
  return null;
}

/** Which volume a path is on: the one with the longest matching mount (Windows: the drive letter). */
export function volumeFor(p, volumes, platform = process.platform) {
  if (platform === "win32") {
    const l = /^([A-Za-z]):/.exec(p)?.[1]?.toUpperCase();
    return volumes.find((v) => v.device === `${l}:`) ?? null;
  }
  let best = null;
  for (const v of volumes) if (isInside(p, v.mount, platform) && (!best || v.mount.length > best.mount.length)) best = v;
  return best;
}

// ---------- the choice ----------
/**
 * Everything the choice depends on, from the platform's own layout:
 *   defaultData / defaultModels  where things go when nothing is chosen (defaultModels null: the Ollama default, nothing to set)
 *   programRoot                  the program folder tree: nothing may be inside or around it
 *   defaultBase                  the folder the default layout is based in (shown as the default; typing it picks the default)
 *   baseFor(volume)              a sensible folder on another volume
 */
export function layoutFor(platform, { env = process.env, home = os.homedir(), stateDir, programRoot, programDir, defaultData, defaultModels, forbid = [] } = {}) {
  const m = modFor(platform);
  const root = programRoot || (platform === "win32" ? "C:\\NothingBotServer" : platform === "darwin" ? m.join(home, "Library", "Application Support", "NothingBotServer") : "/opt/nothing-bot-server");
  const dData = defaultData || (platform === "win32" ? m.join(root, "data") : platform === "darwin" ? m.join(root, "data") : "/var/lib/nothing-bot-server");
  const dModels = defaultModels === undefined ? (platform === "win32" ? m.join(root, "ollama") : platform === "linux" ? "/usr/share/ollama/.ollama/models" : null) : (defaultModels || null);
  const forbidden = [{ path: root, label: "the Nothing BOT Server program folder" }, ...(programDir ? [{ path: programDir, label: "the Nothing BOT Server program folder" }] : []), ...forbid.map((f) => ({ path: f, label: "Nothing BOT Server's own program files" }))];
  if (platform === "linux") for (const f of ["/usr/local/lib/nothing-bot-server", "/usr/local/sbin", "/etc/nothing-bot-server"]) forbidden.push({ path: f, label: "Nothing BOT Server's own program files" });
  const baseFor = (v) => (platform === "win32" ? m.join(v.mount, "Nothing BOT Server") : platform === "darwin" ? m.join(v.mount, "Nothing BOT Server") : m.join(v.mount, "nothing-bot-server"));
  return {
    platform, env, home, stateDir: stateDir || (platform === "linux" ? "/etc/nothing-bot-server" : root), root,
    defaultData: dData, defaultModels: dModels, defaultBase: platform === "linux" ? dData : root, forbidden, baseFor,
    isDefaultPath: (p) => [root, dData, platform === "linux" ? "/var/lib/nothing-bot-server" : null].filter(Boolean).some((d) => pathKey(d, platform) === pathKey(p, platform)),
  };
}

/** The offer for one volume: { volume, base, dataDir, modelsDir, isDefault, ok, problem }. */
export function candidateFor(v, layout) {
  const m = modFor(layout.platform);
  const problem = volumeProblem(v, { platform: layout.platform });
  const isDefault = Boolean(v.system);
  const base = isDefault ? layout.defaultBase : layout.baseFor(v);
  return {
    volume: v, base, isDefault, ok: !problem, problem,
    dataDir: isDefault ? layout.defaultData : m.join(base, DATA_SUB),
    modelsDir: isDefault ? layout.defaultModels : m.join(base, MODELS_SUB),
  };
}

/** Candidates, best first: the most free space wins (the system disk breaks a tie), blocked disks last. */
export function rankCandidates(volumes, layout) {
  return volumes.map((v) => candidateFor(v, layout)).sort((a, b) => (a.ok === b.ok ? (b.volume.free - a.volume.free) || (Number(b.isDefault) - Number(a.isDefault)) : a.ok ? -1 : 1));
}
export const suggest = (ranked) => ranked.find((c) => c.ok) ?? null;

/**
 * Judges a folder the owner typed (or NBS_DATA_DIR). Returns the same shape as a candidate, or { ok: false, error }.
 * `realpath(p)` resolves the nearest existing part of the path, so a shortcut into a cloud folder (Windows' redirected Documents,
 * a symlink) is judged by where it leads.
 */
export function validateChoice(input, layout, volumes, { realpath = realpathNearest } = {}) {
  const { platform } = layout;
  const m = modFor(platform);
  const c = cleanPath(input, { platform, home: layout.home });
  if (!c.ok) return c;
  const p = c.path;
  const fail = (error) => ({ ok: false, error });
  // The default layout, typed out.
  if (layout.isDefaultPath(p)) {
    const v = volumes.find((x) => x.system) ?? volumeFor(p, volumes, platform);
    return { ok: true, volume: v ?? null, base: layout.defaultBase, isDefault: true, dataDir: layout.defaultData, modelsDir: layout.defaultModels };
  }
  for (const f of layout.forbidden) {
    if (isInside(p, f.path, platform) || isInside(f.path, p, platform)) return fail(`That is inside (or around) ${f.label}. The program stays where it is; pick another folder for the data.`);
  }
  const looks = [p];
  try { const r = realpath(p); if (r && pathKey(r, platform) !== pathKey(p, platform)) looks.push(r); } catch { /* not resolvable: judge the text */ }
  for (const q of looks) {
    const cloud = cloudProvider(q, { platform, env: layout.env });
    if (cloud) return fail(cloudWhy(cloud));
    if (platform === "darwin" && /^(desktop|documents)$/i.test(segmentsOf(q, platform)[segmentsOf(layout.home, platform).length] ?? "") && isInside(q, layout.home, platform)
      && (layout.icloudDesktop ?? existsSync(m.join(layout.home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Documents")))) {
      return fail(cloudWhy("iCloud Drive (Desktop & Documents)"));
    }
    for (const f of layout.forbidden) if (isInside(q, f.path, platform) || isInside(f.path, q, platform)) return fail(`That leads into ${f.label}. Pick another folder for the data.`);
  }
  const v = volumeFor(looks[looks.length - 1], volumes, platform) ?? volumeFor(p, volumes, platform);
  if (!v) return fail(platform === "win32" ? `The drive ${p.slice(0, 2).toUpperCase()} isn't available on this computer.` : "Couldn't tell which disk that folder is on.");
  const problem = volumeProblem(v, { platform });
  if (problem) return fail(`That folder is on ${v.label ? `${v.label} (${v.mount})` : v.mount}, ${problem}. Pick a fixed disk inside this computer.`);
  const isDefault = false;
  return { ok: true, volume: v, base: p, isDefault, dataDir: m.join(p, DATA_SUB), modelsDir: m.join(p, MODELS_SUB) };
}
export function realpathNearest(p) {
  let cur = p;
  for (;;) {
    try { const r = realpathSync.native(cur); return cur === p ? r : path.join(r, path.relative(cur, p)); } catch { /* climb */ }
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/** { ok, free, required, enough, text } for a volume. */
export function spaceCheck(volume, required) {
  const free = volume?.free ?? null;
  const enough = free == null ? true : free >= required;
  return { free, required, enough, text: free == null ? `needs about ${fmtSize(required)}` : `${fmtSize(free)} free, needs about ${fmtSize(required)}` };
}

// ---------- the pointers ----------
const readFirstLine = (f) => { try { return readFileSync(f, "utf8").split(/\r?\n/)[0].trim() || null; } catch { return null; } };
/** What an earlier install or the console's Move data already chose: { dataDir, modelsDir } (either may be null). */
export function readExisting(stateDir, platform = process.platform) {
  const m = modFor(platform);
  const pick = (names) => { let v = null; for (const n of names) v = readFirstLine(m.join(stateDir, n)) ?? v; return v; };
  return { dataDir: pick(["data-dir.txt", "data-dir"]), modelsDir: pick(["models-dir.txt", "models-dir"]) };
}
/** An install is already here: the program, or data in the default folder. Re-runs and updates never ask. */
export function installExists({ programDir, defaultData, platform = process.platform, exists = existsSync, readdir = (d) => readdirSync(d) }) {
  const m = modFor(platform);
  if (programDir && exists(m.join(programDir, "apps", "worker", "package.json"))) return true;
  try { if (defaultData && exists(defaultData) && readdir(defaultData).length) return true; } catch { /* unreadable: not ours */ }
  return false;
}
export function hasModels(dir, platform = process.platform) {
  try { return Boolean(dir) && existsSync(modFor(platform).join(dir, "manifests")) && readdirSync(modFor(platform).join(dir, "blobs")).length > 0; } catch { return false; }
}
function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  try { renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch { /* */ } throw e; }
}
/** Makes the folders (proving they can be written), then writes the pointers: the same files move.mjs writes. */
export function applyChoice(choice, { stateDir, platform = process.platform, writeModels = true, fs = { mkdir: (d) => mkdirSync(d, { recursive: true }), write: writeAtomic, probe } } = {}) {
  const m = modFor(platform);
  fs.mkdir(choice.dataDir);
  fs.probe?.(choice.dataDir);
  if (writeModels && choice.modelsDir) fs.mkdir(choice.modelsDir);
  fs.write(m.join(stateDir, "data-dir"), choice.dataDir + "\n");
  if (writeModels && choice.modelsDir) fs.write(m.join(stateDir, "models-dir"), choice.modelsDir + "\n");
}
function probe(dir) {
  const f = path.join(dir, `.nbs-probe-${process.pid}`);
  writeFileSync(f, "ok");
  unlinkSync(f);
}

// ---------- the whole decision ----------
/**
 * The decision, with everything outside injected (tests drive it with fakes).
 *   existing        { dataDir, modelsDir } from the pointer files
 *   hasInstall      an install is already on this machine
 *   requested       a folder given up front (NBS_DATA_DIR / --data-dir)
 *   yes             accept the suggestion
 *   ask(prompt)     one line from the owner, or null when nobody can answer; confirm(prompt) a yes/no
 *   say(line)       output
 * Returns { action: "keep" | "default" | "chosen", dataDir, modelsDir, ... } or { action: "error", error }.
 */
export async function decide({ layout, volumes, existing, hasInstall, requested = null, yes = false, interactive = false, ask = async () => null, confirm = async () => false, say = () => {}, required, modelsKept = false }) {
  const { platform } = layout;
  if (existing?.dataDir) return { action: "keep", reason: "pointer", dataDir: existing.dataDir, modelsDir: existing.modelsDir ?? null };
  if (hasInstall && !requested) return { action: "keep", reason: "install", dataDir: null, modelsDir: null };
  const ranked = rankCandidates(volumes, layout);
  const best = suggest(ranked);
  const finish = (c, how) => (c.isDefault
    ? { action: "default", how, dataDir: layout.defaultData, modelsDir: layout.defaultModels }
    : { action: "chosen", how, base: c.base, dataDir: c.dataDir, modelsDir: c.modelsDir, volume: c.volume });

  if (requested) {
    const v = validateChoice(requested, layout, volumes);
    if (!v.ok) return { action: "error", error: v.error };
    const sp = spaceCheck(v.volume, required);
    if (!sp.enough && !yes) return { action: "error", error: `Not enough room there: ${sp.text}. Free up space, pick another disk, or add --yes to go ahead anyway.` };
    if (!sp.enough) say(`Warning: ${sp.text}. Going ahead because --yes was given.`);
    return { ...finish(v, "requested"), space: sp };
  }
  if (!best) return { action: "default", how: "no-suitable-disk", dataDir: layout.defaultData, modelsDir: layout.defaultModels, note: "No suitable disk found; using the default folder." };
  if (yes || !interactive) {
    if (!yes) return { action: "default", how: "not-asked", dataDir: layout.defaultData, modelsDir: layout.defaultModels };
    return { ...finish(best, "suggested"), space: spaceCheck(best.volume, required) };
  }

  const win = platform === "win32";
  const sysMount = (volumes.find((x) => x.system)?.mount ?? "").replace(/[\\/]$/, "");
  say("");
  say("Where should Nothing BOT keep its data and AI models?");
  say(`That is the WhatsApp logins, backups, logs and the AI models. The program itself stays where it is${sysMount ? ` (${sysMount})` : ""}.`);
  say("");
  const offered = ranked.filter((c) => c.ok);
  offered.forEach((c, i) => {
    const name = win ? c.volume.device : c.volume.mount;
    const where = c.isDefault ? `${c.dataDir}${c.volume.system ? "   (default location)" : ""}` : c.base;
    const short = c.volume.free < required ? "   NOT ENOUGH ROOM" : "";
    say(`  ${i + 1}) ${name.padEnd(win ? 3 : 10)} ${fmtSize(c.volume.free).padStart(8)} free   ${where}${c === best ? "   <- suggested: most free space" : ""}${short}`);
  });
  const skipped = ranked.filter((c) => !c.ok);
  if (skipped.length) say(`  Not offered: ${skipped.map((c) => `${win ? c.volume.device : c.volume.mount} (${(c.problem || "").replace(/ \(.*$/, "")})`).join(", ")}`);
  say("");
  say(`It needs about ${fmtSize(required)}${modelsKept ? " (the AI models are already on this computer)" : ""}. Enter takes 1; type a number, or another folder's full path.`);

  for (let tries = 0; tries < 8; tries++) {
    const raw = await ask(`Where to? [1] `);
    if (raw == null) return { action: "default", how: "no-answer", dataDir: layout.defaultData, modelsDir: layout.defaultModels };
    const t = raw.trim();
    let pick;
    if (!t) pick = best;
    else if (/^\d{1,2}$/.test(t)) {
      pick = offered[Number(t) - 1];
      if (!pick) { say(`  Pick a number from 1 to ${offered.length}, or type a folder path.`); continue; }
    } else {
      const v = validateChoice(t, layout, volumes);
      if (!v.ok) { say(`  ${v.error}`); continue; }
      pick = v;
    }
    const sp = spaceCheck(pick.volume, required);
    if (!sp.enough) {
      say(`  Only ${fmtSize(sp.free)} is free there, and it needs about ${fmtSize(required)}.`);
      if (!(await confirm("  Use it anyway? [y/N] "))) continue;
    }
    const out = finish(pick, "asked");
    say(`  Using ${out.dataDir} for the data${out.modelsDir ? ` and ${out.modelsDir} for the AI models` : ""} (${sp.text}).`);
    return { ...out, space: sp };
  }
  return { action: "default", how: "gave-up", dataDir: layout.defaultData, modelsDir: layout.defaultModels };
}

// ---------- the command line ----------
function parseArgs(argv) {
  const o = { forbid: [] };
  const flags = new Set(["no-local", "no-models", "yes", "no-ask"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { (o._ ??= []).push(a); continue; }
    const k = a.slice(2);
    if (flags.has(k)) o[k] = true;
    else if (k === "forbid") o.forbid.push(argv[++i]);
    else o[k] = argv[++i];
  }
  return o;
}
function openTty() {
  if (process.platform === "win32") return process.stdin.isTTY ? process.stdin : null;
  try { const fd = openSync("/dev/tty", "r"); closeSync(fd); return createReadStream("/dev/tty"); } catch { return null; }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const a = parseArgs(argv);
  const cmd = a._?.[0] ?? "choose";
  const platform = a.platform || process.platform;
  const layout = layoutFor(platform, { env, stateDir: a["state-dir"], programRoot: a["program-root"], programDir: a["program-dir"], defaultData: a["default-data"], defaultModels: a["default-models"], forbid: a.forbid });
  const volumes = a["volumes-json"] ? JSON.parse(readFileSync(a["volumes-json"], "utf8")) : await listVolumes({ platform, env });
  const existing = readExisting(layout.stateDir, platform);
  const modelsPresent = hasModels(existing.modelsDir || layout.defaultModels, platform);
  const required = requiredBytes({ model: a.model || env.GEMMA_MODEL || DEFAULT_MODEL, noLocal: Boolean(a["no-local"]), modelsPresent: modelsPresent || Boolean(a["no-models"]) });

  if (cmd === "list") {
    const ranked = rankCandidates(volumes, layout);
    console.log(JSON.stringify({ required, suggested: suggest(ranked)?.base ?? null, candidates: ranked.map((c) => ({ mount: c.volume.mount, free: c.volume.free, base: c.base, ok: c.ok, problem: c.problem })) }, null, 2));
    return 0;
  }
  const noModels = Boolean(a["no-models"] || a["no-local"]);   // a Gemini-only server has no models to place
  const yes = Boolean(a.yes) || /^(1|true|yes)$/i.test(env.NBS_YES || "");
  const requested = a["data-dir"] || env.NBS_DATA_DIR || null;
  const tty = a["no-ask"] ? null : openTty();
  const rl = tty ? createInterface({ input: tty, output: process.stdout }) : null;
  const ask = (q) => new Promise((resolve) => { if (!rl) return resolve(null); let done = false; rl.once("close", () => { if (!done) resolve(null); }); rl.question(q, (v) => { done = true; resolve(v); }); });
  const confirm = async (q) => /^y/i.test((await ask(q)) ?? "");
  let res;
  try {
    res = await decide({
      layout, volumes, existing, hasInstall: installExists({ programDir: a["program-dir"] || layout.root, defaultData: layout.defaultData, platform }),
      requested, yes, interactive: Boolean(tty), ask, confirm, say: (l) => console.log(l), required, modelsKept: modelsPresent,
    });
  } finally { rl?.close(); tty?.destroy?.(); }

  if (res.action === "error") { console.error(`\n  ${res.error}`); writeOut(a.out, { action: "error", error: res.error }); return 2; }
  if (res.action === "chosen") {
    // An existing models pointer (models already there, or Ollama set up before) stays; so does a Gemini-only server's lack of one.
    const writeModels = !noModels && !existing.modelsDir;
    try { applyChoice(res, { stateDir: layout.stateDir, platform, writeModels }); }
    catch (e) { console.error(`\n  Couldn't set up ${res.dataDir}: ${e.message}`); writeOut(a.out, { action: "error", error: e.message }); return 2; }
    if (!writeModels && existing.modelsDir) res.modelsDir = existing.modelsDir;
    if (noModels) res.modelsDir = null;
  }
  if (res.action === "keep" && res.reason === "pointer") console.log(`  Keeping the data in ${res.dataDir}${res.modelsDir ? ` and the AI models in ${res.modelsDir}` : ""} (chosen earlier).`);
  if (res.action === "default" && res.note) console.log(`  ${res.note}`);
  writeOut(a.out, { action: res.action, how: res.how ?? res.reason ?? null, dataDir: res.dataDir ?? null, modelsDir: res.modelsDir ?? null, base: res.base ?? null, nonDefault: res.action === "chosen" });
  return 0;
}
function writeOut(file, obj) { if (file) writeFileSync(file, JSON.stringify(obj) + "\n"); }

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((c) => process.exit(c), (e) => { console.error(e?.stack || e); process.exit(1); });
}
