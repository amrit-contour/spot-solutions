// The folder picker's side of the console: which drives this computer has, the sub-folders of a folder, and making a
// new folder. Folders only: it never lists or reads files. Every path must sit inside one of the drives (roots), is
// resolved without following shortcuts (symlinks / junctions), and system folders are never shown or entered.
// Node built-ins only. The parsers are pure (they take the text a command printed) so they can be tested anywhere.
import { lstatSync, readdirSync, realpathSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import { freeBytes, isInside, isSystemPath, judgeFs, modFor, pathKey, validatePath } from "./storage.mjs";

export const LIST_CAP = 500;
const MAX_INPUT = 1024;
const MAX_NAME = 100;

const bad = (status, error) => Object.assign(new Error(error), { status });
const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

// ---------- parsing what the system prints ----------
const jsonOf = (text) => {
  try { return JSON.parse(String(text ?? "").replace(/^﻿/, "").trim()); } catch { return null; }
};
const WIN_TYPES = { 0: "unknown", 1: "none", 2: "removable", 3: "fixed", 4: "network", 5: "cdrom", 6: "ram" };
/** Windows' own name for a drive type (text from PowerShell, or WMI's number) as fixed / removable / network / other. */
export function winDriveKind(v) {
  const t = typeof v === "number" || /^\d+$/.test(String(v)) ? WIN_TYPES[Number(v)] : String(v ?? "").toLowerCase();
  if (t === "fixed") return "fixed";
  if (t === "removable") return "removable";
  if (t === "remote" || t === "network") return "network";
  return "other";
}
const letterOf = (v) => {
  const s = typeof v === "number" ? String.fromCharCode(v) : String(v ?? "");
  return /^[A-Za-z]$/.test(s.trim()) ? s.trim().toUpperCase() : null;
};
/** `Get-Volume … | ConvertTo-Json` → drives. Network, optical and letterless volumes are left out. */
export function parseGetVolume(text) {
  const j = jsonOf(text);
  const rows = Array.isArray(j) ? j : j && typeof j === "object" ? [j] : [];
  const out = [];
  for (const r of rows) {
    const letter = letterOf(r.DriveLetter);
    const kind = winDriveKind(r.DriveType);
    if (!letter || (kind !== "fixed" && kind !== "removable")) continue;
    const total = num(r.Size);
    if (!total) continue; // a card reader with nothing in it
    out.push({ letter, label: String(r.FileSystemLabel ?? "").trim(), fsType: String(r.FileSystemType ?? r.FileSystem ?? "").trim() || null, kind, total, free: num(r.SizeRemaining) });
  }
  return out.sort((a, b) => a.letter.localeCompare(b.letter));
}
/** `wmic logicaldisk get … /format:csv` → the same list, for computers where Get-Volume isn't there. */
export function parseWmic(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const head = lines.findIndex((l) => /(^|,)Caption(,|$)/i.test(l));
  if (head < 0) return [];
  const cols = lines[head].split(",").map((c) => c.trim().toLowerCase());
  const out = [];
  for (const line of lines.slice(head + 1)) {
    const v = line.split(",");
    const g = (k) => v[cols.indexOf(k)]?.trim() ?? "";
    const letter = letterOf(g("caption").slice(0, 1));
    const kind = winDriveKind(g("drivetype"));
    const total = num(g("size"));
    if (!letter || (kind !== "fixed" && kind !== "removable") || !total) continue;
    out.push({ letter, label: g("volumename"), fsType: g("filesystem") || null, kind, total, free: num(g("freespace")) });
  }
  return out.sort((a, b) => a.letter.localeCompare(b.letter));
}

const PSEUDO_FS = new Set(["proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "cgroup", "cgroup2", "securityfs", "debugfs", "tracefs", "configfs", "fusectl", "pstore", "bpf", "autofs", "mqueue", "hugetlbfs", "binfmt_misc", "overlay", "squashfs", "efivarfs", "ramfs", "rpc_pipefs", "nsfs", "selinuxfs", "nfsd", "fuse.gvfsd-fuse", "fuse.portal", "fuse.lxcfs", "fuse.snapfuse", "devfs", "fdescfs"]);
const NETWORK_FS = new Set(["nfs", "nfs4", "cifs", "smb", "smb3", "smbfs", "sshfs", "fuse.sshfs", "afpfs", "webdav", "davfs", "fuse.davfs2", "glusterfs", "ceph", "9p", "afs", "ncpfs"]);
const SKIP_MOUNTS = [/^\/(boot|snap|sys|proc|dev)(\/|$)/, /^\/run\/(?!media(\/|$))/, /^\/var\/(lib\/(docker|snapd|containers|kubelet|lxcfs)|snap)(\/|$)/];
/** `findmnt -J -b -o TARGET,SOURCE,FSTYPE,SIZE,AVAIL` → every mount (the tree flattened). */
export function parseFindmnt(text) {
  const j = jsonOf(text);
  const out = [];
  const walk = (list) => {
    for (const f of Array.isArray(list) ? list : []) {
      if (f && typeof f.target === "string") out.push({ target: f.target, source: String(f.source ?? ""), fsType: String(f.fstype ?? "") || null, total: num(f.size), free: num(f.avail) });
      walk(f?.children);
    }
  };
  walk(j?.filesystems);
  return out;
}
/** The mounts worth offering as a place for the data: real disks, not the kernel's, not network shares. */
export function usableMounts(mounts) {
  const seen = new Set();
  return mounts.filter((m) => {
    if (!m.fsType || PSEUDO_FS.has(m.fsType) || NETWORK_FS.has(m.fsType) || (m.fsType.startsWith("fuse.") && !/^fuse\.(ntfs|exfat)/.test(m.fsType))) return false;
    if (m.target !== "/" && SKIP_MOUNTS.some((re) => re.test(m.target))) return false;
    if (/^\/dev\/(loop|ram)/.test(m.source) && m.target !== "/") return false;
    if (seen.has(m.target)) return false;
    seen.add(m.target);
    return true;
  });
}
/** macOS `mount` → [{ source, target, fsType, local, hidden }]. */
export function parseMacMount(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^(.+?) on (.+?) \(([^)]*)\)\s*$/.exec(line);
    if (!m) continue;
    const flags = m[3].split(",").map((x) => x.trim());
    out.push({ source: m[1], target: m[2], fsType: flags[0] || null, local: flags.includes("local"), hidden: flags.includes("nobrowse") });
  }
  return out;
}

const FS_NAMES = { msdos: "FAT32", vfat: "FAT32", fat: "FAT32", fat32: "FAT32", exfat: "exFAT", ntfs: "NTFS", ntfs3: "NTFS", fuseblk: "NTFS (FUSE)", "fuse.ntfs": "NTFS", hfs: "Mac OS Extended", apfs: "APFS", ext4: "ext4", ext3: "ext3", ext2: "ext2", xfs: "XFS", btrfs: "Btrfs", zfs: "ZFS", refs: "ReFS" };
/** A short, readable name for a file system type. */
export const displayFs = (type) => (type ? FS_NAMES[String(type).toLowerCase()] ?? String(type) : null);

/** The mount a path lives on: the one with the longest matching target. */
export function mountFor(p, mounts, platform) {
  let best = null;
  for (const m of mounts) if (isInside(p, m.target, platform) && (!best || m.target.length > best.target.length)) best = m;
  return best;
}

// ---------- the drives ----------
const defaultFs = { readdir: (d) => readdirSync(d, { withFileTypes: true }), lstat: lstatSync, realpath: (p) => realpathSync.native(p), free: freeBytes, exists: existsSync };

function finish(root, platform) {
  const j = judgeFs(root.fsType, platform);
  const out = { ...root, fsName: displayFs(root.fsType), warning: j.warning ?? null, error: j.error ?? null, holdsData: false };
  out.usable = !out.error;
  return out;
}
/** Flags the one root the data lives on (the most specific one). */
function markData(roots, data, platform) {
  if (!data) return roots;
  let best = -1;
  roots.forEach((r, i) => { if (isInside(data, r.path, platform) && (best < 0 || r.path.length > roots[best].path.length)) best = i; });
  if (best >= 0) roots[best].holdsData = true;
  return roots;
}

/** The drives and places the picker starts from, for this operating system. `run(cmd, args)` returns stdout (or throws). */
export async function buildRoots({ platform = process.platform, run, home = os.homedir(), data = null, fsx = {} } = {}) {
  const f = { ...defaultFs, ...fsx };
  const m = modFor(platform);
  const space = (p) => { try { return f.free(p); } catch { return { free: null, total: null }; } };
  let roots = [];
  if (platform === "win32") {
    let vols = [];
    try { vols = parseGetVolume(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Volume | Where-Object { $_.DriveLetter } | Select-Object @{n='DriveLetter';e={[string]$_.DriveLetter}},FileSystemLabel,@{n='FileSystemType';e={[string]$_.FileSystemType}},@{n='DriveType';e={[string]$_.DriveType}},Size,SizeRemaining | ConvertTo-Json -Compress"])); } catch { /* try wmic */ }
    if (!vols.length) { try { vols = parseWmic(await run("wmic", ["logicaldisk", "get", "Caption,DriveType,FileSystem,FreeSpace,Size,VolumeName", "/format:csv"])); } catch { /* none */ } }
    roots = vols.map((v) => finish({ path: `${v.letter}:\\`, label: v.label || (v.kind === "removable" ? "Removable drive" : "Local disk"), kind: v.kind, letter: v.letter, fsType: v.fsType, free: v.free, total: v.total }, platform));
  } else if (platform === "darwin") {
    let mounts = [];
    try { mounts = parseMacMount(await run("mount", [])); } catch { /* unknown file systems */ }
    const info = (p) => mounts.find((x) => x.target === p) ?? null;
    roots.push(finish({ path: home, label: "Home folder", kind: "home", fsType: info("/System/Volumes/Data")?.fsType ?? info("/")?.fsType ?? null, ...space(home) }, platform));
    let names = [];
    try { names = f.readdir("/Volumes"); } catch { /* none */ }
    for (const e of names) {
      if (e.name.startsWith(".")) continue;
      const full = `/Volumes/${e.name}`;
      let boot = false;
      try { boot = e.isSymbolicLink() && f.realpath(full) === "/"; } catch { /* broken link */ }
      if (boot) { roots.push(finish({ path: "/", label: e.name, kind: "boot", fsType: info("/")?.fsType ?? null, ...space("/") }, platform)); continue; }
      if (e.isSymbolicLink()) continue;
      const mt = info(full);
      if (!mt || mt.hidden || (mt.fsType && (NETWORK_FS.has(mt.fsType) || PSEUDO_FS.has(mt.fsType))) || (!mt.local && !mt.source.startsWith("/dev/"))) continue;
      roots.push(finish({ path: full, label: e.name, kind: "external", fsType: mt.fsType, ...space(full) }, platform));
    }
    if (!roots.some((r) => r.kind === "boot")) roots.splice(1, 0, finish({ path: "/", label: "This Mac", kind: "boot", fsType: info("/")?.fsType ?? null, ...space("/") }, platform));
  } else {
    let all = [];
    try { all = parseFindmnt(await run("findmnt", ["-J", "-b", "-o", "TARGET,SOURCE,FSTYPE,SIZE,AVAIL"])); } catch { /* findmnt missing */ }
    const real = usableMounts(all);
    const label = (t) => (t === "/" ? "System disk" : m.basename(t));
    const added = new Set();
    const push = (r) => { if (!added.has(r.path)) { added.add(r.path); roots.push(finish(r, platform)); } };
    for (const mt of real.filter((x) => x.target !== "/")) push({ path: mt.target, label: label(mt.target), kind: "mount", fsType: mt.fsType, free: mt.free ?? space(mt.target).free, total: mt.total ?? space(mt.target).total });
    for (const dir of ["/srv", home]) {
      if (!dir || dir === "/" || added.has(dir) || !f.exists(dir)) continue;
      const mt = mountFor(dir, all, platform);
      push({ path: dir, label: dir === home ? "Home folder" : m.basename(dir), kind: dir === home ? "home" : "folder", fsType: mt?.fsType ?? null, ...space(dir) });
    }
    const rootMt = all.find((x) => x.target === "/");
    push({ path: "/", label: "System disk", kind: "boot", fsType: rootMt?.fsType ?? null, free: rootMt?.free ?? space("/").free, total: rootMt?.total ?? space("/").total });
  }
  return markData(roots, data, platform);
}

// ---------- folders ----------
const WIN_HIDDEN = (name) => name.startsWith("$");
/**
 * Keeps the real sub-folders of a directory listing: no files, no shortcuts, no names with control characters, no system
 * folders (unless inside a mounted drive), and, unless asked, no hidden ones. Returns { entries, hidden, links, truncated }.
 */
export function filterEntries(dirents, { dir, platform = process.platform, showHidden = false, home = null, exempt = () => false, cap = LIST_CAP } = {}) {
  const m = modFor(platform);
  const found = [];
  let hidden = 0, links = 0;
  for (const e of dirents) {
    const name = e.name;
    if (/[\u0000-\u001f\u007f]/.test(name)) continue;
    if (e.isSymbolicLink()) { links++; continue; }
    if (!e.isDirectory()) continue;
    const full = m.join(dir, name);
    if (isSystemPath(full, platform) && !exempt(full)) continue;
    const isHidden = name.startsWith(".") || (platform === "win32" && WIN_HIDDEN(name)) || (platform === "darwin" && home && pathKey(dir, platform) === pathKey(home, platform) && name === "Library");
    if (isHidden && !showHidden) { hidden++; continue; }
    found.push({ name, path: full });
  }
  found.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return { entries: found.slice(0, cap), hidden, links, truncated: found.length > cap };
}

/** Cleans the text of a path from the page: one absolute local path, no `..`. */
export function normaliseFsPath(input, platform = process.platform) {
  if (typeof input !== "string" || !input.trim()) return { ok: false, error: "No folder given." };
  if (input.length > MAX_INPUT) return { ok: false, error: "That path is too long." };
  let p = input.trim();
  if (/[\u0000-\u001f\u007f]/.test(p)) return { ok: false, error: "That path has characters a folder name can't have." };
  const win = platform === "win32";
  const m = modFor(platform);
  if (win) {
    if (!/^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}/.test(p)) return { ok: false, error: "Use a folder on a drive inside this computer." };
    p = p.replace(/\//g, "\\");
  } else if (!p.startsWith("/")) return { ok: false, error: "Use the full path, starting with /." };
  if (p.slice(m.parse(p).root.length).split(win ? /\\+/ : /\/+/).some((s) => s === "..")) return { ok: false, error: "Leave out '..' from the path." };
  let out = m.normalize(p);
  if (out.length > m.parse(out).root.length) out = out.replace(/[\\/]+$/, "");
  return { ok: true, path: out };
}

/**
 * The picker's engine. `ctx()` supplies { current, forbidden } (where the data is now, the program folders) so the
 * "can I choose this?" answer is the same one Check folder will give. `getRoots` is replaceable for tests.
 */
export function createBrowser({ platform = process.platform, run, home = os.homedir(), ctx = () => ({}), getRoots = null, fsx = {}, cap = LIST_CAP, ttlMs = 8000, now = Date.now } = {}) {
  const f = { ...defaultFs, ...fsx };
  const m = modFor(platform);
  let cache = { at: 0, roots: null };
  const rootsNow = async (fresh = false) => {
    if (getRoots) return getRoots();
    if (!fresh && cache.roots && now() - cache.at < ttlMs) return cache.roots;
    const c = ctx();
    cache = { at: now(), roots: await buildRoots({ platform, run, home, data: c.current ?? null, fsx }) };
    return cache.roots;
  };
  const isFsRoot = (p) => m.parse(p).root === p;

  /** Resolves a path from the page to a real folder inside a drive, or throws a sentence for the owner. */
  async function locate(input) {
    const n = normaliseFsPath(input, platform);
    if (!n.ok) throw bad(400, n.error);
    const roots = await rootsNow();
    let real;
    try { real = f.realpath(n.path); } catch (e) {
      throw bad(e.code === "ENOENT" || e.code === "ENOTDIR" ? 404 : 403, e.code === "ENOENT" || e.code === "ENOTDIR" ? "That folder doesn't exist (any more)." : "Nothing BOT Server isn't allowed to open that folder.");
    }
    if (pathKey(real, platform) !== pathKey(n.path, platform)) throw bad(403, "That path goes through a shortcut (symlink). Pick the real folder.");
    const inside = roots.filter((r) => isInside(real, r.path, platform));
    if (!inside.length) throw bad(403, "That isn't on one of this computer's drives.");
    const exempt = (p) => roots.some((r) => !isFsRoot(r.path) && isInside(p, r.path, platform));
    if (isSystemPath(real, platform) && !exempt(real)) throw bad(403, "That is a system folder. Nothing BOT Server keeps clear of those.");
    const top = inside.reduce((a, b) => (b.path.length < a.path.length ? b : a));
    const near = inside.reduce((a, b) => (b.path.length > a.path.length ? b : a));
    return { real, roots, exempt, top, near };
  }

  async function roots(fresh = false) {
    const list = await rootsNow(fresh);
    return { platform, sep: m.sep, roots: list };
  }

  async function list(input, { hidden = false } = {}) {
    const { real, exempt, top, near } = await locate(input);
    let dirents;
    try { dirents = f.readdir(real); } catch (e) {
      if (e.code === "ENOTDIR") throw bad(400, "That is a file, not a folder.");
      if (e.code === "ENOENT") throw bad(404, "That folder doesn't exist (any more).");
      throw bad(403, "Nothing BOT Server isn't allowed to look inside that folder.");
    }
    const r = filterEntries(dirents, { dir: real, platform, showHidden: hidden, home, exempt, cap });
    // Breadcrumb from the outermost drive that contains the folder, so /mnt/disk/x reads / › mnt › disk › x.
    const crumbs = [{ name: top.kind === "boot" || top.kind === "home" || top.kind === "mount" ? top.label : top.path.replace(/[\\/]+$/, ""), path: top.path }];
    let at = top.path;
    for (const seg of m.relative(top.path, real).split(m.sep).filter(Boolean)) { at = m.join(at, seg); crumbs.push({ name: seg, path: at }); }
    const c = ctx();
    const v = validatePath(real, { platform, current: c.current ?? null, forbidden: c.forbidden ?? [] });
    const j = judgeFs(near.fsType, platform);
    return {
      path: real, parent: real === top.path ? null : m.dirname(real), crumbs,
      root: { path: near.path, label: near.label, fsType: near.fsType, fsName: displayFs(near.fsType), free: near.free ?? null, total: near.total ?? null, warning: j.warning ?? null, error: j.error ?? null },
      entries: r.entries, hiddenCount: r.hidden, linkCount: r.links, truncated: r.truncated, empty: dirents.length === 0,
      choose: v.ok && !j.error ? { ok: true } : { ok: false, error: j.error ?? v.error },
    };
  }

  /** The text of a new folder's name, or a sentence about why it won't do. */
  function checkName(name, parent) {
    if (typeof name !== "string") return { ok: false, error: "Type a name for the new folder." };
    const n = name.trim();
    if (!n) return { ok: false, error: "Type a name for the new folder." };
    if (n.length > MAX_NAME) return { ok: false, error: `Keep the name under ${MAX_NAME} characters.` };
    if (/[\\/]/.test(n)) return { ok: false, error: "A folder name can't contain / or \\." };
    if (n === "." || n === "..") return { ok: false, error: "Pick a different name." };
    if (/[\u0000-\u001f\u007f]/.test(n)) return { ok: false, error: "That name has characters a folder name can't have." };
    const v = validatePath(m.join(parent, n), { platform });
    if (!v.ok) return { ok: false, error: v.error };
    return { ok: true, name: n };
  }

  async function mkdir(parent, name) {
    const { real } = await locate(parent);
    const k = checkName(name, real);
    if (!k.ok) throw bad(400, k.error);
    const target = m.join(real, k.name);
    try { mkdirSync(target, { mode: 0o755 }); } catch (e) {
      if (e.code === "EEXIST") throw bad(409, `A folder called "${k.name}" is already in there.`);
      // Ubuntu: the console isn't allowed to write most places; the root helper makes the folder when the move starts.
      if (platform === "linux" && ["EACCES", "EPERM", "EROFS"].includes(e.code)) return { ok: true, path: target, created: false };
      throw bad(403, e.code === "EACCES" || e.code === "EPERM" ? "Nothing BOT Server isn't allowed to make a folder there." : `Couldn't make the folder (${e.code || e.message}).`);
    }
    return { ok: true, path: target, created: true };
  }

  return { roots, list, mkdir, locate, checkName };
}
