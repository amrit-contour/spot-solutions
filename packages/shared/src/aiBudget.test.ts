import { describe, expect, it } from "vitest";
import { AI_APP_WAIT_MS, AI_CLOUD_INTERACTIVE_MS, AI_INTERACTIVE_DEADLINE_MS, AI_LOCAL_INTERACTIVE_MS, aiFailureMessage, isTimeoutError, routeBudgetMs, trimForModel } from "./aiBudget.ts";
import type { ThreadMessage } from "./threads.ts";

const m = (i: number, text = "x"): ThreadMessage => ({ id: `m${i}`, at: i, fromMe: false, kind: "text", text });

describe("budgets", () => {
  it("the app waits longer than the worker ever works", () => {
    expect(AI_APP_WAIT_MS).toBeGreaterThan(AI_INTERACTIVE_DEADLINE_MS);
    expect(AI_APP_WAIT_MS - AI_INTERACTIVE_DEADLINE_MS).toBeGreaterThanOrEqual(30_000);
  });
  it("gives a route its cap, less what the deadline leaves, and none near the end", () => {
    const t0 = 1_000_000;
    expect(routeBudgetMs("ollama", t0 + AI_INTERACTIVE_DEADLINE_MS, t0)).toBe(AI_LOCAL_INTERACTIVE_MS);
    expect(routeBudgetMs("gemini", t0 + AI_INTERACTIVE_DEADLINE_MS, t0)).toBe(AI_CLOUD_INTERACTIVE_MS);
    expect(routeBudgetMs("gemini", t0 + 40_000, t0)).toBe(40_000);
    expect(routeBudgetMs("gemini", t0 + 10_000, t0)).toBe(0);
  });
  it("a local timeout then Gemini still fits in the deadline", () => {
    expect(AI_LOCAL_INTERACTIVE_MS + AI_CLOUD_INTERACTIVE_MS).toBeLessThanOrEqual(AI_INTERACTIVE_DEADLINE_MS);
  });
});

describe("failure wording", () => {
  it("never says 'operation was aborted'", () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(isTimeoutError(abort)).toBe(true);
    expect(aiFailureMessage("ollama", abort)).toBe("The local model took too long. Try again or use Gemini.");
    expect(aiFailureMessage("gemini", new Error("The operation was aborted due to timeout"))).toBe("Gemini took too long. Try again.");
    expect(aiFailureMessage("ollama", new Error("fetch failed"))).toMatch(/isn't running/);
    expect(aiFailureMessage("gemini", new Error("quota exceeded"))).toBe("quota exceeded");
  });
});

describe("trimForModel", () => {
  it("keeps the newest messages up to the count", () => {
    const out = trimForModel(Array.from({ length: 50 }, (_, i) => m(i)), { maxMessages: 30 });
    expect(out).toHaveLength(30);
    expect(out[0].id).toBe("m20");
    expect(out[29].id).toBe("m49");
  });
  it("stops at the character cap, always keeping the newest", () => {
    const out = trimForModel(Array.from({ length: 20 }, (_, i) => m(i, "y".repeat(300))), { maxChars: 1000, perMessage: 400 });
    expect(out.map((x) => x.id)).toEqual(["m17", "m18", "m19"]);
    expect(trimForModel([m(1, "z".repeat(900))], { maxChars: 100 })).toHaveLength(1);
  });
});
