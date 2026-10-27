import { describe, expect, it } from "vitest";
import { CACHE_GRACE_MS, NET_NOTE_MS, RESTART_GRACE_MS, clock, deriveLink, deriveServer, isServerUp, linkView, maskPhoneTail, netNotice, phoneNotice, restartLabel, restartMarker, restartingNow, serverLastSeen, serverState, shouldNudge, unreachableNotice } from "./connection.ts";

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

describe("deriveServer: phone offline vs server silent vs restarting vs up", () => {
  const T = 50_000_000;
  const live = { online: true, fromCache: false, cachedSince: null, liveAt: T };
  const fresh = { status: "ready" as const, lastSeen: T - 20_000 };
  const silent = { status: "ready" as const, lastSeen: T - 10 * 60_000 };

  it("fresh heartbeat on a live phone is up", () => {
    const d = deriveServer(fresh, T, live);
    expect([d.reach, d.up, d.phone]).toEqual(["up", true, "ok"]);
    expect(deriveLink(fresh, d)).toBe("connected");
  });
  it("silent heartbeat on a live phone is offline, never connected", () => {
    const d = deriveServer(silent, T, live);
    expect([d.reach, d.up]).toEqual(["offline", false]);
    expect(deriveLink(silent, d)).toBe("offline");
    expect(unreachableNotice(d)).toBe(`Server not reachable since ${clock(silent.lastSeen)}`);
  });
  it("a planned restart on a live phone is restarting", () => {
    const s = { status: "ready" as const, lastSeen: 0, restarting: restartMarker(T - 30_000, "update") };
    const d = deriveServer(s, T, live);
    expect(d.reach).toBe("restarting");
    expect(d.restarting?.reason).toBe("update");
    expect(deriveLink(s, d)).toBe("restarting");
  });
  it("no phone info behaves like a live phone", () => {
    expect(deriveServer(silent, T).reach).toBe("offline");
    expect(deriveServer(fresh, T, null).reach).toBe("up");
  });
  it("an offline phone says unknown, not server offline, whatever the heartbeat looks like", () => {
    const off = { online: false, fromCache: true, cachedSince: T - 60_000, liveAt: T - 5 * 60_000 };
    for (const s of [fresh, silent, null]) {
      const d = deriveServer(s, T, off);
      expect([d.reach, d.up, d.phone, d.restarting]).toEqual(["unknown", false, "offline", null]);
      expect(deriveLink(s, d)).toBe("unknown");
    }
    expect(phoneNotice(deriveServer(silent, T, off))).toBe(`You're offline: showing the last known status (as of ${clock(T - 5 * 60_000)})`);
  });
  it("cached snapshots on a phone that is online read as reconnecting, after a short grace", () => {
    const young = { online: true, fromCache: true, cachedSince: T - 2_000, liveAt: null };
    expect(deriveServer(silent, T, young).reach).toBe("offline"); // a cold start from the cache is not a lost connection
    const old = { online: true, fromCache: true, cachedSince: T - CACHE_GRACE_MS, liveAt: T - 90_000 };
    const d = deriveServer(silent, T, old);
    expect([d.reach, d.phone]).toEqual(["unknown", "reconnecting"]);
    expect(phoneNotice(d)).toBe(`Reconnecting… showing the last known status (as of ${clock(T - 90_000)})`);
  });
  it("as-of falls back to the last heartbeat when the phone never had live data", () => {
    const d = deriveServer(silent, T, { online: false, fromCache: true, cachedSince: T - 1, liveAt: null });
    expect(d.asOf).toBe(silent.lastSeen);
    expect(phoneNotice({ phone: "offline", asOf: null })).toBe("You're offline: showing the last known status");
  });
  it("works on a servers/{id} heartbeat too (same rules as a session doc)", () => {
    const server = { lastSeen: T - 10 * 60_000, restarting: restartMarker(T - 20_000, "restart") };
    expect(deriveServer(server, T, live).reach).toBe("restarting");
    expect(deriveServer({ lastSeen: T - 1_000 }, T, live).reach).toBe("up");
    expect(deriveServer({ lastSeen: T - 91_000 }, T, live).reach).toBe("offline");
  });
});

describe("shouldNudge", () => {
  const T = 9_000_000;
  const stuck = { online: true, fromCache: true, cachedSince: T - 25_000, liveAt: null };
  it("only when online and cached for 20 s or more", () => {
    expect(shouldNudge(stuck, T, null)).toBe(true);
    expect(shouldNudge({ ...stuck, cachedSince: T - 19_000 }, T, null)).toBe(false);
    expect(shouldNudge({ ...stuck, online: false }, T, null)).toBe(false);
    expect(shouldNudge({ ...stuck, fromCache: false, cachedSince: null }, T, null)).toBe(false);
  });
  it("not again within 20 s of the last nudge", () => {
    expect(shouldNudge(stuck, T, T - 5_000)).toBe(false);
    expect(shouldNudge(stuck, T, T - 20_000)).toBe(true);
  });
});

describe("netNotice", () => {
  const T = 70_000_000;
  const net = { ok: true, since: T - 3 * 60_000, downFrom: T - 9 * 60_000 };
  it("names the outage window", () => {
    expect(netNotice(net, T)).toBe(`Server lost internet ${clock(net.downFrom)}–${clock(net.since)}`);
  });
  it("goes away after six hours, and ignores nothing-to-say shapes", () => {
    expect(netNotice(net, net.since + NET_NOTE_MS + 1)).toBeNull();
    expect(netNotice(null, T)).toBeNull();
    expect(netNotice({ ok: true, since: T }, T)).toBeNull();
  });
});
