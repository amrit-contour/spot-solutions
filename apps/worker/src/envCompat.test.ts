import { describe, expect, it } from "vitest";
import { aliasLegacyEnv } from "./envCompat.ts";

describe("aliasLegacyEnv", () => {
  it("copies SPOT_X to NBS_X when NBS_X is not set", () => {
    const env: Record<string, string | undefined> = { SPOT_ADMIN_EMAILS: "a@x.com", SPOT_AI_MODE: "gemini_only" };
    aliasLegacyEnv(env);
    expect(env.NBS_ADMIN_EMAILS).toBe("a@x.com");
    expect(env.NBS_AI_MODE).toBe("gemini_only");
  });
  it("never overrides an NBS_ value, even an empty one", () => {
    const env: Record<string, string | undefined> = { SPOT_AI_MODE: "local_only", NBS_AI_MODE: "gemini_first", SPOT_LOCAL_MODEL: "old", NBS_LOCAL_MODEL: "" };
    aliasLegacyEnv(env);
    expect(env.NBS_AI_MODE).toBe("gemini_first");
    expect(env.NBS_LOCAL_MODEL).toBe("");
  });
  it("leaves other variables alone", () => {
    const env: Record<string, string | undefined> = { OLLAMA_URL: "x", SPOT: "y" };
    aliasLegacyEnv(env);
    expect(env).toEqual({ OLLAMA_URL: "x", SPOT: "y" });
  });
});
