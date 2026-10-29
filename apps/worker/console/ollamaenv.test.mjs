import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveModelsDir, keepAlive, ollamaEnv, scanModelsDir, wrongFolder, winRestartOllamaScript, winStartOllamaScript, createOllamaGuard } from "./ollamaenv.mjs";
import { commands } from "./control.mjs";

const REPO = path.join(import.meta.dirname, "..", "..", "..");

const makeModels = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "nbs-models-"));
  mkdirSync(path.join(d, "manifests", "registry.ollama.ai", "library", "gemma3"), { recursive: true });
  writeFileSync(path.join(d, "manifests", "registry.ollama.ai", "library", "gemma3", "4b"), "{}");
  mkdirSync(path.join(d, "blobs"));
  writeFileSync(path.join(d, "blobs", "sha256-abc"), "x".repeat(1000));
  return d;
};

/** A fake file system: files is { path: bytes }; every parent folder exists. `p` is path.win32 or path.posix. */
function fakeFs(files, p) {
  const dirs = new Set(), all = new Map(Object.entries(files));
  for (const f of all.keys()) for (let d = p.dirname(f); !dirs.has(d); d = p.dirname(d)) { dirs.add(d); if (p.dirname(d) === d) break; }
  const kids = (d) => [...new Set([...all.keys(), ...dirs].filter((x) => x !== d && p.dirname(x) === d).map((x) => p.basename(x)))];
  return {
    readdir: (d) => { if (!dirs.has(d)) throw new Error("ENOENT"); return kids(d); },
    stat: (x) => { if (dirs.has(x)) return { isDirectory: () => true, size: 0 }; if (all.has(x)) return { isDirectory: () => false, size: all.get(x) }; throw new Error("ENOENT"); },
  };
}
/** A models folder inside a fake file system: one gemma3:4b manifest and one blob. */
const modelsIn = (root, p = path.posix) => ({ [p.join(root, "manifests", "registry.ollama.ai", "library", "gemma3", "4b")]: 10, [p.join(root, "blobs", "sha256-abc")]: 1000 });

describe("resolveModelsDir", () => {
  const W = path.win32, P = path.posix;
  const base = (over = {}) => {
    const pointer = { ...(over.pointer ?? {}) }, wrote = [], logs = [];
    return {
      args: { stateDir: "S", defaultModels: over.defaultModels ?? "/install/ollama", platform: "linux", home: "/home/me", env: {},
        read: (_d, n) => pointer[n] ?? null, write: (_d, n, v) => { wrote.push([n, v]); pointer[n] = v; }, log: (m) => logs.push(m),
        fs: fakeFs(over.files ?? {}, over.p ?? P), envVar: () => null, ...over.args },
      wrote, logs,
    };
  };

  it("a pointer with models wins, and nothing is rewritten", () => {
    const { args, wrote } = base({ pointer: { "models-dir": "/data/m" }, files: { ...modelsIn("/data/m"), ...modelsIn("/home/me/.ollama/models") } });
    expect(resolveModelsDir(args)).toEqual({ dir: "/data/m", source: "pointer", models: 1 });
    expect(wrote).toEqual([]);
  });
  it("an empty pointer folder while the user's .ollama folder has models: picks that folder and repoints", () => {
    const { args, wrote, logs } = base({ pointer: { "models-dir": "/empty" }, files: { "/empty/blobs/.keep": 0, ...modelsIn("/home/me/.ollama/models") } });
    expect(resolveModelsDir(args)).toEqual({ dir: "/home/me/.ollama/models", source: "ollama-default", models: 1 });
    expect(wrote).toEqual([["models-dir", "/home/me/.ollama/models"]]);
    expect(logs).toEqual(["[models] found 1 model in /home/me/.ollama/models (ollama-default); pointer updated"]);
    expect(resolveModelsDir(args).source).toBe("pointer"); // from now on the pointer is right: nothing more to write
    expect(wrote).toHaveLength(1);
  });
  it("no pointer at all: finds the models and writes the pointer", () => {
    const { args, wrote } = base({ files: modelsIn("/install/ollama") });
    expect(resolveModelsDir(args)).toEqual({ dir: "/install/ollama", source: "install-default", models: 1 });
    expect(wrote).toEqual([["models-dir", "/install/ollama"]]);
  });
  it("nothing anywhere: the planned folder, and no pointer is written", () => {
    const none = base({});
    expect(resolveModelsDir(none.args)).toEqual({ dir: "/install/ollama", source: "install-default", models: 0 });
    const withPtr = base({ pointer: { "models-dir.txt": "/planned" } });
    expect(resolveModelsDir(withPtr.args)).toEqual({ dir: "/planned", source: "pointer", models: 0 });
    expect(none.wrote.concat(withPtr.wrote)).toEqual([]);
  });
  it("a manifest without a blobs folder, or blobs without a manifest, is not a models folder", () => {
    const { args } = base({ files: { "/install/ollama/manifests/registry.ollama.ai/library/x/y": 1, "/home/me/.ollama/models/blobs/sha256-a": 5 } });
    expect(resolveModelsDir(args).models).toBe(0);
  });
  it("linux: Ollama's service folder is found, then the user's own", () => {
    const svc = base({ files: { ...modelsIn("/usr/share/ollama/.ollama/models"), ...modelsIn("/home/me/.ollama/models") } });
    expect(resolveModelsDir(svc.args).dir).toBe("/usr/share/ollama/.ollama/models");
    const own = base({ files: modelsIn("/home/me/.ollama/models") });
    expect(resolveModelsDir(own.args).dir).toBe("/home/me/.ollama/models");
  });
  it("linux: OLLAMA_MODELS in the environment counts, before the install default", () => {
    const { args } = base({ args: { env: { OLLAMA_MODELS: "/mnt/x/m" } }, files: { ...modelsIn("/mnt/x/m"), ...modelsIn("/install/ollama") } });
    expect(resolveModelsDir(args)).toMatchObject({ dir: "/mnt/x/m", source: "env" });
  });
  it("mac: ~/.ollama/models", () => {
    const { args, wrote } = base({ args: { platform: "darwin", home: "/Users/me" }, files: modelsIn("/Users/me/.ollama/models") });
    expect(resolveModelsDir(args)).toEqual({ dir: "/Users/me/.ollama/models", source: "ollama-default", models: 1 });
    expect(wrote).toEqual([["models-dir", "/Users/me/.ollama/models"]]);
  });
  it("windows: machine then user OLLAMA_MODELS (read fresh), then the install folder, then the profile's .ollama", () => {
    const w = (files, envVar = () => null, extra = {}) => base({ p: W, defaultModels: W.join("R", "ollama"), files, args: { platform: "win32", home: "H\\me", env: {}, envVar, ...extra } }).args;
    const ev = (m, u) => (scope) => (scope === "Machine" ? m : u);
    expect(resolveModelsDir(w({ ...modelsIn("M", W), ...modelsIn("U", W) }, ev("M", "U")))).toMatchObject({ dir: "M", source: "machine-env" });
    expect(resolveModelsDir(w(modelsIn("U", W), ev(null, "U")))).toMatchObject({ dir: "U", source: "user-env" });
    expect(resolveModelsDir(w(modelsIn("R\\ollama", W)))).toMatchObject({ dir: "R\\ollama", source: "install-default" });
    expect(resolveModelsDir(w(modelsIn("H\\me\\.ollama\\models", W)))).toMatchObject({ dir: "H\\me\\.ollama\\models", source: "ollama-default" });
  });
  it("windows: the service account's own profile is not the only place; other user profiles are looked in (any drive, from SystemDrive)", () => {
    const files = modelsIn("X:\\Users\\kim\\.ollama\\models", W);
    const { args, wrote } = base({ p: W, files, defaultModels: "R\\ollama", args: { platform: "win32", home: "X:\\Windows\\system32\\config\\systemprofile", env: { SystemDrive: "X:" } } });
    expect(resolveModelsDir(args)).toMatchObject({ dir: "X:\\Users\\kim\\.ollama\\models", source: "ollama-default" });
    expect(wrote).toEqual([["models-dir", "X:\\Users\\kim\\.ollama\\models"]]);
  });
  it("de-duplicates candidates (the same folder with a different case or trailing slash is scanned once)", () => {
    let scans = 0;
    const fs = fakeFs({}, W), readdir = fs.readdir;
    const { args } = base({ p: W, defaultModels: "D:\\M\\", pointer: { "models-dir": "d:\\m" }, args: { platform: "win32", home: "H", env: {} } });
    args.fs = { ...fs, readdir: (d) => { if (/manifests/.test(d)) scans++; return readdir(d); } };
    resolveModelsDir(args);
    expect(scans).toBe(1 + 1); // pointer, plus Ollama's own folder; the install default is the same folder as the pointer
  });
  it("nothing in the source assumes a drive letter", () => {
    const drive = /(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/;
    expect(readFileSync(path.join(import.meta.dirname, "ollamaenv.mjs"), "utf8")).not.toMatch(drive);
    for (const f of ["install.ps1", "update-core.ps1"]) {
      const t = readFileSync(path.join(REPO, "deploy", "windows", f), "utf8");
      const fn = t.slice(t.indexOf("function Has-Models"), t.indexOf("\n}\n", t.indexOf("function Models-Dir")));
      expect(fn.length).toBeGreaterThan(300);
      expect(fn).not.toMatch(drive);
    }
  });
  it("the PowerShell copies of the lookup are the same text in the installer and the updater", () => {
    const get = (f) => { const t = readFileSync(path.join(REPO, "deploy", "windows", f), "utf8"); return t.slice(t.indexOf("function Has-Models"), t.indexOf("\n}\n", t.indexOf("function Models-Dir"))); };
    expect(get("update-core.ps1")).toBe(get("install.ps1"));
  });
});

describe("Ollama's keep-alive follows NBS_OLLAMA_KEEP_ALIVE (default 5m, like the worker)", () => {
  it("defaults to 5m, accepts the worker's forms, rejects junk", () => {
    expect(keepAlive(undefined)).toBe("5m");
    for (const v of ["30s", "0", "-1", "2h", "1.5m"]) expect(keepAlive(v)).toBe(v);
    expect(keepAlive("forever")).toBe("5m");
  });
  it("is the same decision as the worker's ollamaKeepAlive", () => {
    const ts = readFileSync(path.join(REPO, "apps", "worker", "src", "aiRouting.ts"), "utf8");
    expect(ts).toContain(String.raw`/^(-1|0|\d+(\.\d+)?(ms|s|m|h))$/.test(v) ? v : "5m"`);
  });
});

describe("scanModelsDir and wrongFolder", () => {
  it("counts manifests and blob bytes", () => {
    const d = makeModels();
    expect(scanModelsDir(d)).toEqual({ manifests: 1, blobBytes: 1000, hasBlobs: true });
    rmSync(d, { recursive: true });
  });
  it("is empty for a missing folder", () => {
    expect(scanModelsDir("/nonexistent/nbs")).toEqual({ manifests: 0, blobBytes: 0, hasBlobs: false });
    expect(scanModelsDir(null)).toEqual({ manifests: 0, blobBytes: 0, hasBlobs: false });
  });
  it("flags only: up, zero models, files on disk", () => {
    const s = { manifests: 1, blobBytes: 10 };
    expect(wrongFolder({ up: true, modelCount: 0, scan: s })).toBe("wrong-folder");
    expect(wrongFolder({ up: true, modelCount: 1, scan: s })).toBe(null);
    expect(wrongFolder({ up: false, modelCount: 0, scan: s })).toBe(null);
    expect(wrongFolder({ up: true, modelCount: 0, scan: { manifests: 0, blobBytes: 0 } })).toBe(null);
  });
});

describe("Windows scripts", () => {
  it("set OLLAMA_MODELS explicitly and stop the tray app on restart", () => {
    const s = winRestartOllamaScript({ exe: "C:\\it's\\ollama.exe", dir: "D:\\Nothing BOT Server\\ollama-models" });
    expect(s).toContain("'ollama app'");
    expect(s).toContain("$env:OLLAMA_MODELS='D:\\Nothing BOT Server\\ollama-models'");
    expect(s).toContain("'C:\\it''s\\ollama.exe'");
    expect(s.indexOf("Stop-Process")).toBeLessThan(s.indexOf("$env:OLLAMA_MODELS"));
  });
  it("a model-only Start from worker control carries the folder too", () => {
    const s = commands("win32").startModel("ollama.exe", "D:\\m'x")[1].at(-1);
    expect(s).toContain("$env:OLLAMA_MODELS='D:\\m''x'");
    expect(commands("win32").startModel("ollama.exe")[1].at(-1)).not.toContain("OLLAMA_MODELS");
  });
  it("ollamaEnv", () => {
    expect(ollamaEnv("D:\\m", {})).toEqual({ OLLAMA_MODELS: "D:\\m", OLLAMA_KEEP_ALIVE: "5m" });
    expect(ollamaEnv("D:\\m", { NBS_OLLAMA_KEEP_ALIVE: "30s" }).OLLAMA_KEEP_ALIVE).toBe("30s");
  });
  it("start script alone doesn't stop anything", () => expect(winStartOllamaScript({ exe: "o", dir: "d" })).not.toContain("Stop-Process"));
});

describe("createOllamaGuard", () => {
  const mk = (over = {}) => {
    const calls = [];
    let t = 1_000_000;
    const g = createOllamaGuard({
      info: async () => ({ up: true, models: [] }),
      dir: () => "D:\\m",
      scan: () => ({ manifests: 2, blobBytes: 5 }),
      restart: async (d) => { calls.push(d); },
      now: () => t,
      cooldownMs: 300_000,
      ...over,
    });
    return { g, calls, tick: (ms) => { t += ms; } };
  };
  it("restarts Ollama on the pointer folder when it lists no models but the folder has them", async () => {
    const { g, calls } = mk();
    const r = await g.check();
    expect(calls).toEqual(["D:\\m"]);
    expect(r.problem).toBe("wrong-folder");
    expect(r.fixedAt).not.toBeNull();
  });
  it("does not loop: once per cooldown, again after it", async () => {
    const { g, calls, tick } = mk();
    await g.check(); await g.check();
    expect(calls.length).toBe(1);
    tick(301_000);
    await g.check();
    expect(calls.length).toBe(2);
  });
  it("leaves a healthy Ollama alone", async () => {
    const { g, calls } = mk({ info: async () => ({ up: true, models: [{ name: "gemma3:4b" }] }) });
    expect((await g.check()).problem).toBe(null);
    expect(calls).toEqual([]);
  });
  it("does nothing when Ollama is down, stopped by the owner, or the folder is really empty", async () => {
    for (const over of [{ info: async () => ({ up: false, models: [] }) }, { enabled: () => false }, { scan: () => ({ manifests: 0, blobBytes: 0 }) }]) {
      const { g, calls } = mk(over);
      expect((await g.check()).problem).toBe(null);
      expect(calls).toEqual([]);
    }
  });
  it("a failing restart doesn't throw", async () => {
    const { g } = mk({ restart: async () => { throw new Error("nope"); } });
    expect((await g.check()).problem).toBe("wrong-folder");
  });
});

describe("finding ollama.exe on Windows", () => {
  it("looks before it stops anything, and refuses plainly when it's missing", () => {
    const s = winRestartOllamaScript({ exe: "ollama", dir: "D:\\m", root: "X:\\NBS" });
    expect(s.indexOf("Test-Path")).toBeLessThan(s.indexOf("Stop-Process"));
    expect(s.indexOf("isn't installed")).toBeLessThan(s.indexOf("Stop-Process"));
    expect(s).toContain("'X:\\NBS\\ollama-app\\ollama.exe'");
    expect(s).toContain("$env:SystemDrive\\Users\\*\\AppData\\Local\\Programs\\Ollama\\ollama.exe");
    expect(s).toContain("Start-Process -FilePath $exe");
    expect(s).not.toContain("-FilePath 'ollama'");
  });
  it("checks Ollama actually answers after starting", () => {
    expect(winStartOllamaScript({ exe: "C:\\o.exe", dir: "d" })).toContain("11434/api/version");
  });
});
