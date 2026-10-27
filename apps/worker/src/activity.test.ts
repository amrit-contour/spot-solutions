import { describe, expect, it, vi } from "vitest";

// A one-document store with the transaction shape logActivity uses.
const doc: { data: Record<string, unknown> | null } = { data: { activity: [] } };
vi.mock("./firebase.ts", () => ({
  col: () => ({ doc: () => ({}) }),
  db: {
    runTransaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        get: async () => ({ exists: doc.data !== null, data: () => doc.data }),
        update: (_ref: unknown, patch: Record<string, unknown>) => Object.assign(doc.data!, patch),
      }),
  },
}));

const { logActivity } = await import("./activity.ts");

describe("logActivity", () => {
  it("appends and keeps only the newest 50", async () => {
    doc.data = { activity: [] };
    for (let i = 0; i < 55; i++) await logActivity("u", "l", { kind: "post", tone: "done", text: `e${i}` });
    const list = doc.data!.activity as { text: string; at: number }[];
    expect(list).toHaveLength(50);
    expect(list[0].text).toBe("e5");
    expect(typeof list[0].at).toBe("number");
  });
  it("does nothing for a lineup that isn't there, and never throws", async () => {
    doc.data = null;
    await expect(logActivity("u", "l", { kind: "post", tone: "done", text: "x" })).resolves.toBeUndefined();
    expect(doc.data).toBeNull();
  });
});
