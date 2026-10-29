import { describe, expect, it } from "vitest";
import { aiFromLegacy, pickRoutes, revertAutoSwitch } from "./defaults.ts";
import type { AiSettings } from "./types.ts";

const base: AiSettings = { primary: { provider: "ollama", model: "gemma3:4b" }, fallback: { provider: "gemini", model: "g" }, autoSwitched: { from: "gemma4:e4b", to: "gemma3:4b", at: 1, server: "S" } };

describe("revertAutoSwitch", () => {
  it("restores the old model on whichever route holds the new one", () => {
    expect(revertAutoSwitch(base, { keepMissing: true, now: 9 })).toEqual({ set: { "primary.model": "gemma4:e4b", keepMissing: { model: "gemma4:e4b", at: 9 } }, remove: ["autoSwitched"] });
    const both = { ...base, fallback: { provider: "ollama" as const, model: "gemma3:4b" } };
    expect(revertAutoSwitch(both, { keepMissing: false, now: 9 })?.set).toEqual({ "primary.model": "gemma4:e4b", "fallback.model": "gemma4:e4b" });
  });
});

describe("pickRoutes", () => {
  const kept: AiSettings = { ...base, primary: { provider: "ollama", model: "gemma4:e4b" }, autoSwitched: undefined, keepMissing: { model: "gemma4:e4b", at: 1 } };
  it("moving to another model clears keepMissing and the stale switch note", () => {
    expect(pickRoutes(kept, { primary: { provider: "ollama", model: "gemma3:4b" } }, ["gemma3:4b"], 5).remove).toEqual(["keepMissing"]);
    expect(pickRoutes(base, { primary: { provider: "ollama", model: "qwen3:4b" } }, ["qwen3:4b"], 5).remove).toEqual(["autoSwitched"]);
  });
  it("picking a missing model on purpose is kept; an empty or unknown list is never proof", () => {
    const miss = { provider: "ollama" as const, model: "gemma4:e4b" };
    expect(pickRoutes(base, { primary: miss }, ["gemma3:4b"], 5).set).toEqual({ primary: miss, keepMissing: { model: "gemma4:e4b", at: 5 } });
    expect(pickRoutes(base, { primary: miss }, [], 5).set).toEqual({ primary: miss });
    expect(pickRoutes(base, { primary: miss }, null, 5).set).toEqual({ primary: miss });
    expect(pickRoutes(base, { primary: { provider: "ollama", model: "" } }, ["gemma3:4b"], 5).set).toEqual({ primary: { provider: "ollama", model: "" } });
  });
  it("keeps keepMissing while the model is still routed", () => {
    expect(pickRoutes(kept, { fallback: null }, ["gemma3:4b"], 5).remove).toEqual([]);
  });
});

describe("aiFromLegacy", () => {
  it("carries keepMissing", () => {
    expect(aiFromLegacy({ ai: { primary: base.primary, keepMissing: { model: "m", at: 1 } } }).keepMissing).toEqual({ model: "m", at: 1 });
  });
  it("carries the Ollama Cloud key hint (the card showed 'Not set' after saving without it)", () => {
    const cloud = { url: "https://ollama.com", keyHint: "ab12", savedAt: 1 };
    expect(aiFromLegacy({ ai: { primary: base.primary, cloud } }).cloud).toEqual(cloud);
    expect(aiFromLegacy({ ai: { cloud } }).cloud).toEqual(cloud);
  });
});
