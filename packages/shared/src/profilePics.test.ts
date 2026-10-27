import { describe, expect, it } from "vitest";
import { isWaJid, jidForPhone } from "./profilePics.ts";

describe("isWaJid", () => {
  it("accepts people and groups, nothing else", () => {
    expect(isWaJid("120363000000000000@g.us")).toBe(true);
    expect(isWaJid("919800000000@c.us")).toBe(true);
    expect(isWaJid("123456789012@lid")).toBe(true);
    expect(isWaJid("someone@example.com")).toBe(false);
    expect(isWaJid("a/b@g.us")).toBe(false);
    expect(isWaJid(42)).toBe(false);
  });
});

describe("jidForPhone", () => {
  it("turns a typed number into a WhatsApp id, or null", () => {
    expect(jidForPhone("+65 9123 4567")).toBe("6591234567@c.us");
    expect(jidForPhone("not a number")).toBeNull();
    expect(jidForPhone(undefined)).toBeNull();
  });
});
