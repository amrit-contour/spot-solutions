import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { freshModelsDir, ollamaEnv, scanModelsDir, wrongFolder, winRestartOllamaScript, winStartOllamaScript, createOllamaGuard } from "./ollamaenv.mjs";
import { commands } from "./control.mjs";

const makeModels = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "nbs-models-"));
  mkdirSync(path.join(d, "manifests", "registry.ollama.ai", "library", "gemma3"), { recursive: true });
  writeFileSync(path.join(d, "manifests", "registry.ollama.ai", "library", "gemma3", "4b"), "{}");
  mkdirSync(path.join(d, "blobs"));
  writeFileSync(path.join(d, "blobs", "sha256-abc"), "x".repeat(1000));
  return d;
};

describe("freshModelsDir", () => {
  const read = (map) => (_dir, name) => map[name] ?? null;
  it("reads the pointer, not the inherited environment", () => {
    expect(freshModelsDir({ stateDir: "S", defaultModels: "C:\\r\\ollama", env: { OLLAMA_MODELS: "C:\\stale" }, platform: "win32", read: read({ "models-dir": "D:\\m" }) })).toBe("D:\\m");
  });
  it("accepts the .txt pointer", () => {
    expect(freshModelsDir({ stateDir: "S", defaultModels: "x", platform: "win32", read: read({ "models-dir.txt": "D:\\t" }) })).toBe("D:\\t");
  });
  it("on Windows with no pointer uses the install's own folder, never a stale variable", () => {
    expect(freshModelsDir({ stateDir: "S", defaultModels: "C:\\r\\ollama", env: { OLLAMA_MODELS: "C:\\stale" }, platform: "win32", read: read({}) })).toBe("C:\\r\\ollama");
  });
  it("elsewhere falls back to the variable, then the default", () => {
    expect(freshModelsDir({ stateDir: "S", defaultModels: "/d", env: { OLLAMA_MODELS: "/v" }, platform: "linux", read: read({}) })).toBe("/v");
    expect(freshModelsDir({ stateDir: "S", defaultModels: "/d", env: {}, platform: "linux", read: read({}) })).toBe("/d");
  });
});

describe("scanModelsDir and wrongFolder", () => {
  it("counts manifests and blob bytes", () => {
    const d = makeModels();
    expect(scanModelsDir(d)).toEqual({ manifests: 1, blobBytes: 1000 });
    rmSync(d, { recursive: true });
  });
  it("is empty for a missing folder", () => {
    expect(scanModelsDir("/nonexistent/nbs")).toEqual({ manifests: 0, blobBytes: 0 });
    expect(scanModelsDir(null)).toEqual({ manifests: 0, blobBytes: 0 });
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
  it("ollamaEnv", () => expect(ollamaEnv("D:\\m")).toEqual({ OLLAMA_MODELS: "D:\\m", OLLAMA_KEEP_ALIVE: "24h" }));
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
