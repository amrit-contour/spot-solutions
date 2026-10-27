import { describe, expect, it } from "vitest";
import { RESTART_GRACE_MS, isServerUp, linkView, maskPhoneTail, restartLabel, restartMarker, restartingNow, serverLastSeen, serverState } from "./connection.ts";

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

describe("linkView health", () => {
  it("a ready session whose page stopped answering is unresponsive, not connected", () => {
    expect(linkView({ status: "ready", health: "unresponsive" }, true)).toBe("unresponsive");
    expect(linkView({ status: "ready", health: "failing" }, true)).toBe("unresponsive");
    expect(linkView({ status: "ready", health: "ok" }, true)).toBe("connected");
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

describe("planned restarts", () => {
  const T = 10_000_000;
  const down = { status: "ready" as const, lastSeen: 0, restarting: restartMarker(T, "update") };
  it("the marker lasts 3 minutes", () => {
    expect(restartMarker(T, "restart")).toEqual({ at: T, reason: "restart", until: T + RESTART_GRACE_MS });
    expect(RESTART_GRACE_MS).toBe(180_000);
  });
  it("silent server with a live marker is restarting, not offline", () => {
    expect(serverState(down, T + 30_000)).toBe("restarting");
    expect(linkView(down, false, T + 30_000)).toBe("restarting");
    expect(linkView({ ...down, status: "qr" }, false, T + 30_000)).toBe("restarting");
  });
  it("falls back to offline once `until` passes with no heartbeat", () => {
    expect(serverState(down, T + RESTART_GRACE_MS)).toBe("offline");
    expect(linkView(down, false, T + RESTART_GRACE_MS + 1)).toBe("connected"); // ready keeps its old rule
    expect(linkView({ ...down, status: "qr" }, false, T + RESTART_GRACE_MS + 1)).toBe("offline");
  });
  it("no marker is plain offline", () => {
    expect(serverState({ status: "ready", lastSeen: 0 }, T)).toBe("offline");
    expect(serverState(null, T)).toBe("offline");
    expect(linkView({ status: "qr" }, false, T)).toBe("offline");
  });
  it("a heartbeat wins over the marker, and a heartbeat after it ends the restart", () => {
    expect(serverState({ ...down, lastSeen: T + 20_000 }, T + 30_000)).toBe("up");
    expect(restartingNow(down.restarting, T + 20_000, T + 140_000)).toBeNull(); // stale beat after the marker: back, then silent
    expect(restartingNow(down.restarting, T - 5, T + 30_000)).toEqual(down.restarting); // a beat from before the marker doesn't cancel it
  });
  it("ignores a malformed marker and one with a far-future until", () => {
    expect(restartingNow({ at: T, reason: "update" } as never, 0, T + 1)).toBeNull();
    expect(restartingNow({ at: T, reason: "update", until: T + 99 * 60_000 }, 0, T + 10 * 60_000)).toBeNull();
  });
  it("words", () => {
    expect(restartLabel("update")).toBe("Updating server… back in a minute");
    expect(restartLabel("restart")).toBe("Restarting server… back in a minute");
  });
});
