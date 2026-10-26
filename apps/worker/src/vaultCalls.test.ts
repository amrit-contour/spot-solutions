import { describe, expect, it } from "vitest";
import { PREPARE_BACKOFF_MS, classifyPrepareError, prepareWithRetry } from "./vaultCalls.ts";
import { VaultFailure } from "./vault.ts";

const noSleep = () => {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
};

describe("classifyPrepareError", () => {
  it("sha mismatch, decrypt failure, confirmed-missing object, no key and no object are deterministic", () => {
    for (const k of ["sha", "decrypt", "missing", "nokey", "noobject"] as const) expect(classifyPrepareError(new VaultFailure(k, "x"))).toBe("deterministic");
  });
  it("network and IO errors are transient", () => {
    expect(classifyPrepareError(new Error("ETIMEDOUT"))).toBe("transient");
    expect(classifyPrepareError(Object.assign(new Error("EBUSY"), { code: "EBUSY" }))).toBe("transient");
    expect(classifyPrepareError("boom")).toBe("transient");
  });
});

describe("prepareWithRetry", () => {
  it("retries transient errors 2/4/8/16 s then succeeds", async () => {
    const { waits, sleep } = noSleep();
    let n = 0;
    const out = await prepareWithRetry(async () => { if (++n < 4) throw new Error("ECONNRESET"); return "cloud" as const; }, { sleep });
    expect(out).toBe("cloud");
    expect(waits).toEqual([2_000, 4_000, 8_000]);
  });
  it("after 4 retries a transient error is thrown (never a QR)", async () => {
    const { waits, sleep } = noSleep();
    let n = 0;
    await expect(prepareWithRetry(async () => { n++; throw new Error("offline"); }, { sleep })).rejects.toThrow("offline");
    expect(n).toBe(5);
    expect(waits).toEqual(PREPARE_BACKOFF_MS);
    expect(PREPARE_BACKOFF_MS).toEqual([2_000, 4_000, 8_000, 16_000]);
  });
  it("a deterministic failure is fresh at once, without retrying", async () => {
    const { waits, sleep } = noSleep();
    let n = 0;
    expect(await prepareWithRetry(async () => { n++; throw new VaultFailure("sha", "sha256 mismatch"); }, { sleep })).toBe("fresh");
    expect(n).toBe(1);
    expect(waits).toEqual([]);
  });
  it("an ordinary result passes straight through", async () => {
    expect(await prepareWithRetry(async () => "fresh" as const)).toBe("fresh");
    expect(await prepareWithRetry(async () => "local" as const)).toBe("local");
  });
});
