import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirmPending, choosePending, pollForPending, SIDE_POLL, yesNoPoll } from "@spot/shared";

// The agent's questions as WhatsApp polls: what is sent, what a vote does, and every way a vote is refused. In-memory Firestore and a fake agent number.
const store = new Map<string, Record<string, unknown>>();
const ref = (k: string) => ({
  id: k.split("/").pop()!,
  get: async () => ({ data: () => store.get(k) }),
  set: async (d: Record<string, unknown>) => void store.set(k, { ...store.get(k), ...d }),
});
vi.mock("./firebase.ts", () => ({
  col: (uid: string, c: string) => ({ doc: (id: string) => ref(`${uid}/${c}/${id}`) }),
  userRef: (uid: string) => ({ get: async () => ({ data: () => store.get(`${uid}/user`) }) }),
  sessionRef: (uid: string) => ref(`${uid}/session/state`),
}));
vi.mock("./agentSession.ts", () => ({
  agentRef: (uid: string) => ref(`${uid}/session/agent`),
  agentSessions: { get: () => ({ fake: true }) },
}));
let pollFails = false;
const polls: { question: string; options: string[] }[] = [];
const texts: string[] = [];
vi.mock("./sendQueue.ts", () => ({
  sendQueued: async (_c: unknown, _to: string, text: string) => void texts.push(text),
  deliverableId: async (_c: unknown, to: string) => to,
  sendContent: async (_c: unknown, _to: string, content: { pollName: string; pollOptions: { name: string }[] }) => {
    if (pollFails) throw new Error("poll refused");
    polls.push({ question: content.pollName, options: content.pollOptions.map((o) => o.name) });
    return { id: { _serialized: `poll${polls.length}` } };
  },
}));
vi.mock("./userData.ts", () => ({ settingsFromDoc: (d: unknown) => d }));

const { sendQuestion, readMemory, writeMemory, askCurator } = await import("./agentOutbox.ts");
const { applyVote, POLL_CLOSED } = await import("./agentPolls.ts");

let n = 0;
let U = "";
const setup = (agent: Record<string, unknown> = {}) => {
  U = `u${++n}`;
  store.set(`${U}/user`, { settings: { agent: { enabled: true, notify: true, ...agent } } });
  store.set(`${U}/session/state`, { phone: "919800000001" });
  polls.length = 0;
  texts.length = 0;
  pollFails = false;
};
beforeEach(() => setup());

const plan = { type: "confirm", showId: "mon", lineupId: "l1" } as const;
const deps = (answers: [string, string][] = [], said: string[] = [], now = Date.now()) => ({
  readMemory: () => readMemory(U),
  writeMemory: (p: Record<string, unknown>) => writeMemory(U, p),
  say: async (t: string) => void said.push(t),
  now: () => now,
  answer: async (k: string, t: string) => void answers.push([k, t]),
});

describe("what is sent", () => {
  it("a confirmation becomes a Yes/No poll, remembered with its id", async () => {
    const p = confirmPending(plan, "Confirm Monday Mic?", Date.now());
    const id = await sendQuestion(U, "text", { poll: pollForPending(p), kind: "pending" });
    expect(id).toBe("poll1");
    expect(polls[0]).toEqual({ question: "Confirm Monday Mic?", options: ["Yes, do it", "No, cancel"] });
    expect(texts).toEqual([]);
    expect((await readMemory(U)).polls?.[0]).toMatchObject({ id: "poll1", kind: "pending", answers: ["yes", "no"] });
  });
  it("a numbered choice becomes one option per name; more than 12 stays text", () => {
    const mk = (k: number) => choosePending("Which Aditya?", Array.from({ length: k }, (_, i) => ({ label: `Aditya ${i}`, plan, summary: "s" })) as never, 0);
    expect(pollForPending(mk(3))).toMatchObject({ options: ["Aditya 0", "Aditya 1", "Aditya 2"], answers: ["1", "2", "3"] });
    expect(pollForPending(mk(13))).toBeNull();
  });
  it("side question and mic check polls", () => {
    expect(SIDE_POLL.answers).toEqual(["1", "2", "no"]);
    expect(yesNoPoll("🎤 Did *Monday Mic* on 5 Oct happen? Reply *yes* or *no* here.")).toMatchObject({ question: "🎤 Did Monday Mic on 5 Oct happen?", answers: ["yes", "no"] });
  });
  it("polls off: plain text, no poll", async () => {
    setup({ agentPolls: false });
    const p = confirmPending(plan, "Confirm?", Date.now());
    expect(await sendQuestion(U, "Confirm? Reply *yes*", { poll: pollForPending(p), kind: "pending" })).toBeNull();
    expect(polls).toEqual([]);
    expect(texts).toEqual(["Confirm? Reply *yes*"]);
  });
  it("a poll that fails to send falls back to the text", async () => {
    pollFails = true;
    const p = confirmPending(plan, "Confirm?", Date.now());
    expect(await sendQuestion(U, "Confirm? Reply *yes*", { poll: pollForPending(p), kind: "pending" })).toBeNull();
    expect(texts).toEqual(["Confirm? Reply *yes*"]);
    expect((await readMemory(U)).polls ?? []).toEqual([]);
  });
  it("askCurator sends a poll and keeps its id on the pending question", async () => {
    const p = confirmPending(plan, "Clear the group?", Date.now());
    expect(await askCurator(U, "🧹 Clear the group?\nReply *yes* to clear it", p)).toBe(true);
    expect(polls[0]!.options).toEqual(["Yes, do it", "No, cancel"]);
    expect((await readMemory(U)).pending).toMatchObject({ pollId: "poll1" });
  });
});

describe("what a vote does", () => {
  const ask = async () => {
    const p = confirmPending(plan, "Confirm Monday Mic?", Date.now());
    const id = (await sendQuestion(U, "t", { poll: pollForPending(p), kind: "pending" }))!;
    await writeMemory(U, { pending: { ...p, pollId: id } });
    return id;
  };
  it("a vote on the waiting question is answered like the typed word", async () => {
    const id = await ask();
    const answers: [string, string][] = [];
    expect(await applyVote(deps(answers), id, ["Yes, do it"])).toBe("answered");
    expect(answers).toEqual([["pending", "yes"]]);
  });
  it("taking a vote back, or an option that isn't one of ours, answers nothing", async () => {
    const id = await ask();
    const answers: [string, string][] = [];
    expect(await applyVote(deps(answers), id, [])).toBe("ignored");
    expect(await applyVote(deps(answers), id, ["Maybe"])).toBe("ignored");
    expect(await applyVote(deps(answers), "someone-elses-poll", ["Yes, do it"])).toBe("ignored");
    expect(answers).toEqual([]);
  });
  it("a vote on a poll whose question is gone says so once", async () => {
    const id = await ask();
    await writeMemory(U, { pending: null });
    const said: string[] = [];
    const answers: [string, string][] = [];
    expect(await applyVote(deps(answers, said), id, ["Yes, do it"])).toBe("closed");
    expect(await applyVote(deps(answers, said), id, ["No, cancel"])).toBe("closed");
    expect(said).toEqual([POLL_CLOSED]);
    expect(answers).toEqual([]);
  });
  it("a vote after the 10 minutes closes it too", async () => {
    const id = await ask();
    const said: string[] = [];
    expect(await applyVote(deps([], said, Date.now() + 11 * 60_000), id, ["Yes, do it"])).toBe("closed");
    expect(said).toEqual([POLL_CLOSED]);
  });
  it("a replaced question: the old poll is closed, the new one counts", async () => {
    const old = await ask();
    const p2 = confirmPending(plan, "Another?", Date.now());
    const id2 = (await sendQuestion(U, "t", { poll: pollForPending(p2), kind: "pending" }))!;
    await writeMemory(U, { pending: { ...p2, pollId: id2 } });
    const answers: [string, string][] = [];
    expect(await applyVote(deps(answers, []), old, ["Yes, do it"])).toBe("closed");
    expect(await applyVote(deps(answers, []), id2, ["No, cancel"])).toBe("answered");
    expect(answers).toEqual([["pending", "no"]]);
  });
  it("changing a vote: the latest counts only while the question is still waiting", async () => {
    const id = await ask();
    const answers: [string, string][] = [];
    await applyVote(deps(answers), id, ["Yes, do it"]);
    await writeMemory(U, { pending: null }); // the first vote was acted on
    expect(await applyVote(deps(answers, []), id, ["No, cancel"])).toBe("closed");
    expect(answers).toEqual([["pending", "yes"]]);
  });
  it("a mic check poll answers yes/no until it is closed", async () => {
    const id = (await sendQuestion(U, "t", { poll: yesNoPoll("Did Monday Mic happen? Reply *yes*"), kind: "mic" }))!;
    const answers: [string, string][] = [];
    expect(await applyVote(deps(answers), id, ["No"])).toBe("answered");
    expect(answers).toEqual([["mic", "no"]]);
  });
});

describe("who may vote", () => {
  it("only the curator's own number counts (same rule as a typed answer)", async () => {
    const { senderIsCurator } = await import("@spot/shared");
    const curatorPhone = "919800000001";
    expect(senderIsCurator({ from: "919800000001@c.us", curatorPhone })).toBe(true);
    expect(senderIsCurator({ from: "919811111111@c.us", curatorPhone })).toBe(false);
    expect(senderIsCurator({ from: "123@lid", resolvedPhone: "919800000001@c.us", curatorPhone })).toBe(true);
    expect(senderIsCurator({ from: "123@lid", resolvedPhone: null, curatorPhone })).toBe(false);
    expect(senderIsCurator({ from: "120363@g.us", curatorPhone })).toBe(false);
  });
});
