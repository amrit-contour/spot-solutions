import { describe, expect, it } from "vitest";
import { isMissingBrowserError } from "./browserHeal.ts";

describe("isMissingBrowserError", () => {
  it("matches puppeteer's missing Chrome text", () => {
    expect(isMissingBrowserError(new Error("Could not find Chrome (ver. 146.0.7680.31). This can occur if either\n 1. you did not perform an installation"))).toBe(true);
    expect(isMissingBrowserError("Could not find Chromium (rev. 123)")).toBe(true);
  });
  it("ignores other launch failures", () => {
    expect(isMissingBrowserError(new Error("Navigation timeout of 30000 ms exceeded"))).toBe(false);
    expect(isMissingBrowserError(undefined)).toBe(false);
  });
});
