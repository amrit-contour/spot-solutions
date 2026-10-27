import { beforeEach, describe, expect, it, vi } from "vitest";

// A tiny in-memory Firestore: enough for the transaction and the offer lookups addDirect makes.
const store = new Map<string, Record<string, unknown>>();
const key = (uid: string, c: string, id: string) => `${uid}/${c}/${id}`;
const ref = (k: string) => ({
  get: async () => ({ data: () => store.get(k) }),
  update: async (d: Record<string, unknown>) => void store.set(k, { ...store.get(k), ...d }),
  set: async (d: Record<string, unknown>) => void store.set(k, { ...store.get(k), ...d }),
});
const notices: string[] = [];
const confirmations: string[] = [];
const added: string[][] = [];

vi.mock("./firebase.ts", () => ({
  col: (uid: string, c: string) => ({
    doc: (id: string) => ref(key(uid, c, id)),
    where: (f: string, _o: string, v: unknown) => ({
      where: (f2: string, _o2: string, v2: unknown) => ({
        get: async () => ({ docs: [...store].filter(([k, d]) => k.startsWith(`${uid}/${c}/`) && d[f] === v && d[f2] === v2).map(([k, d]) => ({ id: k, data: () => d, ref: ref(k) })) }),
      }),
    }),
  }),
  db: {
    runTransaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        get: async (r: { get: () => Promise<unknown> }) => r.get(),
        update: (r: { update: (d: unknown) => void }, d: unknown) => r.update(d),
        set: (r: { set: (d: unknown) => void }, d: unknown) => r.set(d),
      }),
  },
}));
vi.mock("./commands.ts", () => ({
  notice: async (_u: string, _l: string, text: string) => void notices.push(text),
  sendConfirmation: async (_u: string, _c: unknown, _s: unknown, comic: { name: string }) => void confirmations.push(comic.name),
}));
const settings = { timezone: "Asia/Kolkata", confirm: {}, offers: { expiryHours: 6 } };
let show: Record<string, unknown>;
vi.mock("./userData.ts", () => ({ watchUser: () => ({ settings, shows: [show], venues: [] }) }));
vi.mock("./gemma.ts", () => ({ extractProfile: vi.fn() }));
vi.mock("./sendQueue.ts", () => ({ sendQueued: vi.fn() }));
vi.mock("./sendRich.ts", () => ({ sendRich: vi.fn() }));
vi.mock("./greet.ts", () => ({ greetFor: vi.fn() }));
vi.mock("./voice.ts", () => ({ inVoice: vi.fn() }));
vi.mock("./agentOutbox.ts", () => ({ agentOn: vi.fn(), readMemory: vi.fn(), sendMicCheck: vi.fn(), sendToCurator: vi.fn(), writeMemory: vi.fn() }));

const { addDirect } = await import("./replies.ts");
const U = "u1";
const client = { getChatById: async () => ({ addParticipants: async (ids: string[]) => void added.push(ids) }) } as never;
const lineup = (slots: string[], status = "draft") => store.set(key(U, "lineups", "w_mon"), { weekOf: "2026-10-26", showId: "mon", status, slots: slots.map((comicId) => ({ comicId })) });
const comic = (id: string, name: string, extra: Record<string, unknown> = {}) => store.set(key(U, "comics", id), { id, name, ...extra });
const slots = () => ((store.get(key(U, "lineups", "w_mon")) as { slots: { comicId: string; adhoc?: boolean }[] }).slots);

beforeEach(() => {
  store.clear();
  notices.length = 0;
  confirmations.length = 0;
  added.length = 0;
  // Monday 2026-10-26 is the show day for these tests; fake "today" to it.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T10:00:00+05:30"));
  show = { id: "mon", name: "Monday Mic", weekday: 1, slotCount: 3, groupId: "g@g.us", startTime: "20:00", includeSlotTime: false };
});

describe("addDirect (already agreed)", () => {
  it("puts one comic straight on the lineup: no offer, confirmation sent, group add, Updates entry", async () => {
    lineup(["a@c.us"]);
    comic("r@c.us", "Rahul");
    const r = await addDirect(U, client, "w_mon", ["r@c.us"]);
    expect(r.added).toBe(1);
    expect(slots().map((s) => s.comicId)).toEqual(["a@c.us", "r@c.us"]);
    expect(slots()[1].adhoc).toBe(true);
    expect(confirmations).toEqual(["Rahul"]);
    expect(added).toEqual([["r@c.us"]]);
    expect(notices).toEqual(["Added Rahul to Monday Mic directly"]);
    expect([...store.keys()].some((k) => k.includes("/offers/"))).toBe(false);
  });

  it("adds several, each told and grouped, with one Updates entry", async () => {
    lineup([]);
    comic("r@c.us", "Rahul");
    comic("p@c.us", "Priya");
    const r = await addDirect(U, client, "w_mon", ["r@c.us", "p@c.us"]);
    expect(r.added).toBe(2);
    expect(confirmations).toEqual(["Rahul", "Priya"]);
    expect(added).toEqual([["r@c.us"], ["p@c.us"]]);
    expect(notices).toEqual(["Added Rahul and Priya to Monday Mic directly"]);
  });

  it("is not held by the cooldown: someone who played last week goes straight on, and ad hoc stays out of cooldown", async () => {
    lineup([]);
    comic("r@c.us", "Rahul", { lastPerformedWeek: "2026-10-19", history: [{ date: "2026-10-19", showId: "mon", showName: "Monday Mic", status: "confirmed" }] });
    await addDirect(U, client, "w_mon", ["r@c.us"]);
    expect(slots().map((s) => s.comicId)).toEqual(["r@c.us"]);
    const c = store.get(key(U, "comics", "r@c.us")) as { lastPerformedWeek: string; history: { adhoc?: boolean }[] };
    expect(c.lastPerformedWeek).toBe("2026-10-19");
    expect(c.history[0].adhoc).toBe(true);
  });

  it("does not add the same comic twice, and doesn't re-tell them", async () => {
    lineup(["r@c.us"]);
    comic("r@c.us", "Rahul");
    const r = await addDirect(U, client, "w_mon", ["r@c.us"]);
    expect(r).toMatchObject({ added: 0, already: 1 });
    expect(confirmations).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("expires an offer still waiting on them", async () => {
    lineup([]);
    comic("r@c.us", "Rahul");
    store.set(key(U, "offers", "o1"), { comicId: "r@c.us", status: "pending" });
    await addDirect(U, client, "w_mon", ["r@c.us"]);
    expect(store.get(key(U, "offers", "o1"))?.status).toBe("expired");
  });

  it("goes over the show's slot count (the sheet warns) but refuses a called-off show", async () => {
    lineup(["a@c.us", "b@c.us", "c@c.us"]);
    comic("r@c.us", "Rahul");
    expect((await addDirect(U, client, "w_mon", ["r@c.us"])).added).toBe(1);
    lineup([], "cancelled");
    await expect(addDirect(U, client, "w_mon", ["r@c.us"])).rejects.toThrow(/called off/);
  });

  it("skips the group add when the show is not today, like a booked offer", async () => {
    lineup([]);
    comic("r@c.us", "Rahul");
    vi.setSystemTime(new Date("2026-10-23T10:00:00+05:30"));
    await addDirect(U, client, "w_mon", ["r@c.us"]);
    expect(confirmations).toEqual(["Rahul"]);
    expect(added).toEqual([]);
  });
});
