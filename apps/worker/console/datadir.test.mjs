import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GB, requiredBytes, cloudProvider, cleanPath, parseWindowsVolumes, parseMacVolumes, parseLinuxVolumes, volumeProblem, layoutFor, rankCandidates, suggest,
  validateChoice, spaceCheck, readExisting, installExists, applyChoice, decide, main,
} from "../../../deploy/datadir.mjs";
import { readPointer } from "./storage.mjs";

const REPO = path.join(import.meta.dirname, "..", "..", "..");
const text = (...p) => readFileSync(path.join(REPO, ...p), "utf8");
const noReal = () => null;

const vol = (o) => ({ fsType: "NTFS", total: 2e12, removable: false, network: false, system: false, label: "", ...o });
const winVolumes = () => [
  vol({ mount: "C:\\", device: "C:", free: 120 * GB, system: true }),
  vol({ mount: "D:\\", device: "D:", free: 1800 * GB }),
  vol({ mount: "E:\\", device: "E:", free: 3000 * GB, removable: true }),
  vol({ mount: "Z:\\", device: "Z:", free: 5000 * GB, network: true }),
];
const winLayout = (extra = {}) => layoutFor("win32", { env: { OneDrive: "C:\\Users\\Pat\\OneDrive" }, home: "C:\\Users\\Pat", stateDir: "C:\\NothingBotServer", programRoot: "C:\\NothingBotServer", programDir: "C:\\NothingBotServer\\app", forbid: ["C:\\NothingBotServer\\node"], ...extra });

describe("how much room it needs", () => {
  it("is about 5 GB with the default model, and follows the model size", () => {
    expect(requiredBytes()).toBeGreaterThan(4.9 * GB);
    expect(requiredBytes()).toBeLessThan(5.1 * GB);
    expect(requiredBytes({ model: "gemma3:12b" })).toBeGreaterThan(requiredBytes({ model: "gemma3:4b" }));
    expect(requiredBytes({ model: "somemodel:7b" })).toBeGreaterThan(requiredBytes({ model: "gemma3:4b" }));
    expect(requiredBytes({ noLocal: true })).toBeLessThan(requiredBytes());
    expect(requiredBytes({ modelsPresent: true })).toBeLessThan(requiredBytes());
  });
  it("compares free space with it", () => {
    expect(spaceCheck({ free: 3 * GB }, 5 * GB).enough).toBe(false);
    expect(spaceCheck({ free: 30 * GB }, 5 * GB).enough).toBe(true);
  });
});

describe("ranking the disks", () => {
  it("pre-selects the fixed disk with the most free space, on Windows", () => {
    const ranked = rankCandidates(winVolumes(), winLayout());
    const best = suggest(ranked);
    // E: (USB) and Z: (network) have more room but are not suitable
    expect(best.volume.device).toBe("D:");
    expect(best.base).toBe("D:\\Nothing BOT Server");
    expect(best.dataDir).toBe("D:\\Nothing BOT Server\\data");
    expect(best.modelsDir).toBe("D:\\Nothing BOT Server\\ollama");
    expect(ranked.filter((c) => c.ok).map((c) => c.volume.device)).toEqual(["D:", "C:"]);
    expect(ranked.filter((c) => !c.ok).map((c) => c.volume.device).sort()).toEqual(["E:", "Z:"]);
  });
  it("suggests the default location when the system drive has the most room", () => {
    const v = winVolumes(); v[0].free = 900 * GB; v[1].free = 100 * GB;
    const best = suggest(rankCandidates(v, winLayout()));
    expect(best.isDefault).toBe(true);
    expect(best.dataDir).toBe("C:\\NothingBotServer\\data");
    expect(best.modelsDir).toBe("C:\\NothingBotServer\\ollama");
  });
  it("breaks a tie for the system disk and skips FAT32", () => {
    const v = [vol({ mount: "D:\\", device: "D:", free: 50 * GB }), vol({ mount: "C:\\", device: "C:", free: 50 * GB, system: true }), vol({ mount: "F:\\", device: "F:", free: 900 * GB, fsType: "FAT32" })];
    const ranked = rankCandidates(v, winLayout());
    expect(suggest(ranked).volume.device).toBe("C:");
    expect(ranked.find((c) => c.volume.device === "F:").ok).toBe(false);
  });
  it("works the same on Linux and macOS", () => {
    const lin = layoutFor("linux", {});
    const lv = [
      { mount: "/", device: "/dev/sda2", fsType: "ext4", free: 60 * GB, total: 200 * GB, system: true, removable: false, network: false },
      { mount: "/mnt/data", device: "/dev/sdb1", fsType: "ext4", free: 900 * GB, total: 1e12, system: false, removable: false, network: false },
      { mount: "/media/pat/USB", device: "/dev/sdc1", fsType: "ext4", free: 9000 * GB, total: 1e13, system: false, removable: true, network: false },
    ];
    expect(suggest(rankCandidates(lv, lin)).base).toBe("/mnt/data/nothing-bot-server");
    lv[1].free = 10 * GB;
    expect(suggest(rankCandidates(lv, lin)).dataDir).toBe("/var/lib/nothing-bot-server");
    const mac = layoutFor("darwin", { home: "/Users/pat" });
    const mv = [
      { mount: "/", device: "/dev/disk3s1", fsType: "apfs", free: 80 * GB, total: 500 * GB, system: true, removable: false, network: false, label: "Macintosh HD" },
      { mount: "/Volumes/Big", device: "/dev/disk5s1", fsType: "apfs", free: 800 * GB, total: 1e12, system: false, removable: false, network: false, label: "Big" },
      { mount: "/Volumes/Stick", device: "/dev/disk6s1", fsType: "apfs", free: 4000 * GB, total: 1e13, system: false, removable: true, network: false, label: "Stick" },
    ];
    expect(suggest(rankCandidates(mv, mac)).base).toBe("/Volumes/Big/Nothing BOT Server");
  });
});

describe("refusing bad places", () => {
  const L = winLayout();
  const V = winVolumes();
  const bad = (p, re) => { const r = validateChoice(p, L, V, { realpath: noReal }); expect(r.ok).toBe(false); expect(r.error).toMatch(re); expect(r.error.split("\n")).toHaveLength(1); };
  it("rejects cloud-synced folders", () => {
    bad("D:\\OneDrive\\Nothing BOT Server", /OneDrive/);
    bad("D:\\OneDrive - Contoso\\x", /OneDrive/);
    bad("C:\\Users\\Pat\\OneDrive\\Desktop\\nbs", /OneDrive/);
    bad("D:\\Users\\Pat\\Dropbox (Personal)\\nbs", /Dropbox/);
    bad("D:\\Google Drive\\nbs", /Google Drive/);
    bad("D:\\iCloudDrive\\nbs", /iCloud/);
  });
  it("rejects the environment's OneDrive paths even when the folder isn't named that", () => {
    const r = validateChoice("D:\\Sync\\here", winLayout({ env: { OneDriveCommercial: "D:\\Sync" } }), V, { realpath: noReal });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/OneDrive/);
  });
  it("rejects a folder that leads into a cloud folder through a shortcut", () => {
    const r = validateChoice("D:\\Docs\\nbs", L, V, { realpath: () => "D:\\Users\\Pat\\OneDrive\\Documents\\nbs" });
    expect(r.ok).toBe(false);
  });
  it("rejects removable, USB and network drives", () => {
    bad("E:\\Nothing BOT Server", /removable/);
    bad("Z:\\nbs", /network/);
    bad("\\\\server\\share\\nbs", /network/);
    bad("Q:\\nbs", /isn't available/);
  });
  it("rejects the program folder, and anything around or inside it", () => {
    bad("C:\\NothingBotServer\\app", /program/);
    bad("C:\\NothingBotServer\\app\\data", /program/);
    bad("C:\\NothingBotServer\\node", /program/);
    bad("C:\\", /not the whole drive/);
  });
  it("rejects system folders and bad names", () => {
    bad("C:\\Windows\\nbs", /system/);
    bad("D:\\what?", /can't contain/);
    bad("nbs", /full path/);
  });
  it("accepts a good fixed disk, and the default typed out", () => {
    const ok = validateChoice("D:\\My Bot", L, V, { realpath: noReal });
    expect(ok).toMatchObject({ ok: true, isDefault: false, dataDir: "D:\\My Bot\\data", modelsDir: "D:\\My Bot\\ollama" });
    expect(validateChoice("C:\\NothingBotServer", L, V, { realpath: noReal })).toMatchObject({ ok: true, isDefault: true, dataDir: "C:\\NothingBotServer\\data" });
  });
  it("applies the same rules on macOS and Linux", () => {
    const mac = layoutFor("darwin", { home: "/Users/pat", programRoot: "/Users/pat/Library/Application Support/NothingBotServer" });
    const mv = [
      { mount: "/", device: "d1", fsType: "apfs", free: 80 * GB, total: 500 * GB, system: true, removable: false, network: false },
      { mount: "/Volumes/Stick", device: "d2", fsType: "apfs", free: 80 * GB, total: 500 * GB, system: false, removable: true, network: false, label: "Stick" },
    ];
    const m = (p) => validateChoice(p, { ...mac, icloudDesktop: false }, mv, { realpath: noReal });
    expect(m("/Users/pat/Library/Mobile Documents/com~apple~CloudDocs/nbs").error).toMatch(/iCloud/);
    expect(m("/Users/pat/Library/CloudStorage/Dropbox/nbs").ok).toBe(false);
    expect(m("/Users/pat/Dropbox/nbs").error).toMatch(/Dropbox/);
    expect(m("/Volumes/Stick/nbs").error).toMatch(/removable|external/);
    expect(m("/Users/pat/Library/Application Support/NothingBotServer/app/x").error).toMatch(/program/);
    expect(validateChoice("/Users/pat/Documents/nbs", { ...mac, icloudDesktop: true }, mv, { realpath: noReal }).error).toMatch(/iCloud/);
    expect(m("/Users/pat/nbs").ok).toBe(true);
    const lin = layoutFor("linux", {});
    const lv = [
      { mount: "/", device: "/dev/sda2", fsType: "ext4", free: 80 * GB, total: 500 * GB, system: true, removable: false, network: false },
      { mount: "/media/pat/USB", device: "/dev/sdb1", fsType: "ext4", free: 80 * GB, total: 500 * GB, removable: true, network: false },
      { mount: "/mnt/nas", device: "nas:/x", fsType: "nfs4", free: 80 * GB, total: 500 * GB, removable: false, network: true },
    ];
    const l = (p) => validateChoice(p, lin, lv, { realpath: noReal });
    expect(l("/media/pat/USB/nbs").error).toMatch(/removable/);
    expect(l("/mnt/nas/nbs").error).toMatch(/network/);
    expect(l("/opt/nothing-bot-server/data").error).toMatch(/program/);
    expect(l("/home/pat/Dropbox/nbs").error).toMatch(/Dropbox|home/);
    expect(l("/srv/nbs")).toMatchObject({ ok: true, dataDir: "/srv/nbs/data", modelsDir: "/srv/nbs/ollama" });
  });
  it("cloud names", () => {
    expect(cloudProvider("D:\\stuff\\OneDrive\\x", { platform: "win32", env: {} })).toBe("OneDrive");
    expect(cloudProvider("D:\\stuff\\Onedrivers\\x", { platform: "win32", env: {} })).toBeNull();
    expect(cleanPath("D:/a/b", { platform: "win32" }).path).toBe("D:\\a\\b");
  });
});

describe("what the system tools print", () => {
  it("reads Windows drives (DriveType 2 and 4, USB bus)", () => {
    const json = JSON.stringify([
      { id: "C:", type: 3, free: 1e11, size: 5e11, fs: "NTFS", label: "OS", bus: "NVMe" },
      { id: "D:", type: 3, free: 9e11, size: 1e12, fs: "NTFS", label: "Data", bus: "SATA" },
      { id: "E:", type: 2, free: 9e9, size: 1e10, fs: "FAT32", label: "STICK", bus: null },
      { id: "F:", type: 3, free: 9e11, size: 1e12, fs: "NTFS", label: "Passport", bus: "USB" },
      { id: "Z:", type: 4, free: 9e11, size: 1e12, fs: "NTFS", label: "NAS", bus: null },
    ]);
    const v = parseWindowsVolumes(json, { systemDrive: "C:" });
    const byId = Object.fromEntries(v.map((x) => [x.device, x]));
    expect(byId["C:"].system).toBe(true);
    expect(byId["E:"].removable).toBe(true);
    expect(byId["F:"].removable).toBe(true);
    expect(byId["Z:"].network).toBe(true);
    expect(volumeProblem(byId["D:"], { platform: "win32" })).toBeNull();
    expect(parseWindowsVolumes(JSON.stringify({ id: "C:", type: 3, free: 1, size: 2, fs: "NTFS" }))).toHaveLength(1); // one drive: PowerShell prints an object, not an array
  });
  it("reads macOS volumes (external and network ones are flagged)", () => {
    const df = `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/disk3s1s1 488245288 20000000 90000000 19% /
/dev/disk3s6 488245288 1 90000000 1% /System/Volumes/VM
/dev/disk5s1 976490576 1000 900000000 1% /Volumes/Big Disk
/dev/disk6s1 976490576 1000 900000000 1% /Volumes/Stick
//pat@nas/share 976490576 1000 900000000 1% /Volumes/share
/dev/disk3s3 488245288 1 90000000 1% /Volumes/Recovery
/dev/disk3s7 488245288 1 90000000 1% /Volumes/Macintosh HD - Data`;
    const mount = `/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
/dev/disk5s1 on /Volumes/Big Disk (apfs, local, journaled)
/dev/disk6s1 on /Volumes/Stick (exfat, local, nodev, nosuid)
/dev/disk3s3 on /Volumes/Recovery (apfs, local, journaled, nobrowse)
//pat@nas/share on /Volumes/share (smbfs, nodev, nosuid, mounted by pat)`;
    const info = { "/Volumes/Big Disk": "Device Location: Internal\nInternal: Yes\nRemovable Media: Fixed", "/Volumes/Stick": "Device Location: External\nInternal: No\nProtocol: USB" };
    const v = parseMacVolumes(df, mount, info);
    expect(v.map((x) => x.mount)).toEqual(["/", "/Volumes/Big Disk", "/Volumes/Stick", "/Volumes/share"]);
    expect(v[0].system).toBe(true);
    expect(v[1]).toMatchObject({ removable: false, network: false, free: 900000000 * 1024 });
    expect(v[2].removable).toBe(true);
    expect(v[3].network).toBe(true);
  });
  it("reads Linux mounts (media/removable, network, only real disks)", () => {
    const findmnt = `/ /dev/sda2 ext4 60000000000 200000000000 rw,relatime
/boot/efi /dev/sda1 vfat 500000000 600000000 rw
/snap/core/1 /dev/loop3 squashfs 0 100 ro
/home /dev/mapper/vg-home ext4 400000000000 500000000000 rw
/mnt/big /dev/sdb1 xfs 900000000000 1000000000000 rw
/media/pat/KEY /dev/sdc1 ext4 9000000000 10000000000 rw
/mnt/usbdisk /dev/sdd1 ext4 9000000000 10000000000 rw
/mnt/nas nas:/export nfs4 900000000000 1000000000000 rw
/run/user/1000 tmpfs tmpfs 100 200 rw
/mnt/with\\x20space /dev/sde1 ext4 100 200 rw`;
    const lsblk = `NAME="sda" PKNAME="" RM="0" HOTPLUG="0" TRAN="sata"
NAME="sda2" PKNAME="sda" RM="0" HOTPLUG="0" TRAN=""
NAME="sdb" PKNAME="" RM="0" HOTPLUG="0" TRAN="sata"
NAME="sdb1" PKNAME="sdb" RM="0" HOTPLUG="0" TRAN=""
NAME="sdd" PKNAME="" RM="0" HOTPLUG="1" TRAN="usb"
NAME="sdd1" PKNAME="sdd" RM="0" HOTPLUG="1" TRAN=""
NAME="vg-home" PKNAME="sda2" RM="0" HOTPLUG="0" TRAN=""`;
    const v = parseLinuxVolumes(findmnt, lsblk);
    const by = Object.fromEntries(v.map((x) => [x.mount, x]));
    expect(Object.keys(by).sort()).toEqual(["/", "/home", "/media/pat/KEY", "/mnt/big", "/mnt/nas", "/mnt/usbdisk", "/mnt/with space"].sort());
    expect(by["/"].system).toBe(true);
    expect(by["/mnt/big"].removable).toBe(false);
    expect(by["/media/pat/KEY"].removable).toBe(true);
    expect(by["/mnt/usbdisk"].removable).toBe(true); // by its disk's USB transport
    expect(by["/mnt/nas"].network).toBe(true);
  });
});

describe("existing choices skip the question", () => {
  const dirs = () => mkdtempSync(path.join(os.tmpdir(), "nbs-dd-"));
  const never = async () => { throw new Error("must not ask"); };
  it("keeps an existing data-dir pointer and does not ask", async () => {
    const state = dirs();
    writeFileSync(path.join(state, "data-dir"), "D:\\Kept\\data\n");
    writeFileSync(path.join(state, "models-dir"), "D:\\Kept\\ollama\n");
    const ex = readExisting(state, "linux");
    expect(ex).toEqual({ dataDir: "D:\\Kept\\data", modelsDir: "D:\\Kept\\ollama" });
    const r = await decide({ layout: winLayout(), volumes: winVolumes(), existing: ex, hasInstall: false, interactive: true, ask: never, confirm: never, required: 5 * GB });
    expect(r).toMatchObject({ action: "keep", dataDir: "D:\\Kept\\data", modelsDir: "D:\\Kept\\ollama" });
    // even an unattended request does not move data that already has a home
    const r2 = await decide({ layout: winLayout(), volumes: winVolumes(), existing: ex, hasInstall: true, requested: "D:\\Other", yes: true, required: 5 * GB });
    expect(r2.action).toBe("keep");
  });
  it("keeps an install that is already there (no pointer: the default folder is in use)", async () => {
    const r = await decide({ layout: winLayout(), volumes: winVolumes(), existing: { dataDir: null, modelsDir: null }, hasInstall: true, interactive: true, ask: never, required: 5 * GB });
    expect(r.action).toBe("keep");
    const root = dirs();
    mkdirSync(path.join(root, "data"));
    expect(installExists({ programDir: path.join(root, "app"), defaultData: path.join(root, "data"), platform: "linux" })).toBe(false);
    writeFileSync(path.join(root, "data", "x"), "1");
    expect(installExists({ programDir: path.join(root, "app"), defaultData: path.join(root, "data"), platform: "linux" })).toBe(true);
  });
  it("reads the older .txt pointer too", () => {
    const state = dirs();
    writeFileSync(path.join(state, "data-dir.txt"), "E:\\Old\n");
    expect(readExisting(state, "linux").dataDir).toBe("E:\\Old");
  });
});

describe("asking", () => {
  const fresh = { existing: { dataDir: null, modelsDir: null }, hasInstall: false, required: 5 * GB };
  const script = (answers) => { const a = [...answers]; const said = []; return { said, ask: async () => (a.length ? a.shift() : null), confirm: async () => (a.length ? /^y/i.test(a.shift()) : false), say: (l) => said.push(l) }; };
  it("one Enter accepts the suggestion", async () => {
    const io = script([""]);
    const r = await decide({ ...fresh, layout: winLayout(), volumes: winVolumes(), interactive: true, ...io });
    expect(r).toMatchObject({ action: "chosen", dataDir: "D:\\Nothing BOT Server\\data", modelsDir: "D:\\Nothing BOT Server\\ollama" });
    const shown = io.said.join("\n");
    expect(shown).toContain("Where should Nothing BOT keep its data and AI models?");
    expect(shown).toMatch(/D:.*1\.8 TB free.*suggested/);
    expect(shown).toMatch(/Not offered: .*E:.*removable/);
    expect(shown).toMatch(/needs about|It needs about 5\.0 GB/);
  });
  it("takes a number, and the system drive means the default layout", async () => {
    const r = await decide({ ...fresh, layout: winLayout(), volumes: winVolumes(), interactive: true, ...script(["2"]) });
    expect(r).toMatchObject({ action: "default", dataDir: "C:\\NothingBotServer\\data" });
  });
  it("explains a refused path and asks again", async () => {
    const io = script(["E:\\nbs", "D:\\OneDrive\\x", "D:\\Mine"]);
    const r = await decide({ ...fresh, layout: winLayout(), volumes: winVolumes(), interactive: true, ...io });
    expect(r.dataDir).toBe("D:\\Mine\\data");
    expect(io.said.filter((l) => /^  That folder is on|^  OneDrive keeps/.test(l))).toHaveLength(2);
  });
  it("warns below the needed space and goes ahead only after a yes", async () => {
    const v = winVolumes(); v[1].free = 3 * GB; v[0].free = 2 * GB;
    const no = script(["", "n", "2", "n", "1", "y"]);
    // 1) D: 3 GB -> no; 2) C: 2 GB -> no; 1 again -> yes
    const r = await decide({ ...fresh, layout: winLayout(), volumes: v, interactive: true, ...no });
    expect(r.dataDir).toBe("D:\\Nothing BOT Server\\data");
    expect(no.said.join("\n")).toMatch(/Only 3\.0 GB is free there, and it needs about 5\.0 GB/);
  });
  it("without anyone to ask: the default; with --yes the suggestion", async () => {
    const quiet = await decide({ ...fresh, layout: winLayout(), volumes: winVolumes(), interactive: false });
    expect(quiet).toMatchObject({ action: "default", dataDir: "C:\\NothingBotServer\\data" });
    const yes = await decide({ ...fresh, layout: winLayout(), volumes: winVolumes(), interactive: false, yes: true });
    expect(yes).toMatchObject({ action: "chosen", dataDir: "D:\\Nothing BOT Server\\data" });
  });
  it("unattended path: used if good, refused if bad or too small", async () => {
    const ok = await decide({ ...fresh, layout: winLayout(), volumes: winVolumes(), requested: "D:\\Bot" });
    expect(ok).toMatchObject({ action: "chosen", dataDir: "D:\\Bot\\data" });
    expect((await decide({ ...fresh, layout: winLayout(), volumes: winVolumes(), requested: "D:\\OneDrive\\Bot" })).action).toBe("error");
    expect((await decide({ ...fresh, layout: winLayout(), volumes: winVolumes(), requested: "C:\\NothingBotServer\\app\\x", yes: true })).action).toBe("error");
    const v = winVolumes(); v[1].free = 1 * GB;
    expect((await decide({ ...fresh, layout: winLayout(), volumes: v, requested: "D:\\Bot" })).error).toMatch(/Not enough room/);
    expect((await decide({ ...fresh, layout: winLayout(), volumes: v, requested: "D:\\Bot", yes: true })).action).toBe("chosen");
  });
});

describe("writing the choice", () => {
  it("writes the pointer files move.mjs reads, into the state folder", () => {
    const state = mkdtempSync(path.join(os.tmpdir(), "nbs-dd-")), base = mkdtempSync(path.join(os.tmpdir(), "nbs-dd-"));
    const choice = { dataDir: path.join(base, "data"), modelsDir: path.join(base, "ollama") };
    applyChoice(choice, { stateDir: state, platform: "linux" });
    expect(readPointer(state, "data-dir")).toBe(choice.dataDir);
    expect(readPointer(state, "models-dir")).toBe(choice.modelsDir);
    expect(existsSync(choice.dataDir) && existsSync(choice.modelsDir)).toBe(true);
    const state2 = mkdtempSync(path.join(os.tmpdir(), "nbs-dd-"));
    applyChoice(choice, { stateDir: state2, platform: "linux", writeModels: false });
    expect(readPointer(state2, "models-dir")).toBeNull();
  });
  it("end to end through the command line (unattended, --yes, a fake disk list)", async () => {
    const state = mkdtempSync(path.join(os.tmpdir(), "nbs-dd-")), disk = mkdtempSync(path.join(os.tmpdir(), "nbs-dd-")), out = path.join(state, "r.json");
    const vols = path.join(state, "v.json");
    writeFileSync(vols, JSON.stringify([
      { mount: "/", device: "/dev/a", fsType: "ext4", free: 10 * GB, total: 100 * GB, system: true, removable: false, network: false },
      { mount: disk, device: "/dev/b", fsType: "ext4", free: 500 * GB, total: 900 * GB, system: false, removable: false, network: false },
    ]));
    const args = ["choose", "--platform", "linux", "--state-dir", state, "--program-root", "/opt/nbs-test", "--volumes-json", vols, "--out", out, "--no-ask", "--yes"];
    expect(await main(args, {})).toBe(0);
    const r = JSON.parse(readFileSync(out, "utf8"));
    expect(r).toMatchObject({ action: "chosen", dataDir: path.join(disk, "nothing-bot-server", "data"), nonDefault: true });
    expect(readPointer(state, "data-dir")).toBe(r.dataDir);
    // a second run keeps it and changes nothing
    expect(await main(args, {})).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ action: "keep", dataDir: r.dataDir });
    // a bad unattended path fails with exit 2 and writes no pointer
    const state2 = mkdtempSync(path.join(os.tmpdir(), "nbs-dd-"));
    expect(await main(["choose", "--platform", "linux", "--state-dir", state2, "--program-root", "/opt/nbs-test", "--volumes-json", vols, "--out", out, "--no-ask", "--data-dir", "/home/me/Dropbox/x"], {})).toBe(2);
    expect(readPointer(state2, "data-dir")).toBeNull();
  });
});

describe("the installers use it", () => {
  it("ships it and every installer calls it", () => {
    expect(text("deploy", "build-dist.sh")).toContain("datadir.mjs");
    for (const f of [["deploy", "install.sh"], ["deploy", "windows", "install.ps1"], ["deploy", "mac", "nbsctl"]]) expect(text(...f)).toContain("datadir.mjs");
    expect(text("deploy", "windows", "install.ps1")).toMatch(/NBS_DATA_DIR/);
    expect(text("deploy", "windows", "install.ps1")).toMatch(/-DataDir/);
    expect(text("deploy", "install.sh")).toContain("NBS_DATA_DIR");
    expect(text("deploy", "install.sh")).toContain("--yes");
  });
});
