import { describe, expect, it } from "vitest";
import { evidenceIsReal } from "./gemma.ts";

// Regression: the model once "quoted" asks that weren't in notification/link messages, and acks went out.
describe("evidenceIsReal", () => {
  it("rejects evidence the model made up", () => {
    expect(evidenceIsReal("can I get a spot this monday", ["NOTICE: Your bank account will be marked inactive. Please transact to keep it active."])).toBe(false);
    expect(evidenceIsReal("wants to perform", ["https://example.com/share/v/abc123"])).toBe(false);
    expect(evidenceIsReal("", ["bro any spot?"])).toBe(false);
  });
  it("accepts a real quote, ignoring case and punctuation", () => {
    expect(evidenceIsReal("Can i get a spot for Tue", ["Can i get a spot for Tue?"])).toBe(true);
    expect(evidenceIsReal("monday ka spot milega", ["hey bro", "Monday ka spot milega??"])).toBe(true);
  });
});
