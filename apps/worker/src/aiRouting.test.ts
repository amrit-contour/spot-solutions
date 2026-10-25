import { describe, expect, it } from "vitest";
import { IMPLICIT_GEMINI_MODEL, planRoutes } from "./aiRouting.ts";

const local = { provider: "ollama", model: "gemma3:4b" } as const;
const cloud = { provider: "gemini", model: "gemini-2.5-flash-lite" } as const;

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
