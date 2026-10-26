import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken, parseKey } from "./gcrypto";

const key = randomBytes(32);

describe("token encryption", () => {
  it("round-trips and never stores the plaintext", () => {
    const blob = encryptToken(key, "u1", "1//refresh-token");
    expect(blob).not.toContain("refresh");
    expect(decryptToken(key, "u1", blob)).toBe("1//refresh-token");
  });
  it("uses a fresh IV every time", () => {
    expect(encryptToken(key, "u1", "t")).not.toBe(encryptToken(key, "u1", "t"));
  });
  it("refuses another account's uid, another key, and a tampered blob", () => {
    const blob = encryptToken(key, "u1", "t");
    expect(() => decryptToken(key, "u2", blob)).toThrow();
    expect(() => decryptToken(randomBytes(32), "u1", blob)).toThrow();
    const [v, iv, tag, ct] = blob.split(".");
    expect(() => decryptToken(key, "u1", [v, iv, tag, Buffer.from("x").toString("base64url") + ct].join("."))).toThrow();
    expect(() => decryptToken(key, "u1", "v9.a.b.c")).toThrow();
  });
  it("only takes a 32 byte key", () => {
    expect(parseKey(key.toString("base64")).length).toBe(32);
    expect(() => parseKey("c2hvcnQ=")).toThrow(/32 bytes/);
  });
});
