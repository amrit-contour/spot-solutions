import { describe, expect, it } from "vitest";
import { MIN_OUTAGE_MS, createNetWatch, isNetError } from "./netWatch.ts";

describe("isNetError", () => {
  it("recognises what the Windows laptop logged", () => {
    expect(isNetError(new Error("14 UNAVAILABLE: No connection established. Last error: connect EHOSTUNREACH 142.250.1.95:443"))).toBe(true);
    expect(isNetError(Object.assign(new Error("x"), { code: 14 }))).toBe(true);
    expect(isNetError(new Error("getaddrinfo ENOTFOUND firestore.googleapis.com"))).toBe(true);
  });
  it("ignores bugs and permission errors", () => {
    expect(isNetError(new Error("7 PERMISSION_DENIED: Missing or insufficient permissions"))).toBe(false);
    expect(isNetError(new TypeError("x is undefined"))).toBe(false);
    expect(isNetError(null)).toBe(false);
  });
});

describe("createNetWatch", () => {
  const T = 1_000_000;
  const err = new Error("14 UNAVAILABLE: connect EHOSTUNREACH");
  it("reports the window once writes recover, from the first failure", () => {
    const w = createNetWatch();
    w.fail(err, T);
    w.fail(err, T + 30_000); // later failures don't move the start
    expect(w.pending(T + 6 * 60_000)).toEqual({ ok: true, since: T + 6 * 60_000, downFrom: T });
    w.clear();
    expect(w.pending(T + 7 * 60_000)).toBeNull();
  });
  it("says nothing without a network failure, or for a blip", () => {
    const w = createNetWatch();
    expect(w.pending(T)).toBeNull();
    w.fail(new Error("7 PERMISSION_DENIED"), T);
    expect(w.pending(T + 10 * 60_000)).toBeNull();
    w.fail(err, T);
    expect(w.pending(T + MIN_OUTAGE_MS - 1)).toBeNull();
    expect(w.pending(T + MIN_OUTAGE_MS)).not.toBeNull();
  });
});
