// The server's own default model (NBS_LOCAL_MODEL): fixed when it isn't installed, Undo, and no flip-flop.
import { describe, expect, it } from "vitest";
import { createAi, fmtKeep, fmtSwitch, parseKeep, parseSwitch } from "./ai.mjs";

function rig({ env = {}, installed = ["gemma3:4b"], up = true, seen = [], pull = null } = {}) {
  const e = { ...env };
  const restarts = [];
  let have = installed;
  const fetchImpl = async (url) => {
    if (!up) throw new Error("down");
    if (String(url).endsWith("/api/pull")) return new Promise(() => {}); // a download that never ends
    if (String(url).endsWith("/api/tags")) return { json: async () => ({ models: have.map((name) => ({ name, size: 1 })) }) };
    return { json: async () => ({ models: [] }) };
  };
  const ai = createAi({
    readEnv: () => e,
    writeEnv: (p) => Object.assign(e, p),
    restartWorker: async () => { restarts.push({ ...e }); },
    ollamaUrl: "http://x",
    ollamaInfo: async () => ({ up, models: have.map((name) => ({ name, size: 1 })) }),
    noLocalModel: () => false,
    missingSeen: () => seen,
    now: () => 1000,
    fetchImpl,
  });
  return { ai, env: e, restarts, install: (n) => (have = [...have, n]) };
}

describe("env bookkeeping", () => {
  it("round-trips", () => {
    expect(parseSwitch(fmtSwitch("gemma4:e4b", "gemma3:4b", 5))).toEqual({ from: "gemma4:e4b", to: "gemma3:4b", at: 5 });
    expect(parseKeep(fmtKeep("gemma4:e4b", 7))).toEqual({ model: "gemma4:e4b", at: 7 });
    expect(parseSwitch("")).toBeNull();
    expect(parseKeep(undefined)).toBeNull();
  });
});

describe("the server default isn't installed", () => {
  it("rewrites NBS_LOCAL_MODEL to the installed pick, records it, and restarts the worker", async () => {
    const r = rig({ env: { NBS_LOCAL_MODEL: "gemma4:e4b" } });
    expect(await r.ai.reconcileDefault()).toEqual({ from: "gemma4:e4b", to: "gemma3:4b" });
    expect(r.env.NBS_LOCAL_MODEL).toBe("gemma3:4b");
    expect(parseSwitch(r.env.NBS_LOCAL_MODEL_AUTOSWITCHED)).toEqual({ from: "gemma4:e4b", to: "gemma3:4b", at: 1000 });
    expect(r.restarts).toHaveLength(1);
    expect(await r.ai.reconcileDefault()).toBeNull(); // settled: nothing more to do
    expect(r.restarts).toHaveLength(1);
  });
  it("treats the built-in default as the default too", async () => {
    const r = rig({ env: {}, installed: ["qwen3:4b"] });
    expect(await r.ai.reconcileDefault()).toEqual({ from: "gemma3:4b", to: "qwen3:4b" });
  });
  it("leaves it alone when Ollama is down, lists nothing, has the model, or has no replacement", async () => {
    for (const o of [{ up: false }, { installed: [] }, { installed: ["gemma4:e4b"] }]) {
      const r = rig({ env: { NBS_LOCAL_MODEL: "gemma4:e4b" }, ...o });
      expect(await r.ai.reconcileDefault()).toBeNull();
      expect(r.env.NBS_LOCAL_MODEL).toBe("gemma4:e4b");
      expect(r.restarts).toHaveLength(0);
    }
  });
  it("waits while the model is being downloaded", async () => {
    const r = rig({ env: { NBS_LOCAL_MODEL: "gemma4:e4b" } });
    await r.ai.startPull("gemma4:e4b");
    expect(await r.ai.reconcileDefault()).toBeNull();
  });
});

describe("Undo and no flip-flop", () => {
  it("Undo restores the model and keeps it, and the tick doesn't switch it again", async () => {
    const r = rig({ env: { NBS_LOCAL_MODEL: "gemma4:e4b" } });
    await r.ai.reconcileDefault();
    const v = await r.ai.view();
    expect(v.autoSwitched).toMatchObject({ from: "gemma4:e4b", to: "gemma3:4b" });
    expect(await r.ai.undoSwitch()).toEqual({ model: "gemma4:e4b", kept: true });
    expect(r.env.NBS_LOCAL_MODEL).toBe("gemma4:e4b");
    expect(r.env.NBS_LOCAL_MODEL_AUTOSWITCHED).toBe("");
    expect(parseKeep(r.env.NBS_LOCAL_MODEL_KEEP)?.model).toBe("gemma4:e4b");
    const restarts = r.restarts.length;
    expect(await r.ai.reconcileDefault()).toBeNull();
    expect(await r.ai.reconcileDefault()).toBeNull();
    expect(r.env.NBS_LOCAL_MODEL).toBe("gemma4:e4b");
    expect(r.restarts).toHaveLength(restarts);
    const after = await r.ai.view();
    expect(after.keepMissing?.model).toBe("gemma4:e4b");
    expect(after.autoSwitched).toBeNull();
    expect(after.missing).toEqual([{ model: "gemma4:e4b", kind: "default", to: "gemma3:4b", kept: true }]);
  });
  it("the keep is forgotten once the model is installed, then a later removal is handled normally", async () => {
    const r = rig({ env: { NBS_LOCAL_MODEL: "gemma4:e4b", NBS_LOCAL_MODEL_KEEP: fmtKeep("gemma4:e4b", 1) } });
    r.install("gemma4:e4b");
    await r.ai.reconcileDefault();
    expect(r.env.NBS_LOCAL_MODEL_KEEP).toBe("");
  });
  it("the keep is forgotten when another model is picked", async () => {
    const r = rig({ env: { NBS_LOCAL_MODEL: "gemma3:4b", NBS_LOCAL_MODEL_KEEP: fmtKeep("gemma4:e4b", 1) } });
    await r.ai.reconcileDefault();
    expect(r.env.NBS_LOCAL_MODEL_KEEP).toBe("");
  });
  it("Undo when the old model is installed again keeps nothing", async () => {
    const r = rig({ env: { NBS_LOCAL_MODEL: "gemma3:4b", NBS_LOCAL_MODEL_AUTOSWITCHED: fmtSwitch("gemma4:e4b", "gemma3:4b", 1) }, installed: ["gemma3:4b", "gemma4:e4b"] });
    expect(await r.ai.undoSwitch()).toEqual({ model: "gemma4:e4b", kept: false });
    expect(r.env.NBS_LOCAL_MODEL_KEEP).toBe("");
  });
  it("nothing to undo is an error", async () => {
    await expect(rig().ai.undoSwitch()).rejects.toThrow(/Nothing to undo/);
  });
  it("picking a model that isn't installed on purpose records a keep; picking an installed one clears it and the switch note", async () => {
    const r = rig({ env: { NBS_LOCAL_MODEL: "gemma3:4b", NBS_LOCAL_MODEL_AUTOSWITCHED: fmtSwitch("x:1", "gemma3:4b", 1) } });
    await r.ai.setDefaults({ localModel: "gemma4:e4b" });
    expect(parseKeep(r.env.NBS_LOCAL_MODEL_KEEP)?.model).toBe("gemma4:e4b");
    expect(r.env.NBS_LOCAL_MODEL_AUTOSWITCHED).toBe("");
    await r.ai.setDefaults({ localModel: "gemma3:4b" });
    expect(r.env.NBS_LOCAL_MODEL_KEEP).toBe("");
  });
  it("saving other defaults doesn't touch the switch note", async () => {
    const note = fmtSwitch("x:1", "gemma3:4b", 1);
    const r = rig({ env: { NBS_LOCAL_MODEL: "gemma3:4b", NBS_LOCAL_MODEL_AUTOSWITCHED: note } });
    await r.ai.setDefaults({ mode: "local_first", localModel: "gemma3:4b" });
    expect(r.env.NBS_LOCAL_MODEL_AUTOSWITCHED).toBe(note);
  });
});

describe("/api/ai flags missing models", () => {
  it("lists the default and the models accounts were routed to, never installed ones", async () => {
    const r = rig({ env: { NBS_LOCAL_MODEL: "gemma3:4b" }, seen: [{ model: "qwen3:8b", to: "gemma3:4b", at: 1 }, { model: "gemma3:4b", to: null, at: 1 }] });
    const v = await r.ai.view();
    expect(v.missing).toEqual([{ model: "qwen3:8b", kind: "account", to: "gemma3:4b", kept: false }]);
  });
  it("flags nothing while Ollama is down or lists nothing", async () => {
    expect((await rig({ up: false, env: { NBS_LOCAL_MODEL: "x:1" } }).ai.view()).missing).toEqual([]);
    expect((await rig({ installed: [], env: { NBS_LOCAL_MODEL: "x:1" } }).ai.view()).missing).toEqual([]);
  });
});
