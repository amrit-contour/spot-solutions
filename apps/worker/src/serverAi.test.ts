import { describe, expect, it } from "vitest";
import { serverAiDefault } from "./serverAi.ts";

describe("serverAiDefault", () => {
  it("leaves things alone when no routing was chosen", () => {
    expect(serverAiDefault({}, false)).toBeNull();
    expect(serverAiDefault({ NBS_AI_MODE: "nonsense" }, false)).toBeNull();
  });
  it("maps each routing", () => {
    const env = { NBS_LOCAL_MODEL: "gemma3:1b", NBS_GEMINI_MODEL: "gemini-2.5-pro" };
    expect(serverAiDefault({ ...env, NBS_AI_MODE: "local_first" }, false)).toEqual({ primary: { provider: "ollama", model: "gemma3:1b" }, fallback: { provider: "gemini", model: "gemini-2.5-pro" } });
    expect(serverAiDefault({ ...env, NBS_AI_MODE: "gemini_first" }, false)).toEqual({ primary: { provider: "gemini", model: "gemini-2.5-pro" }, fallback: { provider: "ollama", model: "gemma3:1b" } });
    expect(serverAiDefault({ ...env, NBS_AI_MODE: "gemini_only" }, false)).toEqual({ primary: { provider: "gemini", model: "gemini-2.5-pro" }, fallback: null });
    expect(serverAiDefault({ NBS_AI_MODE: "local_only" }, false)).toEqual({ primary: { provider: "ollama", model: "gemma3:4b" }, fallback: null, policy: "local_only" });
  });
  it("answers with Gemini on a server that has no local model", () => {
    expect(serverAiDefault({ NBS_AI_MODE: "local_first" }, true)).toEqual({ primary: { provider: "gemini", model: "gemini-2.5-flash" }, fallback: null });
  });
});
