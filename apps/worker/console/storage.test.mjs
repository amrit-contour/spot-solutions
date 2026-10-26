import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync, lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MARKER, copyTree, fingerprint, isCacheOnly, waitQuiet, fmtGb, inspectTarget, isInside, judgeFs, makeFolder, measure, pathKey, removeTree, replacePaths, rewriteEnvPaths, summariseData, toFsPath, validatePath, verifyTree } from "./storage.mjs";
import { browserPidsOn, planMove, readyCounts, runCleanup, runMove, waitHealthy } from "./move.mjs";

const tmp = () => realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "spot-store-")));
const write = (file, text = "x") => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };

describe("path validation (Windows)", () => {
  const opts = { platform: "win32", current: "C:\\SpotSolutions\\data", forbidden: [{ path: "C:\\SpotSolutions\\app", label: "the program folder" }] };
  const v = (p, o = {}) => validatePath(p, { ...opts, ...o });
  it("accepts an absolute folder on another drive and cleans it", () => {
    expect(v("D:\\SpotSolutions\\data")).toEqual({ ok: true, path: "D:\\SpotSolutions\\data" });
    expect(v('  "d:/SpotSolutions/data/"  ').path).toBe("d:\\SpotSolutions\\data");
  });
  it("refuses what isn't a local absolute folder", () => {
    expect(v("").ok).toBe(false);
    expect(v("data").error).toMatch(/drive letter/);
    expect(v("\\\\nas\\share\\x").error).toMatch(/network/);
    expect(v("\\\\?\\D:\\x").ok).toBe(false);
    expect(v("D:\\").error).toMatch(/not the whole drive/);
    expect(v("D:\\a\\..\\..\\Windows").error).toMatch(/\.\./);
  });
  it("refuses names Windows or our scripts can't hold", () => {
    expect(v("D:\\a\\CON").ok).toBe(false);
    expect(v("D:\\a\\b.\\c").ok).toBe(false);
    expect(v("D:\\a\\it's").ok).toBe(false);
    expect(v("D:\\a\\b?c").ok).toBe(false);
    expect(v("D:\\R&D").ok).toBe(false);
    expect(v("D:\\" + "x".repeat(210)).error).toMatch(/too long/);
    expect(v("C:\\Windows\\Spot").error).toMatch(/system folder/);
  });
  it("refuses the current folder, inside it, around it, and inside the app folder (any casing)", () => {
    expect(v("c:\\spotsolutions\\DATA").error).toMatch(/already/);
    expect(v("C:\\SpotSolutions\\data\\more").error).toMatch(/inside the current/);
    expect(v("C:\\").ok).toBe(false);
    expect(v("C:\\SpotSolutions").error).toMatch(/contain the current/);
    expect(v("C:\\SpotSolutions\\APP\\apps\\x").error).toMatch(/program folder/);
    expect(v("C:\\SpotSolutionsX\\data").ok).toBe(true); // a sibling with a similar name is fine
  });
});

describe("path validation (macOS and Linux)", () => {
  it("wants a full path outside system folders", () => {
    const lin = { platform: "linux", current: "/var/lib/spot-solutions", forbidden: [{ path: "/opt/spot-solutions", label: "app" }] };
    expect(validatePath("/mnt/disk/spot", lin)).toEqual({ ok: true, path: "/mnt/disk/spot" });
    expect(validatePath("mnt/disk", lin).error).toMatch(/starting with \//);
    expect(validatePath("~/spot", lin).ok).toBe(false);
    expect(validatePath("/", lin).ok).toBe(false);
    expect(validatePath("/etc/spot", lin).error).toMatch(/system folder/);
    expect(validatePath("/opt/spot-solutions/data", lin).ok).toBe(false);
    expect(validatePath("/var/lib/spot-solutions/x", lin).error).toMatch(/inside the current/);
    expect(validatePath('/mnt/a"b', lin).ok).toBe(false);
    expect(validatePath("/mnt/a%h", lin).ok).toBe(false);
    const mac = { platform: "darwin", current: "/Users/a/Library/Application Support/SpotSolutions/data" };
    expect(validatePath("/Volumes/HDD/SpotSolutions/data", mac).ok).toBe(true);
    expect(validatePath("/System/x", mac).ok).toBe(false);
    expect(validatePath("/users/A/library/application support/spotsolutions/DATA", mac).error).toMatch(/already/);
  });
  it("compares paths the way the file system does", () => {
    expect(isInside("/a/b/c", "/a/b", "linux")).toBe(true);
    expect(isInside("/a/bc", "/a/b", "linux")).toBe(false);
    expect(isInside("C:\\A\\B", "c:\\a", "win32")).toBe(true);
    expect(pathKey("C:\\A\\B\\", "win32")).toBe("c:\\a\\b");
  });
  it("judges file systems and prefixes long Windows paths", () => {
    expect(judgeFs("FAT32", "win32").error).toBeTruthy();
    expect(judgeFs("NTFS", "win32")).toEqual({});
    expect(judgeFs("exFAT", "win32").warning).toBeTruthy();
    expect(judgeFs("ntfs-3g", "linux")).toEqual({});
    expect(judgeFs("vfat", "linux").error).toBeTruthy();
    expect(judgeFs("exfat", "darwin").error).toBeTruthy();
    expect(toFsPath("D:\\short", "win32")).toBe("D:\\short");
    expect(toFsPath("D:\\" + "a".repeat(250), "win32").startsWith("\\\\?\\D:\\")).toBe(true);
    expect(fmtGb(2.5e9)).toBe("2.5 GB");
  });
});

describe("rewriting config", () => {
  it("moves whole path prefixes only, keeps line endings", () => {
    const env = "FIREBASE_SERVICE_ACCOUNT=C:\\SpotSolutions\\data\\service-account.json\r\nWWEBJS_DATA=C:\\SpotSolutions\\data\\wwebjs\r\nOTHER=C:\\SpotSolutions\\data2\\x\r\nGEMINI_API_KEY=C:\\SpotSolutions\\data\r\n";
    const out = rewriteEnvPaths(env, [["C:\\SpotSolutions\\data", "D:\\Spot\\data"]], "win32");
    expect(out).toBe("FIREBASE_SERVICE_ACCOUNT=D:\\Spot\\data\\service-account.json\r\nWWEBJS_DATA=D:\\Spot\\data\\wwebjs\r\nOTHER=C:\\SpotSolutions\\data2\\x\r\nGEMINI_API_KEY=D:\\Spot\\data\r\n");
  });
  it("rewrites launcher scripts, case-insensitively on Windows, case-sensitively on Linux", () => {
    expect(replacePaths("Set-Location 'c:\\spotsolutions\\DATA\\worker.log'", "C:\\SpotSolutions\\data", "E:\\d", "win32")).toBe("Set-Location 'E:\\d\\worker.log'");
    expect(replacePaths("/a/Data /a/data", "/a/data", "/b", "linux")).toBe("/a/Data /b");
    expect(replacePaths("same", "/x", "/x", "linux")).toBe("same");
  });
});

// A data folder shaped like a real one.
function makeData(root) {
  write(path.join(root, "service-account.json"), '{"type":"service_account"}');
  write(path.join(root, "console-token"), "tok");
  write(path.join(root, "console.json"), '{"autoUpdate":true}');
  write(path.join(root, "worker.log"), "line\n".repeat(50));
  write(path.join(root, "live-stats.json"), "{}");
  write(path.join(root, "wwebjs", "server.json"), '{"id":"s"}');
  write(path.join(root, "wwebjs", "session-u1", "Default", "Cookies"), "c".repeat(5000));
  write(path.join(root, "wwebjs", "session-u1", "Default", "deep", "a", "b", "f.bin"), "z".repeat(300));
  write(path.join(root, "wwebjs", "session-u1", "SingletonLock"), "skip me");
  write(path.join(root, "wwebjs", "backup-u1", "Default", "Cookies"), "c".repeat(4000));
}

describe("scan, copy, verify, remove", () => {
  it("sorts the data folder into what the owner knows", async () => {
    const d = tmp(); makeData(d);
    const s = await summariseData(d);
    const by = Object.fromEntries(s.entries.map((e) => [e.key, e]));
    expect(by.sessions.bytes).toBeGreaterThan(5000);
    expect(by.backups.bytes).toBe(4000);
    expect(by.logs.bytes).toBe(250);
    expect(by.stats.files).toBeGreaterThanOrEqual(3);
    expect(s.bytes).toBe(s.entries.reduce((a, e) => a + e.bytes, 0));
  });
  it("copies without browser locks or symlink following, and verifies", async () => {
    const a = tmp(), b = path.join(tmp(), "new");
    makeData(a);
    const outside = tmp(); write(path.join(outside, "secret.txt"), "do not copy");
    symlinkSync(outside, path.join(a, "wwebjs", "link-out"));
    const seen = [];
    const r = await copyTree(a, b, { onProgress: (p) => seen.push(p) });
    expect(r.files).toBeGreaterThan(8);
    expect(existsSync(path.join(b, "wwebjs", "session-u1", "Default", "Cookies"))).toBe(true);
    expect(existsSync(path.join(b, "wwebjs", "session-u1", "SingletonLock"))).toBe(false);
    expect(lstatSync(path.join(b, "wwebjs", "link-out")).isSymbolicLink()).toBe(true); // recreated as a link
    expect(existsSync(path.join(b, "wwebjs", "link-out", "secret.txt"))).toBe(true); // still points at the same place
    expect(seen.length).toBeGreaterThan(0);
    expect((await verifyTree(a, b)).ok).toBe(true);
    expect((await measure(b)).bytes).toBe((await measure(a)).bytes);
  });
  it("notices a missing file, a short file, a missing WhatsApp folder and a changed key", async () => {
    const a = tmp(), b = path.join(tmp(), "new");
    makeData(a);
    await copyTree(a, b);
    writeFileSync(path.join(b, "wwebjs", "session-u1", "Default", "Cookies"), "short");
    let v = await verifyTree(a, b);
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toMatch(/size differs/);
    const c = path.join(tmp(), "c");
    await copyTree(a, c);
    const { rmSync } = await import("node:fs");
    rmSync(path.join(c, "wwebjs", "backup-u1"), { recursive: true });
    v = await verifyTree(a, c);
    expect(v.problems.join()).toMatch(/backup-u1/);
    const d = path.join(tmp(), "d");
    await copyTree(a, d);
    writeFileSync(path.join(d, "console-token"), "TOK");
    expect((await verifyTree(a, d)).problems.join()).toMatch(/console-token/);
  });
  it("ignores files that change during a move", async () => {
    const a = tmp(), b = path.join(tmp(), "new");
    makeData(a);
    await copyTree(a, b);
    writeFileSync(path.join(a, "console.log"), "grew while copying");
    writeFileSync(path.join(a, "update.json"), "{}");
    expect((await verifyTree(a, b)).ok).toBe(true);
  });
  it("deletes a tree but never follows a link out of it", async () => {
    const d = tmp(), outside = tmp();
    write(path.join(outside, "keep.txt"), "keep");
    makeData(d);
    symlinkSync(outside, path.join(d, "wwebjs", "escape"));
    symlinkSync(path.join(outside, "keep.txt"), path.join(d, "filelink"));
    await removeTree(d);
    expect(readdirSync(d)).toEqual([]);
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
    await expect(removeTree(path.join(outside, "keep.txt"))).rejects.toThrow(/folder/);
    const l = path.join(tmp(), "l"); symlinkSync(outside, l);
    await expect(removeTree(l)).rejects.toThrow(/symlink/);
    await expect(removeTree(path.parse(d).root)).rejects.toThrow(/root/);
    expect(existsSync(path.join(outside, "keep.txt"))).toBe(true);
  });
});

describe("inspecting a real folder", () => {
  const base = { platform: "linux", current: "/nowhere/current", forbidden: [] };
  it("accepts a new folder, reports room, leaves nothing behind", async () => {
    const parent = tmp(), t = path.join(parent, "SpotSolutions", "data");
    const r = await inspectTarget(t, base);
    expect(r.ok).toBe(true);
    expect(r.free).toBeGreaterThan(0);
    expect(existsSync(path.join(parent, "SpotSolutions"))).toBe(false);
    expect(readdirSync(parent)).toEqual([]);
  });
  it("refuses a folder that isn't empty, a file, a symlink, too little room", async () => {
    const d = tmp(); write(path.join(d, "x.txt"));
    expect((await inspectTarget(d, base)).error).toMatch(/isn't empty/);
    expect((await inspectTarget(path.join(d, "x.txt"), base)).error).toMatch(/file|isn't a folder/i);
    const link = path.join(tmp(), "link"); symlinkSync(tmp(), link);
    expect((await inspectTarget(link, base)).error).toMatch(/shortcut/);
    expect((await inspectTarget(path.join(tmp(), "n"), { ...base, needBytes: 1e18 })).error).toMatch(/Not enough room/);
  });
  it("sees through a symlink into the program folder", async () => {
    const app = tmp(), parent = tmp();
    symlinkSync(app, path.join(parent, "sneaky"));
    const r = await inspectTarget(path.join(parent, "sneaky", "data"), { ...base, forbidden: [{ path: fsReal(app), label: "the program folder" }] });
    expect(r.ok).toBe(false);
    expect((await inspectTarget(path.join(parent, "sneaky", "data"), { ...base, strictLinks: true })).error).toMatch(/shortcut/);
  });
});
const fsReal = (p) => realpathSync.native(p);

describe("making a folder that doesn't exist yet", () => {
  const base = { platform: "linux", current: "/nowhere/current", forbidden: [] };
  it("creates every missing level, and is fine if it is already there", () => {
    const t = path.join(tmp(), "a", "b", "data");
    expect(makeFolder(t, { platform: "linux" })).toBe(t);
    expect(lstatSync(t).isDirectory()).toBe(true);
    expect(() => makeFolder(t, { platform: "linux" })).not.toThrow();
  });
  it("says why when it can't, in plain words", () => {
    const d = tmp(); write(path.join(d, "taken"));
    expect(() => makeFolder(path.join(d, "taken", "data"), { platform: "linux" })).toThrow(/Couldn't create .*A file is already called that/);
    const fail = (code) => () => makeFolder("/x/y", { platform: "linux", mkdir: () => { throw Object.assign(new Error(code), { code }); } });
    expect(fail("EACCES")).toThrow(/isn't allowed to make a folder there/);
    expect(fail("EROFS")).toThrow(/read-only/);
    expect(fail("ENOSPC")).toThrow(/full/);
    expect(fail("EINVAL")).toThrow(/isn't a folder name/);
    expect(() => makeFolder("relative/path", { platform: "linux" })).toThrow(/full path/);
  });
  it("check accepts a path whose folders don't exist yet and creates nothing", async () => {
    const parent = tmp(), t = path.join(parent, "one", "two", "three");
    const r = await inspectTarget(t, base);
    expect(r).toMatchObject({ ok: true, existed: false });
    expect(readdirSync(parent)).toEqual([]);
  });
  it("check refuses a path with a file in the way, before anything is stopped", async () => {
    const d = tmp(); write(path.join(d, "taken"));
    expect((await inspectTarget(path.join(d, "taken", "data"), base)).error).toMatch(/Part of that path is a file/);
  });
});


describe("browser caches", () => {
  const withCaches = (root) => {
    makeData(root);
    const s = path.join(root, "wwebjs", "session-u1");
    write(path.join(s, "Default", "Cache", "Cache_Data", "f_000001"), "c".repeat(900));
    write(path.join(s, "Default", "Code Cache", "js", "idx"), "j".repeat(100));
    write(path.join(s, "Default", "GPUCache", "data_0"), "g");
    write(path.join(s, "Default", "Service Worker", "CacheStorage", "x", "y"), "s".repeat(50));
    write(path.join(s, "Default", "Service Worker", "Database", "000003.log"), "keep");
    write(path.join(s, "ShaderCache", "a"), "a");
    write(path.join(s, "Crashpad", "reports", "r"), "r");
    write(path.join(s, "Default", "Local Storage", "leveldb", "000005.ldb"), "login".repeat(30));
    write(path.join(s, "Default", "IndexedDB", "https_web.whatsapp.com_0.indexeddb.leveldb", "000003.log"), "idb");
  };
  it("knows which paths are only cache", () => {
    for (const p of ["wwebjs/session-u1/Default/Cache", "wwebjs/session-u1/Default/Code Cache/js/x", "wwebjs/session-u1/GrShaderCache/a", "wwebjs/session-u1/Crashpad/r", "wwebjs/session-u1/Default/Service Worker/CacheStorage/z", "wwebjs/session-u1/Default/Service Worker/ScriptCache"]) expect(isCacheOnly(p), p).toBe(true);
    for (const p of ["wwebjs/session-u1/Default/Local Storage/leveldb/1.ldb", "wwebjs/session-u1/Default/IndexedDB/a", "wwebjs/session-u1/Default/Cookies", "wwebjs/session-u1/Default/Preferences", "wwebjs/session-u1/Default/Service Worker/Database/1", "wwebjs/server.json", "Cache", "ollama-models/Cache/x", "wwebjs/Cache"]) expect(isCacheOnly(p), p).toBe(false);
  });
  it("doesn't copy or measure them, and keeps everything that holds the login", async () => {
    const a = tmp(), b = path.join(tmp(), "new");
    withCaches(a);
    await copyTree(a, b);
    const s = path.join(b, "wwebjs", "session-u1");
    for (const gone of [["Default", "Cache"], ["Default", "Code Cache"], ["Default", "GPUCache"], ["Default", "Service Worker", "CacheStorage"], ["ShaderCache"], ["Crashpad"]]) expect(existsSync(path.join(s, ...gone)), gone.join("/")).toBe(false);
    for (const kept of [["Default", "Cookies"], ["Default", "Local Storage", "leveldb", "000005.ldb"], ["Default", "IndexedDB", "https_web.whatsapp.com_0.indexeddb.leveldb", "000003.log"], ["Default", "Service Worker", "Database", "000003.log"]]) expect(existsSync(path.join(s, ...kept)), kept.join("/")).toBe(true);
    expect((await measure(b)).bytes).toBe((await measure(a)).bytes);
    expect((await measure(a, { dropCaches: false })).bytes).toBeGreaterThan((await measure(a)).bytes);
  });
  it("a cache that grows or differs never fails a move, but a login file still does", async () => {
    const a = tmp(), b = path.join(tmp(), "new");
    withCaches(a);
    await copyTree(a, b);
    const s = path.join(a, "wwebjs", "session-u1");
    writeFileSync(path.join(s, "Default", "Cache", "Cache_Data", "f_000001"), "grew while copying".repeat(100));
    write(path.join(s, "Default", "Cache", "Cache_Data", "f_000002"), "new");
    write(path.join(b, "wwebjs", "session-u1", "Default", "GPUCache", "other"), "z");
    expect((await verifyTree(a, b)).ok).toBe(true);
    writeFileSync(path.join(a, "wwebjs", "session-u1", "Default", "Local Storage", "leveldb", "000005.ldb"), "login".repeat(31));
    const v = await verifyTree(a, b);
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toMatch(/size differs: wwebjs\/session-u1\/Default\/Local Storage/);
  });
});

describe("waiting for the data folder to go quiet", () => {
  it("sees a file that is still being written, and ignores caches and volatile files", async () => {
    const a = tmp(); makeData(a);
    const before = await fingerprint(a);
    write(path.join(a, "wwebjs", "session-u1", "Default", "Cache", "f"), "x");
    write(path.join(a, "console.log"), "more");
    expect(await fingerprint(a)).toEqual(before);
    write(path.join(a, "wwebjs", "session-u1", "Default", "Cookies"), "c".repeat(5100));
    expect(await fingerprint(a)).not.toEqual(before);
  });
  it("is quiet when nothing changes, and gives up while something keeps writing", async () => {
    const a = tmp(); makeData(a);
    expect((await waitQuiet(a, { gapMs: 1, wait: async () => {} })).ok).toBe(true);
    let n = 0, t = 0;
    const wait = async () => { write(path.join(a, "wwebjs", "session-u1", "Default", "Cookies"), "c".repeat(6000 + ++n)); t += 10_000; };
    expect((await waitQuiet(a, { gapMs: 1, timeoutMs: 25_000, wait, now: () => t })).ok).toBe(false);
  });
});

describe("finding the browsers to stop (macOS and Linux)", () => {
  const ps = [
    "  100     1 /usr/bin/node worker",
    "  200   100 /opt/chrome/chrome --user-data-dir=/data/wwebjs/session-u1 --no-sandbox",
    "  201   200 /opt/chrome/chrome --type=renderer --no-sandbox",
    "  202   201 /opt/chrome/chrome --type=utility",
    "  300     1 /opt/chrome/chrome --user-data-dir=/other/place",
    "  400     1 /usr/bin/vim /data/notes.txt",
  ].join("\n");
  it("takes the browser for this folder and its helpers, nothing else", () => {
    expect(browserPidsOn(ps, "/data").sort()).toEqual([200, 201, 202]);
    expect(browserPidsOn(ps, "/nowhere")).toEqual([]);
  });
});

// ---------- the orchestrator, with fake services ----------
function rig({ failAt = null, healthy = true, models = false, quietOk = true, drift = false } = {}) {
  let fp = 0;
  const root = tmp();
  const stateDir = path.join(root, "state"), old = path.join(root, "old-data"), target = path.join(root, "drive", "new-data");
  mkdirSync(stateDir, { recursive: true }); mkdirSync(path.join(root, "drive"), { recursive: true });
  makeData(old);
  const modelsOld = path.join(root, "ollama");
  if (models) { write(path.join(modelsOld, "blobs", "sha256-1"), "m".repeat(9000)); write(path.join(modelsOld, "manifests", "x"), "man"); }
  const ctx = { platform: "linux", stateDir, stateFile: path.join(stateDir, "move.json"), current: old, currentModels: models ? modelsOld : path.join(old, "ollama-models-x"), forbidden: [], envFile: path.join(root, ".env"), root };
  const calls = [];
  const trip = (name) => { if (failAt === name) throw new Error(`${name} blew up`); };
  const ops = {
    stop: async (o) => { calls.push(["stop", !!o.models]); trip("stop"); },
    prepare: async () => { calls.push(["prepare"]); trip("prepare"); },
    persist: async (o) => { calls.push(["persist", o.from, o.to]); if (o.to === target) trip("persist"); },
    start: async (o) => { calls.push(["start", o.target]); if (o.target === target) trip("start"); },
  };
  const io = {
    measure: async (d) => measure(d),
    inspect: async (t, o) => { trip("inspect"); return inspectTarget(t, { platform: "linux", current: old, forbidden: [], ...o }); },
    copy: async (a, b, o) => { trip("copy"); return copyTree(a, b, o); },
    quiet: async () => (quietOk ? { ok: true } : { ok: false }),
    fingerprint: async (d) => (drift ? { files: ++fp, bytes: 0, newest: 0 } : fingerprint(d)),
    verify: async (a, b, o) => { const v = await verifyTree(a, b, o); if (failAt === "verify") return { ok: false, problems: ["size differs: x"] }; return v; },
    syncSmall: async () => {},
    health: async () => (healthy ? { ok: true } : { ok: false, error: "Checked for 6 minutes: WhatsApp asked for a QR scan." }),
    readyNow: () => ({ ready: 1 }),
    remove: async (d) => { await removeTree(d); },
    removeOld: async (d) => { await removeTree(d); },
  };
  const steps = [];
  return { ctx, ops, io, calls, old, target, steps, report: (o) => steps.push(o.step), modelsOld };
}

describe("moving the data", () => {
  it("plans where models go", () => {
    const m = { platform: "linux", current: "/var/lib/spot-solutions", currentModels: "/usr/share/ollama/.ollama/models" };
    expect(planMove(m, { target: "/mnt/d/spot", models: false }).models).toBeNull();
    expect(planMove(m, { target: "/mnt/d/spot", models: true }).models).toEqual({ old: "/usr/share/ollama/.ollama/models", new: "/mnt/d/spot/ollama-models", separate: true });
    const inside = { ...m, currentModels: "/var/lib/spot-solutions/ollama-models" };
    expect(planMove(inside, { target: "/mnt/d/spot", models: false }).models).toEqual({ old: "/var/lib/spot-solutions/ollama-models", new: "/mnt/d/spot/ollama-models", separate: false });
  });

  it("copies, verifies, switches, restarts, checks WhatsApp, and waits for the delete", async () => {
    const r = rig();
    const res = await runMove({ ...r, request: { target: r.target } });
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(r.calls.map((c) => c[0])).toEqual(["stop", "prepare", "persist", "start"]);
    expect(r.calls[2].slice(1)).toEqual([r.old, r.target]);
    expect(existsSync(path.join(r.target, "wwebjs", "backup-u1", "Default", "Cookies"))).toBe(true);
    expect(existsSync(path.join(r.old, "wwebjs"))).toBe(true); // the old copy is untouched
    const st = JSON.parse(readFileSync(r.ctx.stateFile, "utf8"));
    expect(st).toMatchObject({ phase: "awaiting-cleanup", verified: true, old: r.old, target: r.target });
    expect(r.steps).toContain("Waiting for WhatsApp to come back");
  });

  it("won't copy while something is still writing, and says so plainly", async () => {
    const r = rig({ quietOk: false });
    const res = await runMove({ ...r, request: { target: r.target } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/WhatsApp is still closing; try again in a minute/);
    expect(res.error).toMatch(/back on the old folder/);
    expect(r.calls.map((c) => c[0])).toEqual(["stop", "start"]);
    expect(existsSync(r.target) ? readdirSync(r.target) : []).toEqual([]);
  });
  it("calls it still closing when the original changed during the copy", async () => {
    const r = rig({ drift: true });
    const res = await runMove({ ...r, request: { target: r.target } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/still closing/);
    expect(JSON.parse(readFileSync(r.ctx.stateFile, "utf8")).phase).toBe("failed");
    expect(existsSync(path.join(r.old, "wwebjs", "session-u1"))).toBe(true);
  });

  for (const failAt of ["inspect", "stop", "prepare", "copy", "verify", "persist", "start"]) {
    it(`rolls back when it fails at ${failAt}`, async () => {
      const r = rig({ failAt });
      const res = await runMove({ ...r, request: { target: r.target } });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/back on the old folder/);
      expect(JSON.parse(readFileSync(r.ctx.stateFile, "utf8")).phase).toBe("failed");
      expect(existsSync(path.join(r.old, "wwebjs", "session-u1"))).toBe(true);
      expect(existsSync(r.target) ? readdirSync(r.target) : []).toEqual([]); // the half-made copy is gone
      if (["persist", "start"].includes(failAt)) expect(r.calls.some((c) => c[0] === "persist" && c[2] === r.old)).toBe(failAt === "start");
      if (failAt !== "inspect") expect(r.calls.at(-1)).toEqual(["start", r.old]);
    });
  }

  it("rolls back when WhatsApp doesn't come back", async () => {
    const r = rig({ healthy: false });
    const res = await runMove({ ...r, request: { target: r.target } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/QR scan/);
    expect(r.calls.filter((c) => c[0] === "persist").map((c) => c[2])).toEqual([r.target, r.old]);
    expect(r.calls.at(-1)).toEqual(["start", r.old]);
  });

  it("refuses a target that already holds files, and never deletes it", async () => {
    const r = rig();
    write(path.join(r.target, "precious.txt"), "mine");
    const res = await runMove({ ...r, request: { target: r.target } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/isn't empty/);
    expect(readFileSync(path.join(r.target, "precious.txt"), "utf8")).toBe("mine");
    expect(r.calls).toEqual([]);
  });

  it("moves the models too, into the new folder", async () => {
    const r = rig({ models: true });
    const res = await runMove({ ...r, request: { target: r.target, models: true } });
    expect(res.ok).toBe(true);
    expect(readFileSync(path.join(r.target, "ollama-models", "blobs", "sha256-1"), "utf8")).toHaveLength(9000);
    expect(r.calls[0]).toEqual(["stop", true]);
    expect(JSON.parse(readFileSync(r.ctx.stateFile, "utf8"))).toMatchObject({ moveModels: true, modelsOld: r.modelsOld, modelsNew: path.join(r.target, "ollama-models") });
  });

  it("deletes the old copy only after a verified move, and only that folder", async () => {
    const r = rig({ models: true });
    const noMove = await runCleanup({ ctx: r.ctx, io: r.io });
    expect(noMove.ok).toBe(false);
    await runMove({ ...r, request: { target: r.target, models: true } });
    // the data is not yet running from the new folder: nothing is deleted
    expect((await runCleanup({ ctx: r.ctx, io: r.io })).error).toMatch(/isn't running from the new folder/);
    expect(existsSync(r.old)).toBe(true);
    const after = { ...r.ctx, current: r.target };
    const bystander = tmp(); write(path.join(bystander, "keep"), "k");
    const res = await runCleanup({ ctx: after, io: r.io });
    expect(res.ok).toBe(true);
    expect(existsSync(r.old) ? readdirSync(r.old) : []).toEqual([]);
    expect(existsSync(r.modelsOld) ? readdirSync(r.modelsOld) : []).toEqual([]);
    expect(existsSync(path.join(r.target, "wwebjs", "session-u1"))).toBe(true);
    expect(existsSync(path.join(bystander, "keep"))).toBe(true);
    expect(JSON.parse(readFileSync(r.ctx.stateFile, "utf8")).phase).toBe("done");
    expect((await runCleanup({ ctx: after, io: r.io })).ok).toBe(false); // can't run twice
  });

  it("refuses to delete when the recorded folders overlap or the copy marker is gone", async () => {
    const r = rig();
    await runMove({ ...r, request: { target: r.target } });
    const { rmSync } = await import("node:fs");
    rmSync(path.join(r.target, MARKER));
    expect((await runCleanup({ ctx: { ...r.ctx, current: r.target }, io: r.io })).error).toMatch(/isn't the copy/);
    expect(existsSync(r.old)).toBe(true);
    writeFileSync(r.ctx.stateFile, JSON.stringify({ phase: "awaiting-cleanup", verified: true, old: r.target, target: path.join(r.target, "inner") }));
    expect((await runCleanup({ ctx: { ...r.ctx, current: path.join(r.target, "inner") }, io: r.io })).ok).toBe(false);
  });
});

describe("waiting for WhatsApp", () => {
  const stats = (o = {}) => ({ writtenAt: 1000, accounts: [{ status: "ready" }, { status: "ready" }], ...o });
  it("counts accounts", () => {
    expect(readyCounts(stats({ accounts: [{ status: "ready" }, { status: "qr" }] }))).toMatchObject({ accounts: 2, ready: 1, qr: 1, writtenAt: 1000 });
    expect(readyCounts(null)).toMatchObject({ accounts: 0, ready: 0 });
  });
  it("succeeds once the worker reports again with everyone back and nobody on a QR", async () => {
    let t = 0;
    const seq = [null, stats({ writtenAt: 500 }), stats({ accounts: [{ status: "ready" }, { status: "starting" }] }), stats()];
    const r = await waitHealthy({ file: "x", since: 900, expectReady: 2, read: () => seq.shift() ?? stats(), wait: async () => { t += 3000; }, now: () => t });
    expect(r.ok).toBe(true);
  });
  it("fails on a QR scan, or silence, after the deadline, and says why", async () => {
    let t = 0;
    const qr = await waitHealthy({ file: "x", since: 900, expectReady: 2, timeoutMs: 9000, read: () => stats({ accounts: [{ status: "ready" }, { status: "qr" }] }), wait: async () => { t += 3000; }, now: () => t });
    expect(qr.ok).toBe(false);
    expect(qr.error).toMatch(/QR/);
    t = 0;
    const silent = await waitHealthy({ file: "x", since: 900, expectReady: 1, timeoutMs: 9000, read: () => null, wait: async () => { t += 3000; }, now: () => t });
    expect(silent.error).toMatch(/never started reporting/);
  });
});
