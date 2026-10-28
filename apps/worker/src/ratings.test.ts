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
vi.mock("./commands.ts", () => ({ notice: async (_u: string, _l: string, t: string) => void notices.push(t), sendConfirmation: vi.fn(), loadComics: async (u: string, ids: string[]) => new Map(ids.map((id) => [id, store.get(`${u}/comics/${id}`)]).filter(([, v]) => v) as [string, unknown][]) }));
vi.mock("./userData.ts", () => ({
  settingsFromDoc: (d: unknown) => d,
  watchUser: () => ({ settings: { timezone: "Asia/Kolkata", micCheck: { enabled: true, time: "09:00", whatsapp: false, afterHours: 2, rate: true }, confirm: {} }, shows: [{ id: "mon", name: "Monday Mic", slotCount: 3, weekday: 1, startTime: "20:00" }], venues: [] }),
}));
vi.mock("./gemma.ts", () => ({ extractProfile: vi.fn() }));
vi.mock("./sendRich.ts", () => ({ sendRich: vi.fn() }));
vi.mock("./greet.ts", () => ({ greetFor: async () => "Rohan" }));
vi.mock("./voice.ts", () => ({ inVoice: vi.fn() }));
vi.mock("./people.ts", () => ({ listGroupMembers: vi.fn() }));
vi.mock("./reconcile.ts", () => ({}));
vi.mock("./sessions.ts", () => ({ sessions: { healthy: () => true, stableMs: () => 1e9, noteWaError: () => undefined } }));

const { sendMicChecks } = await import("./replies.ts");
const { askRatings, answerRatings } = await import("./ratings.ts");
const { readMemory } = await import("./agentOutbox.ts");

let n = 0;
let U = "u0";
const setup = (state: typeof agent) => {
  agent = state;
  U = `u${++n}`;
  store.set(`${U}/user`, { settings: { agent: { enabled: true, notify: true, agentPolls: false } } });
  store.set(`${U}/session/state`, { phone: "919800000001" });
  for (const [id, name] of [["a@c.us", "Asha Rao"], ["b@c.us", "Bo"], ["c@c.us", "Chitra"]]) store.set(`${U}/comics/${id}`, { id, name, history: [{ date: "2026-10-26", showId: "mon", showName: "Monday Mic", status: "confirmed" }] });
};
const lineup = (o: Record<string, unknown> = {}) => store.set(`${U}/lineups/m1`, { id: "m1", weekOf: "2026-10-26", showId: "mon", date: "2026-10-26", status: "confirmed", slots: [{ comicId: "a@c.us" }, { comicId: "b@c.us" }, { comicId: "c@c.us" }], ...o });
const doc = () => store.get(`${U}/lineups/m1`) as { micCheckSentOn?: string; slots: { comicId: string; rating?: number }[]; ratingAskedOn?: string; ratingsSkipped?: boolean; reviewAskedOn?: string | null; review?: { rating?: number; notes?: string; at: number } | null };
const at = (iso: string) => vi.setSystemTime(new Date(iso));

beforeEach(() => {
  store.clear();
  sent.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-10-26T21:00:00+05:30");
});

describe("the mic check is asked 2 hours after the start", () => {
  it("not before: the show starts 20:00, so nothing at 21:59", async () => {
    setup("on");
    lineup();
    at("2026-10-26T21:59:00+05:30");
    await sendMicChecks(U, undefined);
    expect(doc().micCheckSentOn).toBeUndefined();
    expect(sent).toHaveLength(0);
  });
  it("at 22:00 it asks once on the agent number", async () => {
    setup("on");
    lineup();
    at("2026-10-26T22:00:00+05:30");
    await sendMicChecks(U, undefined);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/Did \*Monday Mic\*/);
    await sendMicChecks(U, undefined);
    expect(sent).toHaveLength(1);
  });
  it("with the agent off nothing is sent, but it is marked so the app's pending card (derived from the lineup) is all that is left", async () => {
    setup("off");
    lineup();
    at("2026-10-26T23:00:00+05:30");
    await sendMicChecks(U, undefined);
    expect(sent).toHaveLength(0);
    expect(doc().micCheckSentOn).toBe("2026-10-26");
  });
});

describe("rating the lineup", () => {
  it("asks once, listing the lineup, after a yes", async () => {
    setup("on");
    lineup({ outcome: "happened" });
    await askRatings(U);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("1. Asha Rao");
    expect(sent[0]).toContain("3. Chitra");
    expect(doc().ratingAskedOn).toBe("2026-10-26");
    await askRatings(U);
    expect(sent).toHaveLength(1);
    expect((await readMemory(U)).ratingAsk?.lineupId).toBe("m1");
  });
  it("does nothing when the agent isn't linked, or the show wasn't confirmed as happened", async () => {
    setup("off");
    lineup({ outcome: "happened" });
    await askRatings(U);
    expect(sent).toHaveLength(0);
    expect(doc().ratingAskedOn).toBeUndefined();
    setup("on");
    lineup();
    await askRatings(U);
    expect(sent).toHaveLength(0);
  });
  it("a failed send leaves it to be asked again", async () => {
    setup("failing");
    lineup({ outcome: "happened" });
    await askRatings(U).catch(() => undefined);
    expect(doc().ratingAskedOn ?? null).toBeNull();
  });
  it("'1 4, 2 5' rates two comics on the slots and in their histories; the third stays to be rated", async () => {
    setup("on");
    lineup({ outcome: "happened" });
    await askRatings(U);
    const reply = await answerRatings(U, "1 4, 2 5");
    expect(reply).toMatch(/Saved: Asha Rao 4\/5, Bo 5\/5\. Still to rate: 3\. Chitra/);
    expect(doc().slots.map((s) => s.rating)).toEqual([4, 5, undefined]);
    expect((store.get(`${U}/comics/a@c.us`) as { history: { rating?: number }[] }).history[0]!.rating).toBe(4);
    expect((store.get(`${U}/comics/c@c.us`) as { history: { rating?: number }[] }).history[0]!.rating).toBeUndefined();
    expect((await readMemory(U)).ratingAsk).toBeTruthy();
    // the rest, in order for whoever is left
    expect(await answerRatings(U, "3")).toMatch(/That's everyone/);
    expect(doc().slots.map((s) => s.rating)).toEqual([4, 5, 3]);
    expect((await readMemory(U)).ratingAsk).toBeNull();
  });
  it("things that aren't ratings fall through to the rest of the agent", async () => {
    setup("on");
    lineup({ outcome: "happened" });
    await askRatings(U);
    expect(await answerRatings(U, "add Rohan to Tuesday")).toBeNull();
    expect(await answerRatings(U, "yes")).toBeNull();
    expect(doc().slots.every((s) => s.rating === undefined)).toBe(true);
  });
  it("skip stops it for good", async () => {
    setup("on");
    lineup({ outcome: "happened" });
    await askRatings(U);
    expect(await answerRatings(U, "skip")).toMatch(/in the app/);
    expect(doc().ratingsSkipped).toBe(true);
    expect((await readMemory(U)).ratingAsk).toBeNull();
    expect(await answerRatings(U, "1 4")).toBeNull();
  });
  it("a late reply, after the question expired, is not read as ratings", async () => {
    setup("on");
    lineup({ outcome: "happened" });
    await askRatings(U);
    at("2026-10-28T12:00:00+05:30");
    expect(await answerRatings(U, "1 4")).toBeNull();
  });
  it("nothing is waiting: nothing is read", async () => {
    setup("on");
    lineup({ outcome: "happened" });
    expect(await answerRatings(U, "1 4")).toBeNull();
  });
});

describe("how was the show overall?", () => {
  it("after the last comic is rated, the same reply asks once", async () => {
    setup("on");
    lineup({ outcome: "happened" });
    await askRatings(U);
    const reply = await answerRatings(U, "all 4");
    expect(reply).toMatch(/That's everyone/);
    expect(reply).toContain("How was *Monday Mic* overall?");
    expect(doc().reviewAskedOn).toBe("2026-10-26");
    expect((await readMemory(U)).reviewAsk?.lineupId).toBe("m1");
    expect((await readMemory(U)).ratingAsk).toBeNull();
    // not asked again by the ticker
    await askRatings(U);
    expect(sent).toHaveLength(1);
  });
  it("'4 great crowd, sound was bad' saves the rating and the notes on the lineup", async () => {
    setup("on");
    lineup({ outcome: "happened" });
    await askRatings(U);
    await answerRatings(U, "all 4");
    const reply = await answerRatings(U, "4 great crowd, sound was bad");
    expect(reply).toMatch(/Saved the show review: 4\/5, "great crowd, sound was bad"/);
    expect(doc().review).toMatchObject({ rating: 4, notes: "great crowd, sound was bad" });
    expect((await readMemory(U)).reviewAsk).toBeNull();
    expect(await answerRatings(U, "5")).toBeNull();
  });
  it("skip leaves it, and an ordinary message is not read as the review", async () => {
    setup("on");
    lineup({ outcome: "happened" });
    await askRatings(U);
    await answerRatings(U, "all 3");
    expect(await answerRatings(U, "add Rohan to Tuesday")).toBeNull();
    expect(await answerRatings(U, "great crowd")).toBeNull();
    expect(doc().review).toBeUndefined();
    expect(await answerRatings(U, "skip")).toMatch(/leave the show review/);
    expect(doc().review).toBeUndefined();
    expect((await readMemory(U)).reviewAsk).toBeNull();
  });
  it("skipping the comics' ratings skips the overall question too", async () => {
    setup("on");
    lineup({ outcome: "happened" });
    await askRatings(U);
    await answerRatings(U, "skip");
    expect((await readMemory(U)).reviewAsk ?? null).toBeNull();
    expect(doc().reviewAskedOn).toBeUndefined();
  });
  it("when every comic was already rated in the app, the ticker asks only the overall question", async () => {
    setup("on");
    lineup({ outcome: "happened", slots: [{ comicId: "a@c.us", rating: 4 }, { comicId: "b@c.us", rating: 5 }] });
    await askRatings(U);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("overall");
    expect(sent[0]).not.toContain("Asha");
    expect(await answerRatings(U, "5 killer night")).toMatch(/Saved the show review: 5\/5/);
    expect(doc().review?.rating).toBe(5);
  });
  it("a failed send is asked again, and a review already written is never asked about", async () => {
    setup("failing");
    lineup({ outcome: "happened", slots: [{ comicId: "a@c.us", rating: 4 }] });
    await askRatings(U).catch(() => undefined);
    expect(doc().reviewAskedOn ?? null).toBeNull();
    setup("on");
    lineup({ outcome: "happened", slots: [{ comicId: "a@c.us", rating: 4 }], review: { rating: 3, at: 1 } });
    await askRatings(U);
    expect(sent).toHaveLength(0);
  });
});

describe("attendance by text", () => {
  it("'2 no show, 1 4' marks Bo and rates Asha; a no-show is not asked a rating", async () => {
    setup("on");
    lineup({ outcome: "happened" });
    await askRatings(U);
    expect(sent[0]).toContain("2 no show");
    const reply = await answerRatings(U, "2 no show, 1 4");
    expect(reply).toMatch(/Saved: Asha Rao 4\/5\. Marked: Bo no-show\. Still to rate: 3\. Chitra/);
    const slots = doc().slots as { attendance?: string; rating?: number }[];
    expect(slots[1]).toMatchObject({ attendance: "no_show" });
    expect((store.get(`${U}/comics/b@c.us`) as { history: { attendance?: string }[] }).history[0]!.attendance).toBe("no_show");
    expect(await answerRatings(U, "3 late")).toMatch(/Marked: Chitra late/);
    expect(await answerRatings(U, "3 4")).toMatch(/Saved: Chitra 4\/5/);
  });
  it("only no-shows left means everyone is done and the overall question follows", async () => {
    setup("on");
    lineup({ outcome: "happened", slots: [{ comicId: "a@c.us", rating: 5 }, { comicId: "b@c.us" }] });
    await askRatings(U);
    const reply = await answerRatings(U, "2 no show");
    expect(reply).toMatch(/That's everyone/);
    expect(reply).toContain("overall");
  });
  it("tags are not read from WhatsApp", async () => {
    setup("on");
    lineup({ outcome: "happened" });
    await askRatings(U);
    expect(await answerRatings(U, "1 killed")).toBeNull();
  });
});
