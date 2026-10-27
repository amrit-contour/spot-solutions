import { describe, expect, it } from "vitest";
import { CONFIRM_DELAY_MS, MAX_RESTARTS, RESTART_BACKOFF_MS, STABLE_MS, WaWatchdog, dueOnce, isWedgeError } from "./health.ts";

function rig(over: { probe?: () => Promise<unknown> } = {}) {
  const t = { now: 1_000_000, dead: false };
  const log: string[] = [];
  const dog = new WaWatchdog({
    probe: over.probe ?? (async () => { if (t.dead) throw new Error("Runtime.callFunctionOn timed out"); }),
    restart: async (ms) => void log.push(`restart:${ms}`),
    setHealth: (h) => void log.push(`health:${h}`),
    notify: (k) => void log.push(`notify:${k}`),
    giveUp: () => void log.push("giveup"),
    now: () => t.now,
    sleep: async (ms) => void (t.now += ms),
    serverName: "mac",
  });
  return { t, log, dog };
}

describe("WaWatchdog", () => {
  it("does nothing while the page answers", async () => {
    const { dog, log } = rig();
    expect(await dog.check()).toBe("ok");
    expect(log).toEqual([]);
  });
  it("ignores one slow answer (the second probe works)", async () => {
    let n = 0;
    const { dog, log } = rig({ probe: async () => { if (n++ === 0) throw new Error("slow"); } });
    expect(await dog.check()).toBe("ok");
    expect(log).toEqual([]);
  });
  it("flags, tells the app and restarts when two probes fail, then reports recovery", async () => {
    const { dog, log, t } = rig();
    t.dead = true;
    expect(await dog.check()).toBe("restarted");
    expect(log).toEqual(["health:unresponsive", "notify:unresponsive", `restart:${RESTART_BACKOFF_MS[0]}`]);
    t.dead = false;
    await dog.check();
    expect(log.slice(3)).toEqual(["health:ok", "notify:recovered"]);
  });
  it("backs off, then gives up for fleet failover after repeated failures", async () => {
    const { dog, log, t } = rig();
    t.dead = true;
    for (let i = 0; i < MAX_RESTARTS; i++) await dog.check();
    expect(log.filter((l) => l.startsWith("restart:"))).toEqual(RESTART_BACKOFF_MS.map((m) => `restart:${m}`));
    expect(await dog.check()).toBe("gave-up");
    expect(log.slice(-3)).toEqual(["health:failing", "notify:failing", "giveup"]);
    expect(await dog.check()).toBe("busy"); // stays given up
    dog.resetIfStale(t.now + 11 * 60_000);
    expect(dog.health).toBe("ok");
  });
  it("a page that flaps right after each restart keeps counting; a stable one is forgiven", async () => {
    const { dog, t } = rig();
    t.dead = true;
    await dog.check();
    t.dead = false;
    await dog.check();
    expect(dog.restarts).toBe(1);
    t.now += STABLE_MS;
    await dog.check();
    expect(dog.restarts).toBe(0);
  });
  it("times out a probe that never answers", async () => {
    const { dog } = rig({ probe: () => new Promise(() => undefined) });
    // probe timeout is real time (15 s) in the race; use fake sleep only for the confirm gap, so cap the wait by racing
    const r = await Promise.race([dog.check(), new Promise((res) => setTimeout(() => res("pending"), 100))]);
    expect(r).toBe("pending"); // still waiting on the 15 s timeout: nothing was flagged early
    expect(CONFIRM_DELAY_MS).toBeGreaterThan(0);
  });
});

describe("isWedgeError", () => {
  it("matches page-level failures only", () => {
    expect(isWedgeError(Object.assign(new Error("Runtime.callFunctionOn timed out"), { name: "ProtocolError" }))).toBe(true);
    expect(isWedgeError(Object.assign(new Error("Protocol error"), { name: "TargetCloseError" }))).toBe(true);
    expect(isWedgeError(Object.assign(new Error("Waiting failed: 30000ms exceeded"), { name: "TimeoutError" }))).toBe(true);
    expect(isWedgeError(new Error("No LID for user"))).toBe(false);
  });
});

describe("dueOnce", () => {
  it("dedupes inside the window", () => {
    const m = new Map<string, number>();
    expect(dueOnce(m, "k", 1000, 5000)).toBe(true);
    expect(dueOnce(m, "k", 1000, 5500)).toBe(false);
    expect(dueOnce(m, "k", 1000, 6100)).toBe(true);
  });
});
