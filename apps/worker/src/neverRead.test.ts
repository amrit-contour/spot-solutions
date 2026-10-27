import { beforeEach, describe, expect, it, vi } from "vitest";

// If anything past the Never read check ran, the model, Firestore or a send would be touched, and these throw.
const boom = (what: string) => () => {
  throw new Error(`${what} must not be reached for a Never read chat`);
};
const classify = vi.fn(boom("classify"));
const col = vi.fn(boom("firestore"));
const sent = vi.fn(boom("send"));
const noted = { messagesIn: 0, liveIn: 0 };

vi.mock("./gemma.ts", () => ({ classify: (...a: unknown[]) => classify(...(a as [])) }));
vi.mock("./firebase.ts", () => ({ col: (...a: unknown[]) => col(...(a as [])), db: { runTransaction: boom("transaction") } }));
vi.mock("./classifyContext.ts", () => ({ classifyContext: boom("context"), countPriorRequests: boom("prior") }));
vi.mock("./sendQueue.ts", () => ({ sendQueued: (...a: unknown[]) => sent(...(a as [])) }));
vi.mock("./sendRich.ts", () => ({ sendRich: (...a: unknown[]) => sent(...(a as [])) }));
vi.mock("./deliver.ts", () => ({ composeDraft: boom("draft"), deliverDraft: boom("deliver") }));
vi.mock("./greet.ts", () => ({ greetFor: boom("greet") }));
vi.mock("./voice.ts", () => ({ inVoice: boom("voice") }));
vi.mock("./replies.ts", () => ({ handleOfferReply: boom("offer"), handleOnboardingReply: boom("onboarding") }));
vi.mock("./commands.ts", () => ({ notice: boom("notice") }));
vi.mock("./stats.ts", () => ({ counters: { get messagesIn() { return noted.messagesIn; }, set messagesIn(v: number) { noted.messagesIn = v; } }, live: { noteIn: () => void noted.liveIn++, noteSpot: () => undefined } }));

let neverRead: { id: string; kind: "person" | "group"; addedAt: number }[] = [];
vi.mock("./userData.ts", () => ({
  watchUser: () => ({ ready: Promise.resolve(), settings: { neverRead, debounceSeconds: 0 }, shows: [], venues: [] }),
}));

const { enqueue, catchUpSince, markLive } = await import("./intake.ts");
const { isNeverRead } = await import("./neverRead.ts");

const msg = (from: string, extra: Record<string, unknown> = {}) =>
  ({ from, fromMe: false, isStatus: false, broadcast: false, type: "chat", body: "Can I get a spot on Monday?", timestamp: Date.now() / 1000, id: { _serialized: `m_${from}` }, getContact: boom("getContact"), ...extra }) as never;
const client = (map: Record<string, string> = {}) =>
  ({
    getContactLidAndPhone: vi.fn(async (ids: string[]) => ids.map((id) => ({ lid: id, pn: map[id] }))),
    getChats: vi.fn(async () => []),
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  noted.messagesIn = 0;
  noted.liveIn = 0;
  neverRead = [
    { id: "919876543210@c.us", kind: "person", addedAt: 1 },
    { id: "120363000111@g.us", kind: "group", addedAt: 1 },
  ];
  markLive("u1");
});

describe("enqueue on the Never read list", () => {
  it("skips a listed number before any contact lookup, count, store or model call", async () => {
    await enqueue("u1", client(), msg("919876543210@c.us"));
    expect(classify).not.toHaveBeenCalled();
    expect(col).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
    expect(noted.messagesIn).toBe(0);
    expect(noted.liveIn).toBe(0);
  });

  it("skips a listed number that arrives as a lid (mapped through WhatsApp)", async () => {
    const c = client({ "55512345678901@lid": "919876543210@c.us" });
    await enqueue("u1", c, msg("55512345678901@lid"));
    expect(noted.messagesIn).toBe(0);
    expect(classify).not.toHaveBeenCalled();
  });

  it("skips a message from a listed person inside any group (author)", async () => {
    await enqueue("u1", client(), msg("120363999@g.us", { author: "919876543210@c.us" }));
    expect(noted.messagesIn).toBe(0);
  });

  it("does not skip someone who is not listed", async () => {
    // getContact throws in this stub: reaching it proves the message went on past the check.
    await expect(enqueue("u1", client(), msg("919000000000@c.us"))).rejects.toThrow(/getContact/);
    expect(noted.messagesIn).toBe(1);
  });

  it("applies a change at once, with no restart", async () => {
    neverRead = [];
    await expect(enqueue("u1", client(), msg("919876543210@c.us"))).rejects.toThrow(/getContact/);
  });
});

describe("catch-up on the Never read list", () => {
  it("never opens a listed chat, and still reads the others", async () => {
    const fetchListed = vi.fn(async () => [msg("919876543210@c.us")]);
    const fetchOther = vi.fn(async () => []);
    const chat = (id: string, fetchMessages: unknown) => ({ id: { _serialized: id }, isGroup: false, isReadOnly: false, timestamp: Date.now() / 1000, fetchMessages });
    const c = client();
    (c as unknown as { getChats: () => Promise<unknown[]> }).getChats = async () => [chat("919876543210@c.us", fetchListed), chat("919000000000@c.us", fetchOther)];
    await catchUpSince("u1", c, Date.now() - 3600_000);
    expect(fetchListed).not.toHaveBeenCalled();
    expect(fetchOther).toHaveBeenCalledTimes(1);
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("isNeverRead", () => {
  it("is false for an empty list without asking WhatsApp anything", async () => {
    neverRead = [];
    const c = client();
    expect(await isNeverRead("u1", c, "55512345678901@lid")).toBe(false);
    expect((c as unknown as { getContactLidAndPhone: ReturnType<typeof vi.fn> }).getContactLidAndPhone).not.toHaveBeenCalled();
  });
  it("asks WhatsApp for a lid only once", async () => {
    const c = client({ "55500000000001@lid": "919111111111@c.us" });
    await isNeverRead("u1", c, "55500000000001@lid");
    await isNeverRead("u1", c, "55500000000001@lid");
    expect((c as unknown as { getContactLidAndPhone: ReturnType<typeof vi.fn> }).getContactLidAndPhone).toHaveBeenCalledTimes(1);
  });
});
