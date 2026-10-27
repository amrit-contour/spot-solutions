import { describe, expect, it } from "vitest";
import { isServerUp, linkView, maskPhoneTail, serverLastSeen } from "./connection.ts";

describe("linkView", () => {
  it("ready is connected, even if the heartbeat is old (the card says so separately)", () => {
    expect(linkView({ status: "ready" }, true)).toBe("connected");
    expect(linkView({ status: "ready" }, false)).toBe("connected");
  });
  it("a silent server wins over everything but ready", () => {
    expect(linkView({ status: "qr" }, false)).toBe("offline");
    expect(linkView(null, false)).toBe("offline");
  });
  it("up server: qr, starting, unlinked", () => {
    expect(linkView({ status: "qr" }, true)).toBe("qr");
    expect(linkView({ status: "authenticated" }, true)).toBe("starting");
    expect(linkView({ status: "disconnected" }, true)).toBe("unlinked");
    expect(linkView(null, true)).toBe("unlinked");
  });
});

describe("server presence", () => {
  it("is up within 90 s of lastSeen", () => {
    expect(isServerUp({ status: "ready", lastSeen: 1_000_000 }, 1_080_000)).toBe(true);
    expect(isServerUp({ status: "ready", lastSeen: 1_000_000 }, 1_100_000)).toBe(false);
    expect(isServerUp({ status: "ready", lastSeen: 0 }, 5)).toBe(false);
  });
  it("last seen falls back to aliveAt after a clean shutdown", () => {
    expect(serverLastSeen({ status: "idle", lastSeen: 0, aliveAt: 42 })).toBe(42);
    expect(serverLastSeen(null)).toBeNull();
  });
});

describe("maskPhoneTail", () => {
  it("keeps the country code and last five digits", () => {
    expect(maskPhoneTail("919876512345")).toBe("+91 ••••• 12345");
    expect(maskPhoneTail("61412345678")).toBe("+61 ••••• 45678");
    expect(maskPhoneTail("14155550123")).toBe("+1 ••••• 50123");
  });
  it("short or empty numbers never leak more than five digits", () => {
    expect(maskPhoneTail("")).toBe("");
    expect(maskPhoneTail(null)).toBe("");
    expect(maskPhoneTail("12345")).toBe("+••••• 12345");
  });
});
