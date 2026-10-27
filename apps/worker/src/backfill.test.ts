import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupStep } from "@spot/shared";

// A backfilled lineup is history only: the worker's timers must never act on it.
const store = new Map<string, Record<string, unknown>>();
const ref = (k: string) => ({ get: async () => ({ data: () => store.get(k) }), update: async (d: Record<string, unknown>) => void store.set(k, { ...store.get(k), ...d }) });
vi.mock("./firebase.ts", () => ({
  col: (uid: string, c: string) => ({
    doc: (id: string) => ref(`${uid}/${c}/${id}`),
    where: (f: string, _o: string, v: unknown) => ({ get: async () => ({ docs: [...store].filter(([k, d]) => k.startsWith(`${uid}/${c}/`) && d[f] === v).map(([k, d]) => ({ id: k, data: () => d, ref: ref(k) })) }) }),
  }),
  db: {},
}));
vi.mock("./commands.ts", () => ({ notice: vi.fn(), sendConfirmation: vi.fn() }));
const micChecks: string[] = [];
vi.mock("./userData.ts", () => ({ watchUser: () => ({ settings: { timezone: "Asia/Kolkata", micCheck: { enabled: true, time: "09:00", whatsapp: true } }, shows: [{ id: "mon", name: "Monday Mic" }], venues: [] }) }));
vi.mock("./gemma.ts", () => ({ extractProfile: vi.fn() }));
vi.mock("./sendQueue.ts", () => ({ sendQueued: async (_c: unknown, _to: string, text: string) => void micChecks.push(text) }));
vi.mock("./sendRich.ts", () => ({ sendRich: vi.fn() }));
vi.mock("./greet.ts", () => ({ greetFor: vi.fn() }));
vi.mock("./voice.ts", () => ({ inVoice: vi.fn() }));
vi.mock("./agentOutbox.ts", () => ({ agentOn: async () => false, readMemory: vi.fn(), sendMicCheck: async () => false, sendToCurator: vi.fn(), writeMemory: vi.fn() }));

const { sendMicChecks } = await import("./replies.ts");
const client = { info: { wid: { _serialized: "me@c.us" } } } as never;

beforeEach(() => {
  store.clear();
  micChecks.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T12:00:00+05:30"));
});

describe("backfilled lineups are never acted on", () => {
  it("no mic check is sent for a backfilled show, but one is for a real confirmed show", async () => {
    store.set("u/lineups/a", { showId: "mon", status: "confirmed", date: "2026-10-12", backfilled: true, slots: [] });
    store.set("u/lineups/b", { showId: "mon", status: "confirmed", date: "2026-10-19", slots: [] });
    await sendMicChecks("u", client);
    expect(micChecks).toHaveLength(1);
    expect(store.get("u/lineups/a")?.micCheckSentOn).toBeUndefined();
    expect(store.get("u/lineups/b")?.micCheckSentOn).toBe("2026-10-27");
  });

  it("the day-after cleanup skips a backfilled show", () => {
    const show = { groupId: "g@g.us", active: true, cleanup: { enabled: true, time: "10:00", mode: "auto" } } as never;
    const now = { date: "2026-10-13", time: "12:00" };
    expect(cleanupStep(show, { date: "2026-10-12", status: "confirmed", outcome: "happened", cleanup: null }, now, true)).toBe("run");
    expect(cleanupStep(show, { date: "2026-10-12", status: "confirmed", outcome: "happened", cleanup: null, backfilled: true }, now, true)).toBeNull();
  });
});
