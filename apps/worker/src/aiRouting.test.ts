import { describe, expect, it } from "vitest";
import { revertAutoSwitch, type AiSettings } from "@spot/shared";
import { IMPLICIT_GEMINI_MODEL, autoSwitchUpdate, canAutoSwitch, isKept, keepMissingSpent, missingModelNoticeId, missingModelText, ollamaKeepAlive, pickInstalledModel, planRoutes, planRoutesDetailed, switchDecision } from "./aiRouting.ts";
// @ts-expect-error the console is plain .mjs
import * as consoleAi from "../console/ai.mjs";

const local = { provider: "ollama", model: "gemma3:4b" } as const;
const cloud = { provider: "gemini", model: "gemini-2.5-flash-lite" } as const;

describe("ollamaKeepAlive", () => {
  it("defaults to 5m so an idle model unloads, and takes a valid override", () => {
    expect(ollamaKeepAlive(undefined)).toBe("5m");
    expect(ollamaKeepAlive("")).toBe("5m");
    expect(ollamaKeepAlive("30m")).toBe("30m");
    expect(ollamaKeepAlive("24h")).toBe("24h");
    expect(ollamaKeepAlive("-1")).toBe("-1");
    expect(ollamaKeepAlive("forever; rm -rf")).toBe("5m");
  });
});

describe("planRoutes", () => {
  it("local_only never includes Gemini, even as primary or fallback, even with a key", () => {
    expect(planRoutes({ primary: cloud, fallback: local, policy: "local_only" }, true)).toEqual([local]);
    expect(planRoutes({ primary: local, fallback: cloud, policy: "local_only" }, true)).toEqual([local]);
    expect(planRoutes({ primary: cloud, fallback: null, policy: "local_only" }, true)).toEqual([]);
  });
  it("local_first keeps primary then fallback", () => {
    expect(planRoutes({ primary: local, fallback: cloud, policy: "local_first" }, true)).toEqual([local, cloud]);
    expect(planRoutes({ primary: cloud, fallback: local, policy: "local_first" }, false)).toEqual([cloud, local]);
  });
  it("a missing policy means local_first", () => {
    expect(planRoutes({ primary: local, fallback: null }, false)).toEqual([local]);
    expect(planRoutes({ primary: local, fallback: null }, true)).toEqual([local, { provider: "gemini", model: IMPLICIT_GEMINI_MODEL }]);
  });
  it("local_first adds Gemini only when a key exists and Gemini isn't already configured", () => {
    expect(planRoutes({ primary: local, fallback: null, policy: "local_first" }, false)).toEqual([local]);
    expect(planRoutes({ primary: local, fallback: cloud, policy: "local_first" }, true)).toEqual([local, cloud]);
  });
});

describe("pickInstalledModel", () => {
  it("keeps an installed model, treating a bare name as :latest", () => {
    expect(pickInstalledModel("gemma3:4b", ["gemma3:4b", "qwen3:4b"])).toBe("gemma3:4b");
    expect(pickInstalledModel("llama3", ["llama3:latest"])).toBe("llama3:latest");
  });
  it("prefers the same family, then the preferred models, then any", () => {
    expect(pickInstalledModel("gemma4:e4b", ["qwen3:4b", "gemma4:e2b", "gemma3:4b"])).toBe("gemma4:e2b");
    expect(pickInstalledModel("gemma3n:e4b", ["qwen3:4b", "gemma3:4b"])).toBe("gemma3:4b");
    expect(pickInstalledModel("gemma4:e4b", ["qwen3:4b", "llama3.2:3b"], ["llama3.2:3b"])).toBe("llama3.2:3b");
    expect(pickInstalledModel("gemma4:e4b", ["qwen3:4b", "llama3.2:3b"], ["gemma3:4b"])).toBe("llama3.2:3b");
    expect(pickInstalledModel("gemma4:e4b", [])).toBeNull();
  });
});

describe("planRoutes with installed models", () => {
  const missing = { provider: "ollama", model: "gemma4:e4b" } as const;
  it("swaps a missing local model for an installed one and reports it", () => {
    const r = planRoutesDetailed({ primary: missing, fallback: cloud }, false, ["gemma3:4b"]);
    expect(r.routes).toEqual([local, cloud]);
    expect(r.substitutions).toEqual([{ from: "gemma4:e4b", to: "gemma3:4b" }]);
  });
  it("uses the account's other installed local model before any other", () => {
    expect(planRoutes({ primary: missing, fallback: { provider: "ollama", model: "qwen3:4b" } }, false, ["gemma3:4b", "qwen3:4b"])).toEqual([{ provider: "ollama", model: "qwen3:4b" }]);
  });
  it("with nothing installed the local route is skipped, falling to Gemini", () => {
    expect(planRoutes({ primary: missing, fallback: cloud }, false, [])).toEqual([cloud]);
    expect(planRoutes({ primary: missing, fallback: null }, true, [])).toEqual([{ provider: "gemini", model: IMPLICIT_GEMINI_MODEL }]);
  });
  it("local_only still never uses Gemini, even with nothing installed", () => {
    expect(planRoutes({ primary: missing, fallback: cloud, policy: "local_only" }, true, [])).toEqual([]);
    expect(planRoutes({ primary: missing, fallback: cloud, policy: "local_only" }, true, ["gemma3:4b"])).toEqual([local]);
  });
  it("unknown installed list (Ollama down) leaves routes alone", () => {
    expect(planRoutes({ primary: missing, fallback: cloud }, false, null)).toEqual([missing, cloud]);
    expect(planRoutes({ primary: missing, fallback: cloud }, false)).toEqual([missing, cloud]);
  });
});

describe("auto-switch write guard", () => {
  it("only when Ollama is up, the list is non-empty and lacks the model", () => {
    expect(canAutoSwitch(["gemma3:4b"], "gemma4:e4b", "gemma3:4b")).toBe(true);
    expect(canAutoSwitch(null, "gemma4:e4b", "gemma3:4b")).toBe(false); // Ollama down
    expect(canAutoSwitch([], "gemma4:e4b", "gemma3:4b")).toBe(false); // wrong folder / nothing listed
    expect(canAutoSwitch(["gemma3:4b"], "gemma3:4b", "gemma3:4b")).toBe(false); // not missing
    expect(canAutoSwitch(["gemma3:4b"], "gemma4:e4b", null)).toBe(false);
  });
  it("writes only the routes that held the missing model, and records the switch", () => {
    const meta = { server: "Dev-HP", at: 5 };
    expect(autoSwitchUpdate({ primary: { provider: "ollama", model: "gemma4:e4b" }, fallback: cloud }, "gemma4:e4b", "gemma3:4b", meta)).toEqual({
      "settings.ai.primary.model": "gemma3:4b",
      "settings.ai.autoSwitched": { from: "gemma4:e4b", to: "gemma3:4b", at: 5, server: "Dev-HP" },
    });
    expect(autoSwitchUpdate({ primary: local, fallback: cloud }, "gemma4:e4b", "gemma3:4b", meta)).toBeNull();
    expect(autoSwitchUpdate(undefined, "gemma4:e4b", "gemma3:4b", meta)).toBeNull(); // came from the server default
  });
  it("tells the curator what happened, naming the server", () => {
    expect(missingModelText("Dev-HP", "gemma4:e4b", "gemma3:4b", { gemini: false, localOnly: false, saved: true })).toBe("gemma4:e4b isn't installed on Dev-HP, so your model is now gemma3:4b. Change it in Settings → AI.");
  });
});

describe("keepMissing: no flip-flop", () => {
  const meta = { server: "Dev-HP", at: 5 };
  const installed = ["gemma3:4b"];
  const ai = (extra: Partial<AiSettings> = {}): AiSettings => ({ primary: { provider: "ollama", model: "gemma4:e4b" }, fallback: cloud, ...extra });

  it("the guard refuses a model the curator keeps", () => {
    expect(canAutoSwitch(installed, "gemma4:e4b", "gemma3:4b", { model: "gemma4:e4b" })).toBe(false);
    expect(canAutoSwitch(installed, "gemma4:e4b", "gemma3:4b", { model: "gemma4" })).toBe(true); // gemma4 is gemma4:latest, a different model from gemma4:e4b
    expect(canAutoSwitch(installed, "gemma4:e4b", "gemma3:4b", { model: "qwen3:4b" })).toBe(true); // keeping another model doesn't block this one
    expect(isKept("gemma4:e4b", { model: "gemma4:e4b" })).toBe(true);
    expect(isKept("gemma4:e4b", undefined, "gemma4:e4b")).toBe(true); // the server owner's keep
    expect(isKept("gemma4:e4b", undefined, null)).toBe(false);
  });
  it("switchDecision saves the switch normally, and only substitutes when kept", () => {
    const d = switchDecision(ai(), installed, "gemma4:e4b", "gemma3:4b", meta);
    expect(d.kept).toBe(false);
    expect(d.update).toMatchObject({ "settings.ai.primary.model": "gemma3:4b" });
    const k = switchDecision(ai({ keepMissing: { model: "gemma4:e4b", at: 9 } }), installed, "gemma4:e4b", "gemma3:4b", meta);
    expect(k).toEqual({ update: null, kept: true });
    expect(switchDecision(ai(), installed, "gemma4:e4b", "gemma3:4b", meta, "gemma4:e4b")).toEqual({ update: null, kept: true });
    expect(switchDecision(ai(), [], "gemma4:e4b", "gemma3:4b", meta).update).toBeNull(); // empty list is never proof
  });
  it("switch, Undo, then the worker sees the model again: it does not switch a second time", () => {
    // 1. the worker saves the switch
    const first = switchDecision(ai(), installed, "gemma4:e4b", "gemma3:4b", meta);
    let cur: AiSettings = { ...ai(), primary: { provider: "ollama", model: "gemma3:4b" }, autoSwitched: { from: "gemma4:e4b", to: "gemma3:4b", at: 5, server: "Dev-HP" } };
    expect(first.update).toBeTruthy();
    // 2. the curator presses Undo (the model is still missing)
    const undo = revertAutoSwitch(cur, { keepMissing: true, now: 10 })!;
    expect(undo.set).toEqual({ "primary.model": "gemma4:e4b", keepMissing: { model: "gemma4:e4b", at: 10 } });
    expect(undo.remove).toEqual(["autoSwitched"]);
    cur = { ...cur, primary: { provider: "ollama", model: "gemma4:e4b" }, keepMissing: { model: "gemma4:e4b", at: 10 } };
    delete cur.autoSwitched;
    // 3. the next message: substituted at run time, nothing saved
    expect(planRoutes(cur, false, installed)[0]).toEqual({ provider: "ollama", model: "gemma3:4b" });
    expect(switchDecision(cur, installed, "gemma4:e4b", "gemma3:4b", meta)).toEqual({ update: null, kept: true });
  });
  it("keepMissing is spent when the model gets installed or is no longer routed", () => {
    const kept = ai({ keepMissing: { model: "gemma4:e4b", at: 1 } });
    expect(keepMissingSpent(kept, installed)).toBe(false); // still missing, still routed
    expect(keepMissingSpent(kept, ["gemma3:4b", "gemma4:e4b"])).toBe(true); // installed
    expect(keepMissingSpent(kept, [])).toBe(false); // an empty list proves nothing
    expect(keepMissingSpent(kept, null)).toBe(false);
    expect(keepMissingSpent({ ...kept, primary: local }, installed)).toBe(true); // the curator picked another model
    expect(keepMissingSpent(ai(), installed)).toBe(false);
  });
  it("the kept notice says what is happening and is a separate notice from the first one", () => {
    expect(missingModelText("Dev-HP", "gemma4:e4b", "gemma3:4b", { gemini: false, localOnly: false, kept: true })).toBe("gemma4:e4b isn't installed; using gemma3:4b until you install it. Install it from the server console's AI models on Dev-HP.");
    expect(missingModelNoticeId("s1", "gemma4:e4b", true)).not.toBe(missingModelNoticeId("s1", "gemma4:e4b"));
  });
  it("Switch back (the model is installed on the new server) restores it without keepMissing", () => {
    const cur: AiSettings = { ...ai(), primary: { provider: "ollama", model: "gemma3:4b" }, autoSwitched: { from: "gemma4:e4b", to: "gemma3:4b", at: 5, server: "Dev-HP" }, keepMissing: { model: "gemma4:e4b", at: 6 } };
    const back = revertAutoSwitch(cur, { keepMissing: false, now: 7 })!;
    expect(back.set).toEqual({ "primary.model": "gemma4:e4b" });
    expect(back.remove).toEqual(["autoSwitched", "keepMissing"]);
    expect(revertAutoSwitch(ai(), { keepMissing: true, now: 1 })).toBeNull(); // nothing to undo
  });
});

describe("the console's default-model logic mirrors the worker's", () => {
  const cases: [string, string[], string[]][] = [
    ["gemma4:e4b", ["gemma3:4b", "gemma4:e2b"], []],
    ["gemma3n:e4b", ["qwen3:4b", "gemma3:4b"], []],
    ["gemma3:4b", ["llama3.2:3b", "qwen3:4b"], ["qwen3:4b"]],
    ["llama3", ["llama3:latest"], []],
    ["x", [], []],
    ["x", ["b:1", "a:1"], []],
  ];
  it("picks the same model", () => {
    for (const [wanted, have, prefer] of cases) expect(consoleAi.pickInstalledModel(wanted, have, prefer)).toBe(pickInstalledModel(wanted, have, prefer));
  });
  it("guards the same way, including keepMissing", () => {
    for (const [from, to, have, keep] of [
      ["a:1", "b:1", ["b:1"], undefined],
      ["a:1", "b:1", [], undefined],
      ["a:1", "b:1", null, undefined],
      ["a:1", "b:1", ["a:1", "b:1"], undefined],
      ["a:1", "b:1", ["b:1"], { model: "a:1" }],
      ["a:1", "b:1", ["b:1"], { model: "c:1" }],
    ] as [string, string, string[] | null, { model: string } | undefined][]) expect(consoleAi.canAutoSwitch(have, from, to, keep)).toBe(canAutoSwitch(have, from, to, keep));
  });
});
