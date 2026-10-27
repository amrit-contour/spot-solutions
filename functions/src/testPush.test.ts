import { describe, expect, it } from "vitest";
import { sendTestPush, type TestPushPorts } from "./testPush";

function ports(tokens: string[], result = { sent: tokens.length, dead: [] as string[] }) {
  const log = { sent: [] as { tokens: string[]; data: Record<string, string> }[], pruned: [] as string[] };
  const p: TestPushPorts = {
    comicTokens: async () => tokens,
    send: async (t, data) => (log.sent.push({ tokens: t, data }), result),
    prune: async (_u, t) => void log.pruned.push(...t),
  };
  return { p, log };
}
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);

describe("sendTestPush", () => {
  it("sends to the caller's Comedy devices and reports the count", async () => {
    const { p, log } = ports(["a", "b"]);
    expect(await sendTestPush(p, { uid: "u" })).toEqual({ sent: 2, devices: 2 });
    expect(log.sent[0]!.tokens).toEqual(["a", "b"]);
    expect(log.sent[0]!.data.kind).toBe("test");
  });
  it("refuses signed-out and anonymous callers", async () => {
    const { p, log } = ports(["a"]);
    expect(await code(sendTestPush(p, {}))).toBe("permission-denied");
    expect(await code(sendTestPush(p, { uid: "u", anonymous: true }))).toBe("permission-denied");
    expect(log.sent).toHaveLength(0);
  });
  it("says so when no device is registered", async () => {
    expect(await code(sendTestPush(ports([]).p, { uid: "u" }))).toBe("failed-precondition");
  });
  it("prunes dead tokens and fails when nothing landed", async () => {
    const { p, log } = ports(["a"], { sent: 0, dead: ["a"] });
    expect(await code(sendTestPush(p, { uid: "u" }))).toBe("failed-precondition");
    expect(log.pruned).toEqual(["a"]);
  });
});
