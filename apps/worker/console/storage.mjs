// Where Nothing BOT Server keeps its data, and the safe building blocks for moving it to another drive: path validation,
// size scans, a copy that never follows symlinks, a verifier, and a delete that never leaves the folder it was given.
// Node built-ins only. This file is also installed root-owned on Ubuntu (the root helper imports it), so keep it self-contained.
import { lstatSync, readdirSync, statfsSync, realpathSync, mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync, rmdirSync, copyFileSync, symlinkSync, readlinkSync, lchownSync, utimesSync, chmodSync, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

export const GIB = 1024 ** 3;
/** The console warns, and refuses updates, under this much free space on the data drive. */
export const LOW_DISK_BYTES = 2 * GIB;
/** A move needs the data's size plus this much room to spare. */
export const HEADROOM_BYTES = GIB;
/** Browser lock files: never copied (the browser makes new ones), never compared. */
export const SKIP_NAMES = new Set(["SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile"]);
/**
 * Chromium cache folders inside the WhatsApp browser profiles (data/wwebjs/<profile>/...). Chromium rebuilds them on the next
 * start and writes to them constantly, so a move neither copies nor compares them. Everything that holds the WhatsApp login
 * (Local Storage, IndexedDB, Cookies, Preferences, the LocalAuth files) is outside this list and stays strictly verified.
 */
export const CACHE_DIRS = new Set(["Cache", "Code Cache", "GPUCache", "GrShaderCache", "ShaderCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "Crashpad", "component_crx_cache", "extensions_crx_cache", "BrowserMetrics", "Safe Browsing", "optimization_guide_model_store", "Media Cache"]);
/** Service Worker sub-folders that are only caches (the registrations next to them stay). */
const SW_CACHE_DIRS = new Set(["CacheStorage", "ScriptCache"]);
/** True for a cache-only path inside a browser profile; `rel` is slash-separated, from the data folder. */
export function isCacheOnly(rel) {
  const parts = rel.split("/");
  if (parts[0] !== "wwebjs" || parts.length < 3) return false; // wwebjs/<profile>/<something>
  for (let i = 2; i < parts.length; i++) {
    if (CACHE_DIRS.has(parts[i]) || (i > 0 && parts[i - 1] === "Service Worker" && SW_CACHE_DIRS.has(parts[i]))) return true;
  }
  return false;
}
/** Files in the top of the data folder that keep changing while a move runs. They are copied if possible, never compared. */
export const VOLATILE = new Set(["update.json", "update.json.tmp", "task.json", "console.log", "live-stats.json", "live-stats.json.tmp", "move.json", "worker.log"]);
/** Marks a folder this feature created, so a failed move may remove it and nothing else. */
export const MARKER = ".nbs-data-copy";
const CRITICAL_FILES = ["service-account.json", "console-token", "console.json", "wwebjs/server.json"];
const MAX_PATH_CHARS = 200;

export const modFor = (platform) => (platform === "win32" ? path.win32 : path.posix);
const caseInsensitive = (platform) => platform === "win32" || platform === "darwin";
const tick = () => new Promise((r) => setImmediate(r));

/** A comparable form of a path: normalised, no trailing separator, lower-cased where the file system ignores case. */
export function pathKey(p, platform = process.platform) {
  const m = modFor(platform);
  let s = m.normalize(String(p));
  if (s.length > m.parse(s).root.length) s = s.replace(/[\\/]+$/, "");
  return caseInsensitive(platform) ? s.toLowerCase() : s;
}
/** True when `child` is `parent` or lives anywhere below it. */
export function isInside(child, parent, platform = process.platform) {
  const c = pathKey(child, platform), p = pathKey(parent, platform);
  if (c === p) return true;
  const sep = modFor(platform).sep;
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}
/** Windows stops at 260 characters unless the path carries the extended prefix. Browser profiles nest deep. */
export function toFsPath(p, platform = process.platform) {
  if (platform !== "win32" || p.length < 240 || p.startsWith("\\\\?\\")) return p;
  return "\\\\?\\" + path.win32.resolve(p);
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const WIN_SYSTEM_DIRS = new Set(["windows", "program files", "program files (x86)", "programdata", "$recycle.bin", "system volume information", "recovery"]);
const POSIX_SYSTEM_ROOTS = new Set(["bin", "boot", "dev", "etc", "lib", "lib32", "lib64", "proc", "root", "run", "sbin", "sys", "usr"]);
const MAC_SYSTEM_ROOTS = new Set(["system", "library", "applications", "private", "cores", "bin", "sbin", "usr", "dev", "etc", "var"]);

/** True when the first folder under the drive root is one of the operating system's own (the same sets validatePath refuses). */
export function isSystemPath(p, platform = process.platform) {
  const m = modFor(platform);
  const win = platform === "win32";
  const root = m.parse(p).root;
  const segs = p.slice(root.length).split(win ? /\\+/ : /\/+/).filter(Boolean);
  const first = segs[0]?.toLowerCase();
  if (!first) return false;
  if (win) return WIN_SYSTEM_DIRS.has(first);
  if (platform === "darwin") return MAC_SYSTEM_ROOTS.has(first) && !(first === "var" && segs[1] === "lib");
  return POSIX_SYSTEM_ROOTS.has(first);
}

/**
 * Checks the text of a folder path, without touching the disk. Returns { ok: true, path } with the cleaned path, or
 * { ok: false, error } with a sentence for the owner. `forbidden` is [{ path, label }]: folders the new data may not sit in.
 */
export function validatePath(input, { platform = process.platform, current = null, forbidden = [] } = {}) {
  const fail = (error) => ({ ok: false, error });
  if (typeof input !== "string") return fail("Enter a folder path.");
  let p = input.trim();
  if (/^(["'])(.*)\1$/.test(p)) p = p.slice(1, -1).trim();
  if (!p) return fail("Enter a folder path.");
  if (/[\u0000-\u001f\u007f]/.test(p)) return fail("That path has characters a folder name can't have.");
  const win = platform === "win32";
  const m = modFor(platform);
  if (win) {
    if (/^[\\/]{2}/.test(p)) return fail("Use a folder on a drive inside this computer (like D:\\NothingBotServer\\data), not a network path. WhatsApp's browser needs a local disk.");
    if (!/^[A-Za-z]:[\\/]/.test(p)) return fail("Use the full path, starting with the drive letter, for example D:\\NothingBotServer\\data.");
    p = p.replace(/\//g, "\\");
  } else if (!p.startsWith("/")) {
    return fail("Use the full path, starting with /, for example /mnt/disk/NothingBotServer/data.");
  }
  const root = m.parse(p).root;
  const segs = p.slice(root.length).split(win ? /\\+/ : /\/+/).filter(Boolean);
  if (segs.some((s) => s === "..")) return fail("Leave out '..' from the path.");
  const real = segs.filter((s) => s !== ".");
  if (!real.length) return fail("Pick a folder on the drive, not the whole drive.");
  // Characters that break the service scripts, plist/unit files or the file system.
  const bad = win ? /[<>:"|?*'`$%&;]/ : /["'`$%&;<>\\]/;
  for (const s of real) {
    if (bad.test(s)) return fail(`Folder names can't contain ${win ? "< > : \" | ? * ' ` $ % & ;" : "\" ' ` $ % & ; < > \\"}. Rename "${s}".`);
    if (win && (/[. ]$/.test(s) || WIN_RESERVED.test(s))) return fail(`"${s}" isn't a name Windows allows for a folder.`);
  }
  let out = m.normalize(p);
  if (out.length > root.length) out = out.replace(/[\\/]+$/, "");
  if (out.length > MAX_PATH_CHARS) return fail(`That path is too long (${out.length} characters; keep it under ${MAX_PATH_CHARS}). WhatsApp's browser profile nests deeply.`);
  const first = real[0].toLowerCase();
  if (win && WIN_SYSTEM_DIRS.has(first)) return fail("Don't use a Windows system folder. Make a folder like D:\\NothingBotServer\\data.");
  if (!win && platform === "darwin" && MAC_SYSTEM_ROOTS.has(first) && !(first === "var" && real[1] === "lib")) return fail("Don't use a system folder. Use a folder in your home or on an external drive (/Volumes/…).");
  if (!win && platform !== "darwin" && POSIX_SYSTEM_ROOTS.has(first)) return fail("Don't use a system folder. Use a folder on the data disk, like /mnt/disk/NothingBotServer/data.");
  if (current) {
    if (pathKey(out, platform) === pathKey(current, platform)) return fail("That is the folder the data is already in.");
    if (isInside(out, current, platform)) return fail("The new folder can't be inside the current data folder.");
    if (isInside(current, out, platform)) return fail("The new folder can't contain the current data folder.");
  }
  for (const f of forbidden) {
    if (!f?.path) continue;
    if (isInside(out, f.path, platform) || isInside(f.path, out, platform)) return fail(`The new folder can't be inside (or around) ${f.label || "the Nothing BOT Server program folder"}.`);
  }
  return { ok: true, path: out };
}

// ---------- the disk ----------
export function freeBytes(p) {
  const st = statfsSync(p);
  return { free: Number(st.bavail) * Number(st.bsize), total: Number(st.blocks) * Number(st.bsize) };
}
const nearestExisting = (p, platform) => {
  const m = modFor(platform);
  let cur = p;
  for (;;) {
    try { return { dir: cur, st: lstatSync(toFsPath(cur, platform)) }; } catch { /* keep climbing */ }
    const up = m.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
};
/** The file system a path lives on ("NTFS", "ext4", "apfs"…), or null. `run(cmd, args)` returns stdout. */
export async function fsTypeOf(p, platform, run) {
  try {
    if (platform === "win32") {
      const letter = /^([A-Za-z]):/.exec(p)?.[1];
      return letter ? ((await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Volume -DriveLetter ${letter}).FileSystem`]))?.trim() || null) : null;
    }
    if (platform === "darwin") {
      const mount = (await run("df", ["-P", p]))?.trim().split("\n").pop()?.split(/\s+/).slice(5).join(" ");
      const info = mount ? await run("diskutil", ["info", mount]) : "";
      return /Type \(Bundle\):\s*(\S+)/.exec(info ?? "")?.[1] ?? null;
    }
    return (await run("findmnt", ["-T", p, "-no", "FSTYPE"]))?.trim() || null;
  } catch {
    return null;
  }
}
/** What to do about a file system: refuse the ones WhatsApp's browser profile can't live on, warn about doubtful ones. */
export function judgeFs(type, platform) {
  const t = String(type ?? "").toLowerCase();
  if (!t) return {};
  if (platform === "win32") {
    if (t === "fat32" || t === "fat") return { error: "That drive is formatted as FAT32, which can't hold WhatsApp's login (no folder permissions, 4 GB file limit). Use an NTFS drive." };
    if (t === "exfat") return { warning: "That drive is exFAT. It usually works, but NTFS is safer for WhatsApp's login." };
  } else if (platform === "darwin") {
    if (["msdos", "exfat", "ntfs"].includes(t)) return { error: `That drive is formatted as ${t.toUpperCase()}, which can't keep WhatsApp's login safely. Use an APFS or Mac OS Extended drive.` };
  } else if (["vfat", "exfat", "ntfs", "ntfs3", "fuseblk", "msdos"].includes(t)) {
    return { error: `That disk is formatted as ${t}, which has no Linux file permissions. Use an ext4 disk.` };
  }
  return {};
}

/**
 * Checks a folder on the real disk: valid text, not a symlink or junction, empty or new, its drive exists and is writable,
 * and (with `needBytes`) has room. Never leaves anything behind. `strictLinks` (the root helper) refuses any symlink in the path.
 */
export async function inspectTarget(input, { platform = process.platform, current, forbidden = [], needBytes = 0, run = null, strictLinks = false, probe = true } = {}) {
  const v = validatePath(input, { platform, current, forbidden });
  if (!v.ok) return v;
  const target = v.path;
  const near = nearestExisting(target, platform);
  if (!near) return { ok: false, error: `That drive isn't available on this computer.` };
  const vol = platform === "darwin" ? /^\/Volumes\/([^/]+)/.exec(target)?.[1] : null;
  if (vol && !existsSync(`/Volumes/${vol}`)) return { ok: false, error: `The drive "${vol}" isn't connected.` };
  if (near.dir === target) {
    if (near.st.isSymbolicLink()) return { ok: false, error: "That folder is a shortcut (symlink). Pick a real folder." };
    if (!near.st.isDirectory()) return { ok: false, error: "That path is a file, not a folder." };
    let entries = 0;
    try { entries = readdirSync(toFsPath(target, platform)).length; } catch (e) { return { ok: false, error: `Can't look inside that folder (${e.code || e.message}).` }; }
    if (entries) return { ok: false, error: "That folder isn't empty. Pick a new or empty folder, so nothing gets mixed up." };
  } else if (!near.st.isDirectory() && !near.st.isSymbolicLink()) {
    return { ok: false, error: "Part of that path is a file, not a folder." };
  }
  // Symlinks and junctions on the way: judge where the path really leads.
  let ancestor;
  try { ancestor = realpathSync.native(near.dir); } catch (e) { return { ok: false, error: `Can't open ${near.dir}: ${e.message}` }; }
  const m = modFor(platform);
  const resolved = near.dir === target ? ancestor : m.join(ancestor, m.relative(near.dir, target));
  if (pathKey(ancestor, platform) !== pathKey(near.dir, platform)) {
    if (strictLinks) return { ok: false, error: "That path goes through a shortcut (symlink). Use the real path." };
    const again = validatePath(resolved, { platform, current, forbidden });
    if (!again.ok) return { ok: false, error: `That path leads through a shortcut into somewhere not allowed. ${again.error}` };
  }
  // Writable: make and remove a probe file. A folder that doesn't exist yet needs its nearest parent to be writable.
  // (On Ubuntu the console runs as an unprivileged user and the root helper makes the folder, so only the helper probes.)
  if (probe) {
    const file = m.join(ancestor, `.nbs-probe-${randomBytes(4).toString("hex")}`);
    try {
      writeFileSync(toFsPath(file, platform), "ok");
      unlinkSync(toFsPath(file, platform));
    } catch (e) {
      return { ok: false, error: `Nothing BOT Server can't write to ${near.dir} (${e.code || e.message}). Pick a folder it can write to.` };
    }
  }
  let free = null, total = null;
  try { ({ free, total } = freeBytes(ancestor)); } catch { /* unknown */ }
  const warnings = [];
  if (run) {
    const type = await fsTypeOf(ancestor, platform, run);
    const j = judgeFs(type, platform);
    if (j.error) return { ok: false, error: j.error, fsType: type };
    if (j.warning) warnings.push(j.warning);
    var fsType = type;
  }
  if (needBytes && free != null && free < needBytes) {
    return { ok: false, error: `Not enough room there: it needs ${fmtGb(needBytes)} (the data plus 1 GB spare) and the drive has ${fmtGb(free)} free.`, free, total, needBytes, fsType };
  }
  return { ok: true, path: target, free, total, needBytes, fsType: fsType ?? null, warnings, existed: near.dir === target };
}
/**
 * Makes the folder (and any missing ones above it). `check` has already vetted the path. A sentence for the owner instead of a raw error code when it can't:
 * no permission, a file with that name in the way, a name the drive refuses, a read-only or missing drive.
 */
export function makeFolder(input, { platform = process.platform, mkdir = mkdirSync } = {}) {
  if (typeof input !== "string" || !modFor(platform).isAbsolute(input)) throw new Error("Couldn't create the folder: that isn't a full path.");
  try {
    mkdir(toFsPath(input, platform), { recursive: true });
  } catch (e) {
    const code = e.code;
    const why = code === "EEXIST" || code === "ENOTDIR" ? `A file is already called that, or is in the way, so the folder can't be made there.`
      : code === "EACCES" || code === "EPERM" ? `Nothing BOT Server isn't allowed to make a folder there. Pick a place it can write to.`
      : code === "EROFS" ? `That disk is read-only.`
      : code === "ENOENT" ? `That drive isn't available any more.`
      : code === "ENOSPC" ? `That disk is full.`
      : code === "EINVAL" || code === "ENAMETOOLONG" ? `That isn't a folder name the disk accepts.`
      : `The disk said ${code || e.message}.`;
    throw Object.assign(new Error(`Couldn't create ${input}. ${why}`), { code });
  }
  return input;
}
export const fmtGb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

// ---------- walking ----------
function listDir(dir, platform) {
  try { return readdirSync(toFsPath(dir, platform), { withFileTypes: true }); } catch { return []; }
}
/** Size and file count of a tree, never following symlinks. `skip` names are left out at any depth, and so are browser caches (they aren't copied). */
export async function measure(dir, { platform = process.platform, skip = SKIP_NAMES, dropCaches = true } = {}) {
  const m = modFor(platform);
  let bytes = 0, files = 0, n = 0;
  const stack = [[dir, ""]];
  while (stack.length) {
    const [d, rel] = stack.pop();
    for (const e of listDir(d, platform)) {
      if (skip.has(e.name)) continue;
      const p = m.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (dropCaches && isCacheOnly(r)) continue;
      if (e.isSymbolicLink()) { files++; continue; }
      if (e.isDirectory()) { stack.push([p, r]); continue; }
      if (!e.isFile()) continue;
      try { bytes += lstatSync(toFsPath(p, platform)).size; files++; } catch { /* vanished */ }
      if (++n % 400 === 0) await tick();
    }
  }
  return { bytes, files };
}
/** What is in the data folder, in the words the Storage section uses. */
export async function summariseData(dir, { platform = process.platform } = {}) {
  const m = modFor(platform);
  const buckets = { sessions: { label: "WhatsApp logins", bytes: 0, files: 0 }, backups: { label: "Login backups", bytes: 0, files: 0 }, other: { label: "Other WhatsApp data", bytes: 0, files: 0 }, logs: { label: "Logs", bytes: 0, files: 0 }, stats: { label: "Live stats and settings", bytes: 0, files: 0 }, extra: { label: "Other files", bytes: 0, files: 0 } };
  const add = (k, r) => { buckets[k].bytes += r.bytes; buckets[k].files += r.files; };
  for (const e of listDir(dir, platform)) {
    const p = m.join(dir, e.name);
    if (e.name === "wwebjs" && e.isDirectory()) {
      for (const w of listDir(p, platform)) {
        const wp = m.join(p, w.name);
        const k = /^session-/.test(w.name) ? "sessions" : /^backup-/.test(w.name) ? "backups" : "other";
        add(k, w.isDirectory() ? await measure(wp, { platform, skip: new Set() }) : { bytes: lstatSync(toFsPath(wp, platform)).size, files: 1 });
      }
    } else if (e.isDirectory()) add("extra", await measure(p, { platform, skip: new Set() }));
    else if (/\.log$/i.test(e.name)) { try { add("logs", { bytes: lstatSync(toFsPath(p, platform)).size, files: 1 }); } catch { /* gone */ } }
    else { try { add("stats", { bytes: lstatSync(toFsPath(p, platform)).size, files: 1 }); } catch { /* gone */ } }
  }
  const entries = Object.entries(buckets).map(([key, v]) => ({ key, ...v })).filter((x) => x.bytes > 0 || x.key === "sessions" || x.key === "backups");
  return { entries, bytes: entries.reduce((a, x) => a + x.bytes, 0), files: entries.reduce((a, x) => a + x.files, 0) };
}

// ---------- copy ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Copies src into dst, file by file, without ever following a symlink (links are recreated as links). Browser lock files
 * and browser caches (isCacheOnly) are skipped. Files another program holds are retried; a volatile file that stays locked is skipped, anything else fails
 * with its path. `chown` ({ uid, gid }) is applied to everything made, for the root helper.
 */
export async function copyTree(src, dst, { platform = process.platform, skip = SKIP_NAMES, onProgress = () => {}, chown = null, retries = 4, volatile = VOLATILE, total = null, dropCaches = true } = {}) {
  const m = modFor(platform);
  const f = (p) => toFsPath(p, platform);
  let bytes = 0, files = 0, n = 0, last = 0;
  const own = (p) => { if (chown && platform !== "win32") { try { lchownSync(f(p), chown.uid, chown.gid); } catch { /* best effort */ } } };
  const report = (force) => { const t = Date.now(); if (force || t - last > 400) { last = t; onProgress({ bytes, files, total }); } };
  async function copyFileRetry(a, b, topVolatile) {
    for (let i = 0; ; i++) {
      try { copyFileSync(f(a), f(b)); return true; } catch (e) {
        const busy = ["EBUSY", "EPERM", "EACCES", "EMFILE", "ENFILE", "ETXTBSY"].includes(e.code);
        if (busy && i < retries) { await sleep(400 * (i + 1)); continue; }
        if (topVolatile) return false;
        throw new Error(`Couldn't copy ${a}: ${e.code || ""} ${e.message}`.replace(/\s+/g, " "));
      }
    }
  }
  async function walk(s, d, depth, rel) {
    mkdirSync(f(d), { recursive: true });
    own(d);
    for (const e of listDir(s, platform)) {
      if (skip.has(e.name)) continue;
      const sp = m.join(s, e.name), dp = m.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (dropCaches && isCacheOnly(r)) continue;
      if (e.isSymbolicLink()) {
        try { symlinkSync(readlinkSync(f(sp)), f(dp)); own(dp); files++; } catch (err) { throw new Error(`Couldn't recreate the link ${sp}: ${err.message}`); }
      } else if (e.isDirectory()) {
        await walk(sp, dp, depth + 1, r);
        try { const st = lstatSync(f(sp)); chmodSync(f(dp), st.mode & 0o7777); } catch { /* keep default */ }
      } else if (e.isFile()) {
        const st = lstatSync(f(sp));
        const ok = await copyFileRetry(sp, dp, depth === 0 && volatile.has(e.name));
        if (!ok) continue;
        try { utimesSync(f(dp), st.atime, st.mtime); } catch { /* cosmetic */ }
        own(dp);
        bytes += st.size; files++;
        if (++n % 50 === 0) await tick();
        report(false);
      }
    }
  }
  await walk(src, dst, 0, "");
  report(true);
  return { bytes, files };
}

// ---------- is anything still writing? ----------
/** A cheap picture of what matters in a tree (file count, bytes, newest change): equal pictures a moment apart mean nothing is writing. */
export async function fingerprint(dir, { platform = process.platform, skip = SKIP_NAMES, volatile = new Set([...VOLATILE, "console.json", "console-token", "service-account.json"]) } = {}) {
  const m = modFor(platform);
  let files = 0, bytes = 0, newest = 0, n = 0;
  const stack = [[dir, "", 0]];
  while (stack.length) {
    const [d, rel, depth] = stack.pop();
    for (const e of listDir(d, platform)) {
      if (skip.has(e.name) || (depth === 0 && volatile.has(e.name))) continue;
      const p = m.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (isCacheOnly(r)) continue;
      if (e.isDirectory()) { stack.push([p, r, depth + 1]); continue; }
      if (!e.isFile()) continue;
      try { const st = lstatSync(toFsPath(p, platform)); files++; bytes += st.size; newest = Math.max(newest, st.mtimeMs); } catch { /* vanished */ }
      if (++n % 400 === 0) await tick();
    }
  }
  return { files, bytes, newest };
}
export const sameFingerprint = (a, b) => a.files === b.files && a.bytes === b.bytes && a.newest === b.newest;
/** The plain-language reason a move stops when something is still writing to the data folder. */
export const STILL_CLOSING = "WhatsApp is still closing; try again in a minute.";
/**
 * Waits for the data folder to go quiet: two pictures `gapMs` apart that match. A browser that is still shutting down keeps
 * changing its files, so this catches one the stop step missed. { ok, picture }.
 */
export async function waitQuiet(dir, { platform = process.platform, gapMs = 2500, timeoutMs = 30_000, wait = sleep, now = Date.now } = {}) {
  const end = now() + timeoutMs;
  let prev = await fingerprint(dir, { platform });
  for (;;) {
    await wait(gapMs);
    const cur = await fingerprint(dir, { platform });
    if (sameFingerprint(prev, cur)) return { ok: true, picture: cur };
    if (now() >= end) return { ok: false, picture: cur };
    prev = cur;
  }
}

// ---------- verify ----------
async function inventory(root, { platform, skip, ignoreTop, dropCaches = true }) {
  const m = modFor(platform);
  const out = new Map();
  let n = 0;
  async function walk(dir, rel, depth) {
    for (const e of listDir(dir, platform)) {
      if (skip.has(e.name) || (depth === 0 && ignoreTop.has(e.name))) continue;
      const p = m.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (dropCaches && isCacheOnly(r)) continue;
      if (e.isSymbolicLink()) out.set(r, { t: "l" });
      else if (e.isDirectory()) { out.set(r, { t: "d" }); await walk(p, r, depth + 1); }
      else if (e.isFile()) { try { out.set(r, { t: "f", size: lstatSync(toFsPath(p, platform)).size }); } catch { /* gone */ } if (++n % 400 === 0) await tick(); }
    }
  }
  await walk(root, "", 0);
  return out;
}
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
/**
 * Compares a copy with its source: every file and folder is there with the same size, every WhatsApp profile and backup
 * folder exists, and the small files that matter (key, token, settings, server id) are byte-identical.
 * `ignore` names are extra top-level entries to leave out (a separate models folder that lives inside the copy).
 */
export async function verifyTree(src, dst, { platform = process.platform, skip = SKIP_NAMES, volatile = VOLATILE, ignore = [] } = {}) {
  const m = modFor(platform);
  const problems = [];
  const a = await inventory(src, { platform, skip, ignoreTop: volatile });
  const b = await inventory(dst, { platform, skip, ignoreTop: new Set([...volatile, ...ignore, MARKER]) });
  let files = 0, bytes = 0;
  for (const [rel, x] of a) {
    if (ignore.includes(rel.split("/")[0]) || rel === MARKER) continue;
    const y = b.get(rel);
    if (!y) { problems.push(`missing: ${rel}`); continue; }
    if (x.t !== y.t) { problems.push(`different kind: ${rel}`); continue; }
    if (x.t === "f") { files++; bytes += x.size; if (x.size !== y.size) problems.push(`size differs: ${rel} (${x.size} vs ${y.size})`); }
    if (problems.length > 20) break;
  }
  // The WhatsApp profile and backup folders must exist in the copy (and have something in them if the original does).
  for (const e of listDir(m.join(src, "wwebjs"), platform)) {
    if (!e.isDirectory() || !/^(session|backup)-/.test(e.name)) continue;
    const there = m.join(dst, "wwebjs", e.name);
    if (!existsSync(toFsPath(there, platform))) problems.push(`WhatsApp folder missing in the copy: wwebjs/${e.name}`);
    else if (listDir(m.join(src, "wwebjs", e.name), platform).length && !listDir(there, platform).length) problems.push(`WhatsApp folder is empty in the copy: wwebjs/${e.name}`);
  }
  for (const rel of CRITICAL_FILES) {
    const sp = m.join(src, ...rel.split("/")), dp = m.join(dst, ...rel.split("/"));
    if (!existsSync(toFsPath(sp, platform))) continue;
    try { if (sha(toFsPath(sp, platform)) !== sha(toFsPath(dp, platform))) problems.push(`contents differ: ${rel}`); } catch { problems.push(`can't read in the copy: ${rel}`); }
  }
  return { ok: problems.length === 0, files, bytes, problems: problems.slice(0, 20) };
}

// ---------- delete ----------
/**
 * Deletes a folder and everything in it without following symlinks or junctions (a link is removed, never entered).
 * Refuses a link as the starting point and refuses to run on a drive root.
 */
export async function removeTree(dir, { platform = process.platform, onProgress = () => {} } = {}) {
  const m = modFor(platform);
  const f = (p) => toFsPath(p, platform);
  const st = lstatSync(f(dir));
  if (st.isSymbolicLink()) throw new Error("Refusing to delete a symlink.");
  if (!st.isDirectory()) throw new Error("Refusing to delete something that isn't a folder.");
  if (m.parse(dir).root === dir || m.dirname(dir) === dir) throw new Error("Refusing to delete a drive root.");
  let n = 0;
  const rm = (fn, p) => { for (let i = 0; ; i++) { try { return fn(f(p)); } catch (e) { if (e.code === "ENOENT") return; if (i < 3 && ["EBUSY", "EPERM", "EACCES"].includes(e.code)) { try { chmodSync(f(p), 0o700); } catch { /* ignore */ } continue; } throw e; } } };
  async function walk(d) {
    for (const e of listDir(d, platform)) {
      const p = m.join(d, e.name);
      if (e.isSymbolicLink()) {
        // A junction can need rmdir; either call only removes the link itself.
        try { rm(unlinkSync, p); } catch { rm(rmdirSync, p); }
      } else if (e.isDirectory()) { await walk(p); rm(rmdirSync, p); }
      else rm(unlinkSync, p);
      if (++n % 100 === 0) { onProgress(n); await tick(); }
    }
  }
  await walk(dir);
  return { removed: n };
}

// ---------- text rewriting ----------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Replaces `from` with `to` wherever it is a whole path prefix, in scripts and config. Returns the new text. */
export function replacePaths(text, from, to, platform = process.platform) {
  if (!from || pathKey(from, platform) === pathKey(to, platform)) return text;
  const re = new RegExp(`${esc(from.replace(/[\\/]+$/, ""))}(?=[\\\\/'"\\s]|$)`, caseInsensitive(platform) ? "gi" : "g");
  return text.replace(re, () => to.replace(/[\\/]+$/, ""));
}
/**
 * Rewrites the paths in the worker's .env (data, key, token, stats, models) from one folder to another. Line endings stay.
 * `pairs` is [[from, to], …].
 */
export function rewriteEnvPaths(text, pairs, platform = process.platform) {
  return text.split(/(\r?\n)/).map((line) => {
    if (!/^[A-Z0-9_]+=/.test(line)) return line;
    let out = line;
    for (const [from, to] of pairs) if (from && to) out = replacePaths(out, from, to, platform);
    return out;
  }).join("");
}

// ---------- state files (pointers and the move record) ----------
export function readPointer(dir, name) {
  try { const v = readFileSync(path.join(dir, name), "utf8").trim(); return v || null; } catch { return null; }
}
export function writeAtomic(file, text, mode) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, mode ? { mode } : undefined);
  renameSync(tmp, file);
}
export const writePointer = (dir, name, value) => writeAtomic(path.join(dir, name), value + "\n");
export function readJson(file) { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } }
