import { describe, expect, it } from "vitest";
import { formatBuiltAt, isTypingTarget, isUpdateAvailable, parseVersionInfo, shouldCheckNow, updatePromptDecision, versionLabel } from "./appVersion.ts";

const run = { version: "46fe7dd", builtAt: "2026-10-27T08:40:00Z" };

describe("parseVersionInfo", () => {
  it("reads a version.json body", () => expect(parseVersionInfo({ version: " abc123 ", builtAt: "2026-10-27T08:40:00Z" })).toEqual({ version: "abc123", builtAt: "2026-10-27T08:40:00Z" }));
  it("rejects junk and HTML fallbacks", () => {
    for (const v of [null, undefined, "<html>", 4, {}, { version: "" }, { version: 3 }]) expect(parseVersionInfo(v)).toBeNull();
  });
  it("tolerates a missing builtAt", () => expect(parseVersionInfo({ version: "x" })).toEqual({ version: "x", builtAt: "" }));
});

describe("isUpdateAvailable", () => {
  it("is false when the same release is served", () => expect(isUpdateAvailable(run, { ...run, builtAt: "later" })).toBe(false));
  it("is true when the served release differs", () => expect(isUpdateAvailable(run, { version: "9abc012", builtAt: "" })).toBe(true));
  it("is false when nothing could be fetched", () => expect(isUpdateAvailable(run, null)).toBe(false));
  it("never prompts a dev build", () => {
    expect(isUpdateAvailable({ version: "dev", builtAt: "" }, run)).toBe(false);
    expect(isUpdateAvailable(run, { version: "dev", builtAt: "" })).toBe(false);
  });
});

describe("formatting", () => {
  const now = new Date("2026-10-27T12:00:00Z");
  it("formats day, month and 12-hour time", () => expect(formatBuiltAt("2026-10-27T07:40:00Z", now, "en-AU", "Australia/Melbourne")).toBe("27 Oct, 6:40 PM"));
  it("adds the year for another year", () => expect(formatBuiltAt("2025-03-01T00:00:00Z", now, "en-AU", "UTC")).toBe("1 Mar 2025, 12:00 AM"));
  it("is empty for a bad timestamp", () => expect(formatBuiltAt("nope")).toBe(""));
  it("builds the label", () => expect(versionLabel(run, now, "en-AU", "Australia/Melbourne")).toBe("Version 46fe7dd · 27 Oct, 7:40 PM"));
  it("drops the time part when unknown", () => expect(versionLabel({ version: "abc", builtAt: "" })).toBe("Version abc"));
});

describe("updatePromptDecision", () => {
  const base = { available: true, version: "9abc012", promptedFor: null, inputFocused: false };
  it("shows once", () => expect(updatePromptDecision(base)).toBe("show"));
  it("not again for the same version", () => expect(updatePromptDecision({ ...base, promptedFor: "9abc012" })).toBe("skip"));
  it("again for a newer version", () => expect(updatePromptDecision({ ...base, promptedFor: "old" })).toBe("show"));
  it("defers while typing", () => expect(updatePromptDecision({ ...base, inputFocused: true })).toBe("defer"));
  it("skips when no update", () => expect(updatePromptDecision({ ...base, available: false })).toBe("skip"));
});

describe("shouldCheckNow", () => {
  it("checks the first time", () => expect(shouldCheckNow({ lastCheckedAt: null, now: 1 })).toBe(true));
  it("debounces focus and visibility firing together", () => expect(shouldCheckNow({ lastCheckedAt: 1000, now: 2000 })).toBe(false));
  it("checks after the gap", () => expect(shouldCheckNow({ lastCheckedAt: 1000, now: 7000 })).toBe(true));
  it("never overlaps a running check", () => expect(shouldCheckNow({ lastCheckedAt: null, now: 1, checking: true })).toBe(false));
});

describe("isTypingTarget", () => {
  it("is true for text fields", () => {
    expect(isTypingTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTypingTarget({ tagName: "textarea" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });
  it("is false for buttons, checkboxes and nothing", () => {
    expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
