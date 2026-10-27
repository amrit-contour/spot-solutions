import { beforeEach, describe, expect, it, vi } from "vitest";

// Every question the agent asks the curator also lives in the app's Updates (state in Firestore, written first), whether the
// agent is on, off or failing; and answering in either place settles both. In-memory Firestore + a fake agent number.
const store = new Map<string, Record<string, unknown>>();
const getPath = (d: Record<string, unknown>, f: string) => f.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], d);
const ref = (k: string) => ({
  id: k.split("/").pop()!,
  get: async () => ({ data: () => store.get(k) }),
  update: async (d: Record<string, unknown>) => void store.set(k, { ...store.get(k), ...d }),
  set: async (d: Record<string, unknown>) => void store.set(k, { ...store.get(k), ...d }),
});
const query = (prefix: string, filters: [string, string, unknown][] = [], max = Infinity) => ({
  where: (f: string, op: string, v: unknown) => query(prefix, [...filters, [f, op, v]], max),
  limit: (n: number) => query(prefix, filters, n),
  get: async () => ({
    docs: [...store]
      .filter(([k, d]) => k.startsWith(prefix) && filters.every(([f, op, v]) => (op === "==" ? getPath(d, f) === v : op === "!=" ? getPath(d, f) !== v : String(getPath(d, f) ?? "") >= String(v))))
      .slice(0, max)
      .map(([k, d]) => ({ id: k.split("/").pop()!, data: () => d, ref: ref(k) })),
  }),
});
vi.mock("./firebase.ts", () => ({
  col: (uid: string, c: string) => ({ doc: (id: string) => ref(`${uid}/${c}/${id}`), ...query(`${uid}/${c}/`) }),
  userRef: (uid: string) => ({ get: async () => ({ data: () => store.get(`${uid}/user`) }) }),
  sessionRef: (uid: string) => ref(`${uid}/session/state`),
  db: { runTransaction: async (fn: (tx: unknown) => unknown) => fn({ get: (r: { get: () => unknown }) => r.get(), update: (r: { update: (d: unknown) => void }, d: unknown) => r.update(d), set: (r: { set: (d: unknown) => void }, d: unknown) => r.set(d) }) },
}));

// The fake agent number: absent (not linked), or linked and sending, or linked but every send fails.
let agent: "on" | "off" | "failing" = "on";
const sent: string[] = [];
vi.mock("./agentSession.ts", () => ({
  agentRef: (uid: string) => ref(`${uid}/session/agent`),
  agentSessions: { get: () => (agent === "off" ? null : { fake: true }) },
}));
vi.mock("./sendQueue.ts", () => ({
  sendQueued: async (_c: unknown, to: string, text: string) => {
    if (to.includes("@c.us") && agent === "failing") throw new Error("agent send failed");
    sent.push(text);
  },
}));
const notices: string[] = [];
vi.mock("./commands.ts", () => ({ notice: async (_u: string, _l: string, t: string) => void notices.push(t), sendConfirmation: vi.fn() }));
vi.mock("./userData.ts", () => ({
  settingsFromDoc: (d: unknown) => d,
  watchUser: () => ({ settings: { timezone: "Asia/Kolkata", micCheck: { enabled: true, time: "09:00", whatsapp: false }, confirm: {} }, shows: [{ id: "mon", name: "Monday Mic", slotCount: 3, weekday: 1 }], venues: [] }),
}));
vi.mock("./gemma.ts", () => ({ extractProfile: vi.fn() }));
vi.mock("./sendRich.ts", () => ({ sendRich: vi.fn() }));
vi.mock("./greet.ts", () => ({ greetFor: async () => "Rohan" }));
vi.mock("./voice.ts", () => ({ inVoice: vi.fn() }));
vi.mock("./people.ts", () => ({ listGroupMembers: vi.fn() }));
vi.mock("./reconcile.ts", () => ({}));
vi.mock("./sessions.ts", () => ({ sessions: { healthy: () => true, stableMs: () => 1e9, noteWaError: () => undefined } }));

const { ask, keepGroup } = await import("./groupCleanup.ts");
const { sendMicChecks, handleOfferReply } = await import("./replies.ts");
const { resolvedInApp, readMemory } = await import("./agentOutbox.ts");

let n = 0;
let U = "u0";
const setup = (state: typeof agent, agentEnabled = true) => {
  agent = state;
  U = `u${++n}`; // settings are cached per account
  store.set(`${U}/user`, { settings: { agent: { enabled: agentEnabled, notify: true } } });
  store.set(`${U}/session/state`, { phone: "919800000001" });
};
const show = { id: "mon", name: "Monday Mic" } as never;
const lineupDoc = () => store.get(`${U}/lineups/l1`) as Record<string, unknown>;
const pending = async () => (await readMemory(U)).pending;

beforeEach(() => {
  store.clear();
  sent.length = 0;
  notices.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T12:00:00+05:30"));
});

describe("day-after cleanup ask", () => {
  const lineup = () => {
    store.set(`${U}/lineups/l1`, { id: "l1", weekOf: "2026-10-26", showId: "mon", date: "2026-10-26", status: "confirmed", slots: [] });
    return { ...lineupDoc(), id: "l1" } as never;
  };

  it("agent on: the Updates card state is written, the agent asks, and its yes/no is remembered", async () => {
    setup("on");
    await ask(U, show, lineup());
    expect((lineupDoc().cleanup as { status: string }).status).toBe("asked");
    expect(sent).toHaveLength(1);
    expect((await pending())?.stage).toBe("confirm");
  });
  it("agent not linked: the Updates card still stands, nothing is sent", async () => {
    setup("off");
    await ask(U, show, lineup());
    expect((lineupDoc().cleanup as { status: string }).status).toBe("asked");
    expect(sent).toHaveLength(0);
    expect(await pending()).toBeUndefined();
  });
  it("agent switched off in Settings: the same", async () => {
    setup("on", false);
    await ask(U, show, lineup());
    expect((lineupDoc().cleanup as { status: string }).status).toBe("asked");
    expect(sent).toHaveLength(0);
  });
  it("agent send fails: no error, the Updates card stands, nothing is left pending", async () => {
    setup("failing");
    await expect(ask(U, show, lineup())).resolves.toBeUndefined();
    expect((lineupDoc().cleanup as { status: string }).status).toBe("asked");
    expect(await pending()).toBeUndefined();
  });
  it("answered on the agent (keep): the Updates card is resolved, same document", async () => {
    setup("on");
    await ask(U, show, lineup());
    await keepGroup(U, "l1");
    expect((lineupDoc().cleanup as { status: string }).status).toBe("kept");
  });
  it("answered in the app: the agent's pending question is cleared and it is told, only if it was waiting", async () => {
    setup("on");
    await ask(U, show, lineup());
    sent.length = 0;
    expect(await resolvedInApp(U, (p) => p.type === "cleanup" && p.lineupId === "l1")).toBe(true);
    expect(await pending()).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/Done in the app/);
    // Nothing waiting any more: a second answer says nothing.
    sent.length = 0;
    expect(await resolvedInApp(U, (p) => p.type === "cleanup" && p.lineupId === "l1")).toBe(false);
    expect(sent).toHaveLength(0);
  });
  it("answered in the app while the agent waits on something else: that question is left alone", async () => {
    setup("on");
    await ask(U, show, lineup());
    sent.length = 0;
    expect(await resolvedInApp(U, (p) => p.type === "cleanup" && p.lineupId === "other")).toBe(false);
    expect((await pending())?.stage).toBe("confirm");
    expect(sent).toHaveLength(0);
  });
  it("answered in the app with the agent off: pending cleared quietly, nothing sent", async () => {
    setup("on");
    await ask(U, show, lineup());
    agent = "off";
    sent.length = 0;
    expect(await resolvedInApp(U, (p) => p.type === "cleanup")).toBe(true);
    expect(sent).toHaveLength(0);
  });
  it("never talks over another question the agent is waiting on", async () => {
    setup("on");
    store.set(`${U}/session/agent`, { pending: { stage: "confirm", plan: { type: "retime", showId: "mon", startTime: "20:00" }, summary: "x", createdAt: Date.now(), expiresAt: Date.now() + 60_000 } });
    await ask(U, show, lineup());
    expect(sent).toHaveLength(0);
    expect((lineupDoc().cleanup as { status: string }).status).toBe("asked");
  });
});

describe("mic check", () => {
  const confirmed = () => store.set(`${U}/lineups/m1`, { showId: "mon", status: "confirmed", date: "2026-10-26", slots: [] });
  const marked = () => (store.get(`${U}/lineups/m1`) as { micCheckSentOn?: string }).micCheckSentOn;

  it("agent on: asked there; the app's card is the lineup itself (confirmed, past, no outcome)", async () => {
    setup("on");
    confirmed();
    await sendMicChecks(U, undefined);
    expect(marked()).toBe("2026-10-27");
    expect(sent[0]).toMatch(/Did \*Monday Mic\*/);
    expect((store.get(`${U}/lineups/m1`) as { outcome?: string }).outcome).toBeUndefined();
  });
  it("agent off, and no main WhatsApp either: nothing is sent and nothing breaks; the app still shows it", async () => {
    setup("off");
    confirmed();
    await expect(sendMicChecks(U, undefined)).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
    expect(marked()).toBe("2026-10-27");
  });
  it("agent send fails: no error, the app's card is untouched", async () => {
    setup("failing");
    confirmed();
    await expect(sendMicChecks(U, undefined)).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
    expect((store.get(`${U}/lineups/m1`) as { outcome?: string }).outcome).toBeUndefined();
  });
});

describe("ad hoc round needing a pick", () => {
  const round = { id: "r1", size: 2, slots: 1, autoAdd: false };
  const offers = () => {
    store.set(`${U}/offers/o1`, { comicId: "a@c.us", comicName: "Asha", showId: "mon", lineupId: "l1", status: "pending", expiresAt: Date.now() + 3_600_000, round });
    store.set(`${U}/offers/o2`, { comicId: "b@c.us", comicName: "Bo", showId: "mon", lineupId: "l1", status: "pending", expiresAt: Date.now() + 3_600_000, round });
  };
  const client = {} as never;

  it("agent on: the yes goes to Updates (offer 'interested' + a notice) and the agent asks to add them", async () => {
    setup("on");
    offers();
    await handleOfferReply(U, client, "a@c.us", ["yes"]);
    expect((store.get(`${U}/offers/o1`) as { status: string }).status).toBe("interested");
    expect(notices.join()).toMatch(/Pick who gets it in Updates/);
    expect(sent[0]).toMatch(/Add them to the lineup/);
    expect((await pending())?.stage).toBe("confirm");
  });
  it("agent off or failing: still in Updates, no error", async () => {
    for (const state of ["off", "failing"] as const) {
      setup(state);
      offers();
      await expect(handleOfferReply(U, client, "a@c.us", ["yes"])).resolves.toBe(true);
      expect((store.get(`${U}/offers/o1`) as { status: string }).status).toBe("interested");
      expect(await pending()).toBeUndefined();
    }
  });
  it("picked in the app: the agent's 'add them?' is cleared", async () => {
    setup("on");
    offers();
    await handleOfferReply(U, client, "a@c.us", ["yes"]);
    sent.length = 0;
    expect(await resolvedInApp(U, (p) => p.type === "adhoc_pick" && p.roundId === "r1")).toBe(true);
    expect(await pending()).toBeNull();
    expect(sent[0]).toMatch(/Done in the app/);
  });
});
