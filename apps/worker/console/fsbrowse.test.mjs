import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRoots, createBrowser, displayFs, filterEntries, normaliseFsPath, parseFindmnt, parseGetVolume, parseMacMount, parseWmic, usableMounts, winDriveKind } from "./fsbrowse.mjs";
import { isSystemPath } from "./storage.mjs";

const GB = 1e9;
const WIN_VOLUMES = JSON.stringify([
  { DriveLetter: "C", FileSystemLabel: "Windows", FileSystemType: "NTFS", DriveType: "Fixed", Size: 500 * GB, SizeRemaining: 120 * GB },
  { DriveLetter: "D", FileSystemLabel: "Spot Disk", FileSystemType: "NTFS", DriveType: "Fixed", Size: 2000 * GB, SizeRemaining: 1500 * GB },
  { DriveLetter: "E", FileSystemLabel: "STICK", FileSystemType: "FAT32", DriveType: "Removable", Size: 30 * GB, SizeRemaining: 29 * GB },
  { DriveLetter: "F", FileSystemLabel: "Card", FileSystemType: "exFAT", DriveType: "Removable", Size: 128 * GB, SizeRemaining: 100 * GB },
  { DriveLetter: "G", FileSystemLabel: "Empty reader", FileSystemType: "", DriveType: "Removable", Size: 0, SizeRemaining: 0 },
  { DriveLetter: "H", FileSystemLabel: "DVD", FileSystemType: "CDFS", DriveType: "CD-ROM", Size: 4 * GB, SizeRemaining: 0 },
  { DriveLetter: "Z", FileSystemLabel: "nas", FileSystemType: "NTFS", DriveType: "Remote", Size: 8000 * GB, SizeRemaining: 100 * GB },
  { DriveLetter: "", FileSystemLabel: "Recovery", FileSystemType: "NTFS", DriveType: "Fixed", Size: GB, SizeRemaining: 0 },
]);
const WMIC = `\r\nNode,Caption,DriveType,FileSystem,FreeSpace,Size,VolumeName\r\nPC,C:,3,NTFS,120000000000,500000000000,Windows\r\nPC,D:,3,exFAT,1500000000000,2000000000000,Spot Disk\r\nPC,E:,2,FAT32,29000000000,30000000000,STICK\r\nPC,X:,4,NTFS,1,2,nas\r\nPC,Y:,5,,,,\r\n\r\n`;
const FINDMNT = JSON.stringify({
  filesystems: [{
    target: "/", source: "/dev/nvme0n1p2", fstype: "ext4", size: 100 * GB, avail: 40 * GB,
    children: [
      { target: "/sys", source: "sysfs", fstype: "sysfs", size: null, avail: null, children: [{ target: "/sys/fs/cgroup", source: "cgroup2", fstype: "cgroup2", size: null, avail: null }] },
      { target: "/proc", source: "proc", fstype: "proc", size: null, avail: null },
      { target: "/run", source: "tmpfs", fstype: "tmpfs", size: 3 * GB, avail: 3 * GB, children: [{ target: "/run/user/1000", source: "tmpfs", fstype: "tmpfs", size: GB, avail: GB }, { target: "/run/media/spot/USBDISK", source: "/dev/sdc1", fstype: "vfat", size: 16 * GB, avail: 15 * GB }] },
      { target: "/boot", source: "/dev/nvme0n1p3", fstype: "ext4", size: GB, avail: GB / 2, children: [{ target: "/boot/efi", source: "/dev/nvme0n1p1", fstype: "vfat", size: GB / 2, avail: GB / 3 }] },
      { target: "/mnt/disk", source: "/dev/sdb1", fstype: "ext4", size: 4000 * GB, avail: 3900 * GB },
      { target: "/mnt/ntfs", source: "/dev/sdd1", fstype: "fuseblk", size: 1000 * GB, avail: 900 * GB },
      { target: "/mnt/nas", source: "nas:/export", fstype: "nfs4", size: 1000 * GB, avail: 900 * GB },
      { target: "/snap/core/1", source: "/dev/loop1", fstype: "squashfs", size: 1, avail: 0 },
      { target: "/home/spot/gvfs", source: "gvfsd-fuse", fstype: "fuse.gvfsd-fuse", size: null, avail: null },
    ],
  }],
});
const MAC_MOUNT = [
  "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
  "devfs on /dev (devfs, local, nobrowse)",
  "/dev/disk3s6 on /System/Volumes/VM (apfs, local, noexec, journaled, nobrowse)",
  "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)",
  "/dev/disk5s2 on /Volumes/Backup HDD (apfs, local, journaled)",
  "/dev/disk6s1 on /Volumes/STICK (msdos, local, nodev, nosuid, noowners)",
  "/dev/disk7s1 on /Volumes/Cam (exfat, local, nodev, nosuid, noowners)",
  "//amrit@nas._smb._tcp.local/media on /Volumes/media (smbfs, nodev, nosuid, mounted by amrit)",
  "/dev/disk3s2 on /Volumes/com.apple.TimeMachine.localsnapshots (apfs, local, nobrowse)",
  "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
].join("\n");

describe("Windows drive parsing", () => {
  it("keeps fixed and removable drives with media, drops network, optical, empty and letterless ones", () => {
    const v = parseGetVolume(WIN_VOLUMES);
    expect(v.map((x) => x.letter)).toEqual(["C", "D", "E", "F"]);
    expect(v[0]).toMatchObject({ label: "Windows", fsType: "NTFS", kind: "fixed", total: 500 * GB, free: 120 * GB });
    expect(v[2]).toMatchObject({ fsType: "FAT32", kind: "removable" });
  });
  it("copes with a single object, a BOM, numeric enums and char codes, and garbage", () => {
    expect(parseGetVolume("\uFEFF" + JSON.stringify({ DriveLetter: 67, DriveType: 3, FileSystem: "NTFS", Size: 10, SizeRemaining: 5 }))).toHaveLength(1);
    expect(parseGetVolume("not json")).toEqual([]);
    expect(parseGetVolume("")).toEqual([]);
    expect(parseGetVolume("null")).toEqual([]);
  });
  it("maps drive types", () => {
    expect([2, "3", "Fixed", "Remote", 4, "CD-ROM", 5, "Unknown"].map(winDriveKind)).toEqual(["removable", "fixed", "fixed", "network", "network", "other", "other", "other"]);
  });
  it("parses the wmic fallback", () => {
    const v = parseWmic(WMIC);
    expect(v.map((x) => `${x.letter}:${x.fsType}:${x.kind}`)).toEqual(["C:NTFS:fixed", "D:exFAT:fixed", "E:FAT32:removable"]);
    expect(v[0]).toMatchObject({ label: "Windows", free: 120e9, total: 500e9 });
    expect(parseWmic("")).toEqual([]);
  });
  it("builds Windows roots with the file system rules attached, and the one that holds the data", async () => {
    const run = async () => WIN_VOLUMES;
    const roots = await buildRoots({ platform: "win32", run, data: "C:\\SpotSolutions\\data", fsx: {} });
    expect(roots.map((r) => r.path)).toEqual(["C:\\", "D:\\", "E:\\", "F:\\"]);
    expect(roots.find((r) => r.letter === "E")).toMatchObject({ usable: false, fsName: "FAT32" });
    expect(roots.find((r) => r.letter === "E").error).toMatch(/FAT32/);
    expect(roots.find((r) => r.letter === "F").warning).toMatch(/exFAT/);
    expect(roots.find((r) => r.letter === "D")).toMatchObject({ usable: true, warning: null, error: null });
    expect(roots.filter((r) => r.holdsData).map((r) => r.letter)).toEqual(["C"]);
  });
  it("falls back to wmic when PowerShell fails", async () => {
    const run = async (cmd) => { if (cmd === "wmic") return WMIC; throw new Error("no powershell"); };
    expect((await buildRoots({ platform: "win32", run })).map((r) => r.letter)).toEqual(["C", "D", "E"]);
    expect(await buildRoots({ platform: "win32", run: async () => { throw new Error("nothing"); } })).toEqual([]);
  });
});

describe("Ubuntu mounts", () => {
  it("flattens findmnt's tree", () => {
    const m = parseFindmnt(FINDMNT);
    expect(m.find((x) => x.target === "/mnt/disk")).toMatchObject({ source: "/dev/sdb1", fsType: "ext4", free: 3900 * GB });
    expect(m.some((x) => x.target === "/sys/fs/cgroup")).toBe(true);
    expect(parseFindmnt("oops")).toEqual([]);
  });
  it("keeps real disks, USB sticks under /run/media; drops kernel, boot, snap, network and gvfs mounts", () => {
    const keep = usableMounts(parseFindmnt(FINDMNT)).map((x) => x.target);
    expect(keep).toEqual(["/", "/run/media/spot/USBDISK", "/mnt/disk", "/mnt/ntfs"]);
  });
  it("builds roots: mounts first, the system disk last, with fs judgement", async () => {
    const roots = await buildRoots({ platform: "linux", run: async () => FINDMNT, home: "/home/spot", data: "/var/lib/spot-solutions", fsx: { exists: (p) => p === "/srv" || p === "/home/spot", free: () => ({ free: 5 * GB, total: 10 * GB }) } });
    expect(roots.map((r) => r.path)).toEqual(["/run/media/spot/USBDISK", "/mnt/disk", "/mnt/ntfs", "/srv", "/home/spot", "/"]);
    expect(roots.find((r) => r.path === "/mnt/disk")).toMatchObject({ fsName: "ext4", usable: true, free: 3900 * GB });
    expect(roots.find((r) => r.path === "/run/media/spot/USBDISK")).toMatchObject({ fsName: "FAT32", usable: false });
    expect(roots.find((r) => r.path === "/mnt/ntfs").error).toMatch(/permissions/);
    expect(roots.find((r) => r.path === "/").holdsData).toBe(true);
    expect(roots.find((r) => r.path === "/").label).toBe("System disk");
  });
  it("still offers the system disk when findmnt is missing", async () => {
    const roots = await buildRoots({ platform: "linux", run: async () => { throw new Error("ENOENT"); }, home: "/home/spot", fsx: { exists: () => false, free: () => ({ free: 1, total: 2 }) } });
    expect(roots.map((r) => r.path)).toEqual(["/"]);
  });
});

describe("macOS volumes", () => {
  it("parses mount output", () => {
    const m = parseMacMount(MAC_MOUNT);
    expect(m.find((x) => x.target === "/Volumes/Backup HDD")).toMatchObject({ fsType: "apfs", local: true, hidden: false });
    expect(m.find((x) => x.target === "/Volumes/media")).toMatchObject({ fsType: "smbfs", local: false });
    expect(m.find((x) => x.target === "/System/Volumes/Data").hidden).toBe(true);
  });
  const dirent = (name, link = false) => ({ name, isSymbolicLink: () => link, isDirectory: () => !link });
  it("lists home, the boot volume and local external drives; hides network, snapshots and hidden mounts", async () => {
    const fsx = {
      readdir: () => [dirent("Macintosh HD", true), dirent("Backup HDD"), dirent("STICK"), dirent("Cam"), dirent("media"), dirent("com.apple.TimeMachine.localsnapshots"), dirent(".hidden")],
      realpath: (p) => (p === "/Volumes/Macintosh HD" ? "/" : p),
      free: () => ({ free: 50 * GB, total: 100 * GB }),
    };
    const roots = await buildRoots({ platform: "darwin", run: async () => MAC_MOUNT, home: "/Users/amrit", data: "/Users/amrit/Library/Application Support/SpotSolutions/data", fsx });
    expect(roots.map((r) => `${r.kind}:${r.path}`)).toEqual(["home:/Users/amrit", "boot:/", "external:/Volumes/Backup HDD", "external:/Volumes/STICK", "external:/Volumes/Cam"]);
    expect(roots[1].label).toBe("Macintosh HD");
    expect(roots[0].holdsData).toBe(true);
    expect(roots[3]).toMatchObject({ fsName: "FAT32", usable: false });
    expect(roots[4]).toMatchObject({ fsName: "exFAT", usable: false }); // the Mac rule: exFAT is refused here
    expect(roots[2]).toMatchObject({ fsName: "APFS", usable: true });
  });
});

describe("names and paths", () => {
  it("shows readable file system names", () => {
    expect([displayFs("msdos"), displayFs("vfat"), displayFs("fuseblk"), displayFs("hfs"), displayFs("ext4"), displayFs("weirdfs"), displayFs(null)]).toEqual(["FAT32", "FAT32", "NTFS (FUSE)", "Mac OS Extended", "ext4", "weirdfs", null]);
  });
  it("normalises absolute local paths and refuses the rest", () => {
    expect(normaliseFsPath("D:/Spot//data/", "win32")).toEqual({ ok: true, path: "D:\\Spot\\data" });
    expect(normaliseFsPath("D:\\", "win32")).toEqual({ ok: true, path: "D:\\" });
    for (const bad of ["", "  ", "\\\\nas\\share", "relative", "D:\\a\\..\\b", "C:", 5, null, "D:\\a\u0000"]) expect(normaliseFsPath(bad, "win32").ok).toBe(false);
    expect(normaliseFsPath("/mnt/disk/", "linux")).toEqual({ ok: true, path: "/mnt/disk" });
    expect(normaliseFsPath("/", "linux")).toEqual({ ok: true, path: "/" });
    for (const bad of ["mnt/disk", "/mnt/../etc", "/a\nb", "x".repeat(2000)]) expect(normaliseFsPath(bad, "linux").ok).toBe(false);
  });
  it("knows system folders per platform", () => {
    expect(isSystemPath("C:\\Windows\\System32", "win32")).toBe(true);
    expect(isSystemPath("D:\\Spot", "win32")).toBe(false);
    expect(isSystemPath("/usr/lib", "linux")).toBe(true);
    expect(isSystemPath("/mnt/disk", "linux")).toBe(false);
    expect(isSystemPath("/System/Library", "darwin")).toBe(true);
    expect(isSystemPath("/Users/amrit", "darwin")).toBe(false);
    expect(isSystemPath("/var/lib/spot", "darwin")).toBe(false);
  });
});

describe("filtering a folder listing", () => {
  const e = (name, kind = "d") => ({ name, isDirectory: () => kind === "d", isSymbolicLink: () => kind === "l", isFile: () => kind === "f" });
  it("keeps only real sub-folders, in natural order, hiding dot folders and counting what it hid", () => {
    const r = filterEntries([e("b10"), e("b2"), e("A"), e(".git"), e("file.txt", "f"), e("shortcut", "l"), e("bad\nname")], { dir: "/mnt/disk", platform: "linux" });
    expect(r.entries.map((x) => x.name)).toEqual(["A", "b2", "b10"]);
    expect(r.entries[0].path).toBe("/mnt/disk/A");
    expect(r).toMatchObject({ hidden: 1, links: 1, truncated: false });
    expect(filterEntries([e(".git"), e("x")], { dir: "/mnt/disk", platform: "linux", showHidden: true }).entries.map((x) => x.name)).toEqual([".git", "x"]);
  });
  it("never lists system folders, even when hidden folders are shown, unless inside a mounted drive", () => {
    const names = (opts) => filterEntries([e("usr"), e("etc"), e("mnt"), e("home")], { dir: "/", platform: "linux", showHidden: true, ...opts }).entries.map((x) => x.name);
    expect(names({})).toEqual(["home", "mnt"]);
    expect(names({ exempt: () => true })).toEqual(["etc", "home", "mnt", "usr"]);
    expect(filterEntries([e("Windows"), e("Program Files"), e("$Recycle.Bin"), e("Users"), e("Spot")], { dir: "C:\\", platform: "win32" }).entries.map((x) => x.name)).toEqual(["Spot", "Users"]);
  });
  it("hides Library in a Mac home folder", () => {
    expect(filterEntries([e("Library"), e("Documents")], { dir: "/Users/amrit", platform: "darwin", home: "/Users/amrit" }).entries.map((x) => x.name)).toEqual(["Documents"]);
  });
  it("caps the list", () => {
    const many = Array.from({ length: 12 }, (_, i) => e(`d${String(i).padStart(2, "0")}`));
    const r = filterEntries(many, { dir: "/mnt/disk", platform: "linux", cap: 5 });
    expect(r.entries).toHaveLength(5);
    expect(r.truncated).toBe(true);
  });
});

const PLAT = process.platform === "win32" ? "win32" : "linux"; // a temp folder on a Mac lives under /private, which the Mac rules call a system folder
describe("browsing real folders", () => {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "spot-fs-")));
  const outside = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "spot-out-")));
  for (const d of ["alpha", "beta/inner", ".hidden", "empty"]) mkdirSync(path.join(base, d), { recursive: true });
  writeFileSync(path.join(base, "secret.txt"), "top secret");
  mkdirSync(path.join(outside, "elsewhere"));
  let linked = true;
  try { symlinkSync(outside, path.join(base, "link-out")); } catch { linked = false; }
  const roots = [{ path: base, label: "Test disk", kind: "mount", fsType: "ext4", free: 5e9, total: 1e10, error: null, warning: null }];
  const b = createBrowser({ platform: PLAT, getRoots: async () => roots, ctx: () => ({ current: path.join(os.tmpdir(), "nowhere-data"), forbidden: [] }) });
  const fail = async (p) => { try { await p; } catch (e) { return e; } return null; };

  it("lists sub-folders only (no files, no hidden, no links), with a breadcrumb and a verdict", async () => {
    const r = await b.list(base);
    expect(r.entries.map((x) => x.name)).toEqual(["alpha", "beta", "empty"]);
    expect(JSON.stringify(r)).not.toMatch(/secret|top secret|link-out/);
    expect(r.hiddenCount).toBe(1);
    expect(r.parent).toBeNull();
    expect(r.crumbs).toEqual([{ name: "Test disk", path: base }]);
    expect(r.root).toMatchObject({ label: "Test disk", fsName: "ext4" });
    expect(r.choose.ok).toBe(true);
    const h = await b.list(base, { hidden: true });
    expect(h.entries.map((x) => x.name)).toContain(".hidden");
    if (linked) expect(r.linkCount).toBe(1);
  });
  it("goes deeper, knows its parent, and reports empty", async () => {
    const r = await b.list(path.join(base, "beta"));
    expect(r.entries.map((x) => x.name)).toEqual(["inner"]);
    expect(r.parent).toBe(base);
    expect(r.crumbs.map((c) => c.name)).toEqual(["Test disk", "beta"]);
    expect((await b.list(path.join(base, "empty"))).empty).toBe(true);
  });
  it("refuses anything outside the roots, traversal, files, shortcuts and bad input", async () => {
    expect((await fail(b.list(outside))).status).toBe(403);
    expect((await fail(b.list(`${base}${path.sep}..${path.sep}${path.basename(outside)}`))).message).toMatch(/\.\./);
    expect((await fail(b.list("/"))).status).toBe(403);
    expect((await fail(b.list(path.join(base, "secret.txt")))).message).toMatch(/file|doesn't exist/);
    expect((await fail(b.list(path.join(base, "nope")))).status).toBe(404);
    expect((await fail(b.list("relative/path"))).status).toBe(400);
    expect((await fail(b.list(""))).status).toBe(400);
    expect((await fail(b.list(path.join(base, "alpha") + "\u0000"))).status).toBe(400);
    if (linked) {
      expect((await fail(b.list(path.join(base, "link-out")))).message).toMatch(/shortcut/);
      expect((await fail(b.list(path.join(base, "link-out", "elsewhere")))).message).toMatch(/shortcut/);
      expect((await fail(b.mkdir(path.join(base, "link-out"), "x"))).message).toMatch(/shortcut/);
    }
  });
  it("says why a folder can't be chosen, with the same rules as Check folder", async () => {
    mkdirSync(path.join(base, "program"), { recursive: true });
    const guarded = createBrowser({ platform: PLAT, getRoots: async () => roots, ctx: () => ({ forbidden: [{ path: path.join(base, "program"), label: "the program folder" }] }) });
    const r = await guarded.list(path.join(base, "program"));
    expect(r.choose.ok).toBe(false);
    expect(r.choose.error).toMatch(/program folder/);
    mkdirSync(path.join(base, "it's"), { recursive: true });
    expect((await b.list(path.join(base, "it's"))).choose.error).toMatch(/can't contain/);
  });
  it("blocks a drive that can't hold the data from being chosen", async () => {
    const fat = createBrowser({ platform: "linux", getRoots: async () => [{ ...roots[0], fsType: "vfat" }], ctx: () => ({}) });
    const r = await fat.list(base);
    expect(r.choose.ok).toBe(false);
    expect(r.choose.error).toMatch(/vfat/);
  });
  it("makes a new folder inside a root, and refuses bad names, repeats and traversal", async () => {
    const ok = await b.mkdir(base, "  Spot Data  ");
    expect(ok).toEqual({ ok: true, path: path.join(base, "Spot Data"), created: true });
    expect((await b.list(base)).entries.map((x) => x.name)).toContain("Spot Data");
    expect((await fail(b.mkdir(base, "Spot Data"))).status).toBe(409);
    for (const name of ["", "   ", ".", "..", "../x", "a/b", "a\\b", "x\u0000y", "with'quote", "a$b", "x".repeat(101), null, 5]) {
      const e = await fail(b.mkdir(base, name));
      expect(e, JSON.stringify(name)).not.toBeNull();
      expect(e.status).toBe(400);
    }
    expect((await fail(b.mkdir(outside, "x"))).status).toBe(403);
    expect((await fail(b.mkdir(path.join(base, "nope"), "x"))).status).toBe(404);
    expect((await fail(b.mkdir(`${base}${path.sep}..${path.sep}${path.basename(outside)}`, "x"))).message).toMatch(/\.\./);
  });
  it("never enters a system folder", async () => {
    const sys = process.platform === "win32" ? null : process.platform === "darwin" ? "/System" : "/usr";
    if (!sys) return;
    const real = createBrowser({ platform: process.platform, getRoots: async () => [{ path: "/", label: "System disk", kind: "boot", fsType: "apfs" }], ctx: () => ({}) });
    expect((await fail(real.list(sys))).status).toBe(403);
    expect((await fail(real.mkdir(sys, "x"))).status).toBe(403);
    expect((await real.list("/")).entries.map((x) => x.name.toLowerCase())).not.toContain(sys.slice(1).toLowerCase());
  });
});
