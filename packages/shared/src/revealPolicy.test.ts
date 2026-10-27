import { describe, expect, it } from "vitest";
import { shouldReveal } from "./revealPolicy.ts";

const base = { touching: false, selectionActive: false, msSinceSelectionChange: 10_000 };

describe("shouldReveal", () => {
  it("reveals on focus, typing and viewport changes when idle", () => {
    for (const trigger of ["focus", "input", "viewport"] as const) expect(shouldReveal({ ...base, trigger })).toBe(true);
  });
  it("never moves while a finger is down or text is selected", () => {
    for (const trigger of ["focus", "input", "viewport"] as const) {
      expect(shouldReveal({ ...base, trigger, touching: true })).toBe(false);
      expect(shouldReveal({ ...base, trigger, selectionActive: true })).toBe(false);
    }
  });
  it("holds back viewport jitter right after a selection change, but not typing", () => {
    expect(shouldReveal({ ...base, trigger: "viewport", msSinceSelectionChange: 50 })).toBe(false);
    expect(shouldReveal({ ...base, trigger: "input", msSinceSelectionChange: 5 })).toBe(true);
    expect(shouldReveal({ ...base, trigger: "viewport", msSinceSelectionChange: 400 })).toBe(true);
  });
});
