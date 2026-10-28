import { beforeEach, describe, expect, it, vi } from "vitest";
import { MIRROR_GROUP_MS, confirmPending, mirrorKey } from "@spot/shared";

// The two-way mirror between the agent's questions and the app's Updates: what is remembered, what the app answering does on
// WhatsApp (a ✅ and ONE quoted reply, grouped), what answering on WhatsApp must NOT echo, and a late vote that disagrees.
// In-memory Firestore and a fake agent number that records reactions and quoted replies.
const store = new Map<string, Record<string, unknown>>();
const getPath = (d: Record<string, unknown>, f: string) => f.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], d);
const ref = (k: string) => ({
  id: k.split("/").pop()!,
  get: async () => ({ data: () => store.get(k) }),
  update: async (d: Record<string, unknown>) => void store.set(k, { ...store.get(k), ...d }),
  set: async (d: Record<string, unknown>) => void store.set(k, { ...store.get(k), ...d }),
});
const query = (prefix: string, filters: [string, string, unknown][] = []) => ({
  where: (f: string, op: string, v: unknown) => query(prefix, [...filters, [f, op, v]]),
  get: async () => ({ docs: [...store].filter(([k, d]) => k.startsWith(prefix) && filters.every(([f, , v]) => getPath(d, f) === v)).map(([k, d]) => ({ id: k.split("/").pop()!, data: () => d, ref: ref(k) })) }),
});
vi.mock("./firebase.ts", () => ({
  col: (uid: string, c: string) => ({ doc: (id: string) => ref(`${uid}/${c}/${id}`), ...query(`${uid}/${c}/`) }),
  userRef: (uid: string) => ({ get: async () => ({ data: () => store.get(`${uid}/user`) }) }),
  sessionRef: (uid: string) => ref(`${uid}/session/state`),
}));

const reacts: [string, string][] = [];
const replies: [string, string][] = [];
let msgGone = false;
const client = {
  getMessageById: async (id: string) => (msgGone ? null : { id: { _serialized: id }, react: async (e: string) => void reacts.push([id, e]), reply: async (t: string) => void replies.push([id, t]) }),
};
vi.mock("./agentSession.ts", () => ({
  agentRef: (uid: string) => ref(`${uid}/session/agent`),
  agentSessions: { get: () => client },
}));
const plain: string[] = [];
let polls = 0;
vi.mock("./sendQueue.ts", () => ({
  sendQueued: async (_c: unknown, _to: string, text: string) => (plain.push(text), { id: { _serialized: `text${plain.length}` } }),
  deliverableId: async (_c: unknown, to: string) => to,
  enqueueTask: async (_c: unknown, task: () => unknown) => task(),
  sendContent: async () => ({ id: { _serialized: `poll${++polls}` } }),
}));
vi.mock("./userData.ts", () => ({ settingsFromDoc: (d: unknown) => d }));

const { sendMicCheck, askCurator, readMemory, writeMemory, queueNotify, flushNotify, rememberRatingPolls, resolvedInApp, forgetSettings } = await import("./agentOutbox.ts");
const { mirrorTick } = await import("./agentMirrorTick.ts");
const { applyVote, applyChange } = await import("./agentPolls.ts");
const { claimOnWhatsApp, readAsks, dismissForwarded, mutateAsks } = await import("./agentMirror.ts");

let n = 0;
let U = "";
let clock = 0;
const lineup = (id: string, extra: Record<string, unknown> = {}) => store.set(`${U}/lineups/${id}`, { showId: "mon", status: "confirmed", slots: [], ...extra });
const patch = (path: string, d: Record<string, unknown>) => store.set(path, { ...store.get(path), ...d });
const pass = (ms: number) => vi.setSystemTime(Date.now() + ms);
const mic = (id: string, label = "Monday Mic") => sendMicCheck(U, `🎤 Did *${label}* happen? Reply *yes* or *no* here.`, { lineupId: id, label });

beforeEach(() => {
  store.clear();
  reacts.length = 0;
  replies.length = 0;
  plain.length = 0;
  polls = 0;
  msgGone = false;
  U = `u${++n}`;
  store.set(`${U}/user`, { settings: { agent: { enabled: true, notify: true } } });
  store.set(`${U}/session/state`, { phone: "919800000001" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T12:00:00+05:30").getTime() + ++clock * 1000);
});

const deps = (said: string[] = [], answers: [string, string][] = [], extra: Record<string, unknown> = {}) => ({
  readMemory: () => readMemory(U),
  writeMemory: (p: Record<string, unknown>) => writeMemory(U, p),
  say: async (t: string) => void said.push(t),
  now: () => Date.now(),
  answer: async (k: string, t: string) => void answers.push([k, t]),
  claim: (id: string) => claimOnWhatsApp(U, (a) => a.msgId === id),
  ...extra,
});

describe("mapping keys", () => {
  it("a mic check is remembered by its poll id under mic:<lineup>, and the poll knows its lineup", async () => {
    lineup("w1_mon");
    expect(await mic("w1_mon")).toBe(true);
    const mem = await readMemory(U);
    expect(mem.asks).toEqual([expect.objectContaining({ key: "mic:w1_mon", msgId: "poll1", kind: "mic", lineupId: "w1_mon", label: "Monday Mic" })]);
    expect(mem.polls?.[0]).toMatchObject({ id: "poll1", kind: "mic", lineupId: "w1_mon" });
  });
  it("asking the same thing again replaces the entry instead of piling up", async () => {
    lineup("w1_mon");
    await mic("w1_mon");
    await mic("w1_mon");
    expect((await readAsks(U)).map((a) => a.msgId)).toEqual(["poll2"]);
  });
  it("rating polls: per comic, overall and repeat each get their own stable key; 'why' has no app counterpart", async () => {
    await rememberRatingPolls(U, [
      { id: "p1", lineupId: "L", comicId: "c1", at: Date.now(), label: "Rohan" },
      { id: "p2", lineupId: "L", comicId: null, at: Date.now() },
      { id: "p3", kind: "repeat", lineupId: "L", comicId: null, at: Date.now() },
      { id: "p4", kind: "why", lineupId: "L", comicId: null, at: Date.now() },
    ]);
    expect((await readAsks(U)).map((a) => a.key)).toEqual([mirrorKey.rate("L", "c1"), mirrorKey.overall("L"), mirrorKey.repeat("L")]);
  });
  it("forwarded notices: one notice is keyed by its id, several by the message", async () => {
    queueNotify(U, { kind: "notice", text: "Ana passed", ref: { c: "notices", id: "n1" } });
    await flushNotify(U, true);
    queueNotify(U, { kind: "notice", text: "A", ref: { c: "notices", id: "n2" } });
    queueNotify(U, { kind: "warn", text: "B", ref: { c: "notices", id: "n3" } });
    await flushNotify(U, true);
    expect((await readAsks(U)).map((a) => a.key)).toEqual(["notices:n1", "batch:text2"]);
  });
});

describe("app to WhatsApp", () => {
  it("answering the mic check in the app reacts ✅ and sends one quoted reply, a minute later", async () => {
    lineup("w1_mon");
    await mic("w1_mon");
    await mirrorTick(U);
    expect(reacts).toEqual([]); // nothing answered yet
    patch(`${U}/lineups/w1_mon`, { outcome: "happened" }); // the app's "Yes, it happened"
    await mirrorTick(U);
    expect(reacts).toEqual([["poll1", "✅"]]);
    expect(replies).toEqual([]); // held for the group window
    pass(MIRROR_GROUP_MS + 1000);
    await mirrorTick(U);
    expect(replies).toEqual([["poll1", "Done in the app: marked happened ✓"]]);
    await mirrorTick(U);
    pass(10 * MIRROR_GROUP_MS);
    await mirrorTick(U);
    expect(reacts).toHaveLength(1);
    expect(replies).toHaveLength(1);
  });
  it("several answered within the window share ONE reply that lists each", async () => {
    lineup("w1_mon");
    lineup("w1_tue");
    await mic("w1_mon", "Monday Mic");
    await mic("w1_tue", "Tuesday Mic");
    patch(`${U}/lineups/w1_mon`, { outcome: "happened" });
    await mirrorTick(U);
    pass(20_000);
    patch(`${U}/lineups/w1_tue`, { outcome: "canned" });
    await mirrorTick(U);
    pass(MIRROR_GROUP_MS);
    await mirrorTick(U);
    expect(reacts.map((r) => r[0]).sort()).toEqual(["poll1", "poll2"]);
    expect(replies).toHaveLength(1);
    expect(replies[0]![0]).toBe("poll2"); // quotes the newest
    expect(replies[0]![1]).toBe("Handled in the app ✓\n• Monday Mic: marked happened\n• Tuesday Mic: marked didn't happen");
  });
  it("an answer a minute after the first goes in a second reply", async () => {
    lineup("w1_mon");
    lineup("w1_tue");
    await mic("w1_mon");
    await mic("w1_tue", "Tuesday Mic");
    patch(`${U}/lineups/w1_mon`, { outcome: "happened" });
    await mirrorTick(U);
    pass(MIRROR_GROUP_MS + 1000);
    await mirrorTick(U);
    patch(`${U}/lineups/w1_tue`, { outcome: "happened" });
    await mirrorTick(U);
    pass(MIRROR_GROUP_MS + 1000);
    await mirrorTick(U);
    expect(replies.map((r) => r[1])).toEqual(["Done in the app: marked happened ✓", "Done in the app: marked happened ✓"]);
  });
  it("a rating given in the app reacts to that comic's poll", async () => {
    lineup("L", { slots: [{ comicId: "c1", minutes: null }, { comicId: "c2", minutes: null }] });
    await rememberRatingPolls(U, [{ id: "p1", lineupId: "L", comicId: "c1", at: Date.now(), label: "Rohan" }, { id: "p2", lineupId: "L", comicId: "c2", at: Date.now(), label: "Ana" }]);
    patch(`${U}/lineups/L`, { slots: [{ comicId: "c1", minutes: null, rating: 4 }, { comicId: "c2", minutes: null }] });
    await mirrorTick(U);
    pass(MIRROR_GROUP_MS + 1);
    await mirrorTick(U);
    expect(reacts).toEqual([["p1", "✅"]]);
    expect(replies).toEqual([["p1", "Done in the app: rated 4 ✓"]]);
  });
  it("the repeat-next-week switch in the app answers the repeat poll", async () => {
    lineup("L", { outcome: "canned" });
    await rememberRatingPolls(U, [{ id: "p3", kind: "repeat", lineupId: "L", comicId: null, at: Date.now() }]);
    patch(`${U}/lineups/L`, { repeatNext: true });
    await mirrorTick(U);
    pass(MIRROR_GROUP_MS + 1);
    await mirrorTick(U);
    expect(replies).toEqual([["p3", "Answered in the app: Repeat ✓"]]);
  });
  it("dismissing a forwarded notice in the app reacts to the message that carried it", async () => {
    store.set(`${U}/notices/n1`, { read: false });
    queueNotify(U, { kind: "notice", text: "Ana passed on the Monday spot", ref: { c: "notices", id: "n1" } });
    await flushNotify(U, true);
    await mirrorTick(U);
    expect(reacts).toEqual([]);
    patch(`${U}/notices/n1`, { read: true, dismissedAt: Date.now() });
    await mirrorTick(U);
    pass(MIRROR_GROUP_MS + 1);
    await mirrorTick(U);
    expect(reacts).toEqual([["text1", "✅"]]);
    expect(replies).toEqual([["text1", "Done in the app: dismissed ✓"]]);
  });
  it("a batch of notices reacts only when all of them are dismissed", async () => {
    store.set(`${U}/notices/n1`, { read: false });
    store.set(`${U}/notices/n2`, { read: false });
    queueNotify(U, { kind: "notice", text: "A", ref: { c: "notices", id: "n1" } });
    queueNotify(U, { kind: "notice", text: "B", ref: { c: "notices", id: "n2" } });
    await flushNotify(U, true);
    patch(`${U}/notices/n1`, { read: true });
    await mirrorTick(U);
    expect(reacts).toEqual([]);
    patch(`${U}/notices/n2`, { read: true });
    await mirrorTick(U);
    expect(reacts).toEqual([["text1", "✅"]]);
  });
  it("the group-cleanup question: answering in the app clears what the agent was waiting on, so a later yes can't act twice", async () => {
    lineup("L");
    const plan = { type: "cleanup", showId: "mon", lineupId: "L" } as const;
    expect(await askCurator(U, "🧹 Clear the group?", confirmPending(plan, "Clear the Monday Mic group?", Date.now()), "Monday Mic 2026-10-26")).toBe(true);
    expect((await readMemory(U)).pending).toMatchObject({ pollId: "poll1" });
    patch(`${U}/lineups/L`, { cleanup: { status: "kept", at: Date.now() } });
    await mirrorTick(U);
    expect((await readMemory(U)).pending).toBeNull();
    pass(MIRROR_GROUP_MS + 1);
    await mirrorTick(U);
    expect(reacts).toEqual([["poll1", "✅"]]);
    expect(replies).toEqual([["poll1", "Done in the app: kept everyone ✓"]]);
  });
  it("when the original message can't be found the reply is plain text, and nothing throws", async () => {
    lineup("w1_mon");
    await mic("w1_mon");
    patch(`${U}/lineups/w1_mon`, { outcome: "happened" });
    msgGone = true;
    await mirrorTick(U);
    pass(MIRROR_GROUP_MS + 1);
    await mirrorTick(U);
    expect(reacts).toEqual([]);
    expect(plain.at(-1)).toBe("Done in the app: marked happened ✓");
  });
  it("nothing goes out when the agent is switched off", async () => {
    lineup("w1_mon");
    await mic("w1_mon");
    store.set(`${U}/user`, { settings: { agent: { enabled: false, notify: true } } });
    forgetSettings(U);
    patch(`${U}/lineups/w1_mon`, { outcome: "happened" });
    await mirrorTick(U);
    pass(MIRROR_GROUP_MS + 1);
    await mirrorTick(U);
    expect(reacts).toEqual([]);
    expect(replies).toEqual([]);
  });
});

describe("WhatsApp to the app, never echoed back", () => {
  it("a tap on the mic poll answers THAT show, and the app's resulting state change gets no reaction or reply", async () => {
    lineup("w1_mon");
    lineup("w1_tue");
    await mic("w1_mon");
    await mic("w1_tue", "Tuesday Mic");
    const answers: [string, string][] = [];
    expect(await applyVote(deps([], answers), "poll1", ["Yes"])).toBe("answered");
    expect(answers).toEqual([["mic", "yes"]]);
    patch(`${U}/lineups/w1_mon`, { outcome: "happened" }); // what the handler writes
    await mirrorTick(U);
    pass(MIRROR_GROUP_MS + 1);
    await mirrorTick(U);
    expect(reacts).toEqual([]);
    expect(replies).toEqual([]);
    // the other show's question is still open and still mirrored
    patch(`${U}/lineups/w1_tue`, { outcome: "canned" });
    await mirrorTick(U);
    expect(reacts).toEqual([["poll2", "✅"]]);
  });
  it("answering the group question on WhatsApp (resolvedInApp via whatsapp) is acknowledged in text only", async () => {
    lineup("L");
    const plan = { type: "cleanup", showId: "mon", lineupId: "L" } as const;
    await askCurator(U, "🧹 Clear?", confirmPending(plan, "Clear it?", Date.now()));
    await resolvedInApp(U, (p) => p.type === "cleanup", "Got it, everyone stays.", "whatsapp");
    patch(`${U}/lineups/L`, { cleanup: { status: "kept", at: Date.now() } });
    await mirrorTick(U);
    pass(MIRROR_GROUP_MS + 1);
    await mirrorTick(U);
    expect(reacts).toEqual([]);
    expect(replies).toEqual([]);
    expect(plain).toContain("Got it, everyone stays.");
  });
  it("resolvedInApp from the app stays quiet itself: the tick does the reaction and reply", async () => {
    lineup("L");
    const plan = { type: "cleanup", showId: "mon", lineupId: "L" } as const;
    await askCurator(U, "🧹 Clear?", confirmPending(plan, "Clear it?", Date.now()));
    expect(await resolvedInApp(U, (p) => p.type === "cleanup")).toBe(true);
    expect(plain).toEqual([]);
    expect((await readMemory(U)).pending).toBeNull();
  });
});

describe("a late vote after the app already answered", () => {
  const happenedInApp = async () => {
    lineup("w1_mon");
    await mic("w1_mon");
    patch(`${U}/lineups/w1_mon`, { outcome: "happened" });
    await mirrorTick(U);
  };
  it("the same answer does nothing", async () => {
    await happenedInApp();
    const said: string[] = [];
    const answers: [string, string][] = [];
    expect(await applyVote(deps(said, answers), "poll1", ["Yes"])).toBe("agreed");
    expect(said).toEqual([]);
    expect(answers).toEqual([]);
  });
  it("a different answer is not applied: it says what the app did and waits for 'change'", async () => {
    await happenedInApp();
    const said: string[] = [];
    const answers: [string, string][] = [];
    expect(await applyVote(deps(said, answers), "poll1", ["No"])).toBe("conflict");
    expect(said).toEqual(["Already marked happened in the app. Reply *change* to switch."]);
    expect(answers).toEqual([]);
    expect((await readMemory(U)).changeAsk).toMatchObject({ kind: "mic", lineupId: "w1_mon", to: "canned" });
  });
  it("a cleanup answered differently only informs (a cleared or kept group is changed in the app)", async () => {
    lineup("L");
    const plan = { type: "cleanup", showId: "mon", lineupId: "L" } as const;
    await askCurator(U, "🧹 Clear?", confirmPending(plan, "Clear it?", Date.now()));
    patch(`${U}/lineups/L`, { cleanup: { status: "kept", at: Date.now() } });
    await mirrorTick(U);
    const said: string[] = [];
    expect(await applyVote(deps(said), "poll1", ["Clear"])).toBe("conflict");
    expect(said).toEqual(["Already kept everyone in the app. Change it there if that's not what you meant."]);
    expect((await readMemory(U)).changeAsk ?? null).toBeNull();
  });
  it("a late repeat vote that disagrees asks first; 'Not decided' never overrides", async () => {
    lineup("L", { outcome: "canned" });
    await rememberRatingPolls(U, [{ id: "p3", kind: "repeat", lineupId: "L", comicId: null, at: Date.now() }]);
    patch(`${U}/lineups/L`, { repeatNext: true });
    await mirrorTick(U);
    const said: string[] = [];
    const repeated: string[] = [];
    const d = deps(said, [], { repeat: async (_l: string, c: string) => (repeated.push(c), null) });
    expect(await applyVote(d, "p3", ["Repeat"])).toBe("agreed");
    expect(await applyVote(d, "p3", ["Not decided"])).toBe("agreed");
    expect(await applyVote(d, "p3", ["Don't repeat"])).toBe("conflict");
    expect(said).toEqual(["Already Repeat in the app. Reply *change* to switch."]);
    expect(repeated).toEqual([]);
    expect((await readMemory(U)).changeAsk).toMatchObject({ kind: "repeat", to: "no" });
  });
  it("rating polls: a later vote just updates the rating, even after the app rated it", async () => {
    lineup("L", { slots: [{ comicId: "c1", minutes: null }] });
    await rememberRatingPolls(U, [{ id: "p1", lineupId: "L", comicId: "c1", at: Date.now() }]);
    patch(`${U}/lineups/L`, { slots: [{ comicId: "c1", minutes: null, rating: 4 }] });
    await mirrorTick(U);
    const said: string[] = [];
    const saved: unknown[] = [];
    const d = deps(said, [], { review: async (_l: string, c: string, r: unknown) => (saved.push([c, r]), true) });
    expect(await applyVote(d, "p1", ["⭐⭐⭐⭐⭐ Killed it"])).toBe("answered");
    expect(saved).toHaveLength(1);
    expect(said).toEqual([]);
  });
  it("a poll nobody answered in the app is applied as before (the vote is the answer)", async () => {
    lineup("w1_mon");
    await mic("w1_mon");
    const answers: [string, string][] = [];
    expect(await applyVote(deps([], answers), "poll1", ["No"])).toBe("answered");
    expect(answers).toEqual([["mic", "no"]]);
  });
});

describe("replying *change*", () => {
  const changeDeps = (said: string[], calls: string[]) => ({
    readMemory: () => readMemory(U),
    writeMemory: (p: Record<string, unknown>) => writeMemory(U, p),
    say: async (t: string) => void said.push(t),
    now: () => Date.now(),
    setOutcome: async (l: string, o: string) => void calls.push(`outcome ${l} ${o}`),
    setRepeat: async (l: string, c: string) => (calls.push(`repeat ${l} ${c}`), null),
    reclose: (key: string, result: string, what: string) => mutateAsks(U, (list, now) => list.map((a) => (a.key === key ? { ...a, closed: { by: "whatsapp" as const, at: now, result, what, verb: "Done" as const }, reacted: true, replied: true } : a))),
  });
  const conflict = async () => {
    lineup("w1_mon");
    await mic("w1_mon");
    patch(`${U}/lineups/w1_mon`, { outcome: "happened" });
    await mirrorTick(U);
    await applyVote(deps(), "poll1", ["No"]);
  };
  it("switches the show's answer, then a second late vote is judged against the new answer", async () => {
    await conflict();
    const said: string[] = [];
    const calls: string[] = [];
    expect(await applyChange(changeDeps(said, calls), "Change")).toBe(true);
    expect(calls).toEqual(["outcome w1_mon canned"]);
    expect(said).toEqual(["Switched: marked didn't happen ✓"]);
    expect((await readMemory(U)).changeAsk).toBeNull();
    expect(await applyVote(deps(), "poll1", ["No"])).toBe("agreed");
    expect(await applyChange(changeDeps([], calls), "change")).toBe(false); // waiting for nothing now
  });
  it("is not a word that does anything when nothing is waiting, and expires after 10 minutes", async () => {
    const calls: string[] = [];
    expect(await applyChange(changeDeps([], calls), "change")).toBe(false);
    await conflict();
    pass(11 * 60_000);
    const said: string[] = [];
    expect(await applyChange(changeDeps(said, calls), "change")).toBe(true);
    expect(calls).toEqual([]);
    expect(said[0]).toMatch(/timed out/);
  });
  it("other messages are not 'change'", async () => {
    await conflict();
    expect(await applyChange(changeDeps([], []), "change it please")).toBe(false);
    expect((await readMemory(U)).changeAsk).not.toBeNull();
  });
});

describe("a ✅ from the curator on a forwarded notice", () => {
  it("dismisses the notices in the app and is not echoed back", async () => {
    store.set(`${U}/notices/n1`, { read: false });
    store.set(`${U}/notices/n2`, { read: false });
    queueNotify(U, { kind: "notice", text: "A", ref: { c: "notices", id: "n1" } });
    queueNotify(U, { kind: "warn", text: "B", ref: { c: "notices", id: "n2" } });
    await flushNotify(U, true);
    expect(await dismissForwarded(U, "text1")).toBe(true);
    expect(store.get(`${U}/notices/n1`)).toMatchObject({ read: true });
    expect(store.get(`${U}/notices/n2`)).toMatchObject({ read: true });
    expect(typeof (store.get(`${U}/notices/n1`) as { dismissedAt?: number }).dismissedAt).toBe("number");
    await mirrorTick(U);
    pass(MIRROR_GROUP_MS + 1);
    await mirrorTick(U);
    expect(reacts).toEqual([]);
    expect(replies).toEqual([]);
  });
  it("does nothing for a message that isn't a forwarded-notices one", async () => {
    lineup("w1_mon");
    await mic("w1_mon");
    expect(await dismissForwarded(U, "poll1")).toBe(false);
    expect(await dismissForwarded(U, "unknown")).toBe(false);
  });
});
