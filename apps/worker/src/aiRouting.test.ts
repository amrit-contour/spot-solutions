import { describe, expect, it } from "vitest";
import { IMPLICIT_GEMINI_MODEL, autoSwitchUpdate, canAutoSwitch, missingModelText, ollamaKeepAlive, pickInstalledModel, planRoutes, planRoutesDetailed } from "./aiRouting.ts";

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
