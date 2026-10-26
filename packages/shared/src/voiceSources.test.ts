import { describe, expect, it } from "vitest";
import { listVoiceSources, pickVoiceChats, toggleVoiceChats, voiceSourcesSummary, type VoiceChatLike } from "./voice.ts";

const chat = (id: string, name: string, ts: number, o: Partial<VoiceChatLike> = {}): VoiceChatLike => ({ id, name, isGroup: id.endsWith("@g.us"), timestamp: ts, ...o });
const chats = [
  chat("a@c.us", "Asha", 50),
  chat("b@lid", "Bhavya", 40),
  chat("g1@g.us", "Bloom Comics", 30),
  chat("g2@g.us", "Family", 60),
  chat("status@broadcast", "Status", 99),
  chat("x@newsletter", "News", 98),
  chat("me@c.us", "Me", 97),
  chat("c@c.us", "", 10),
];

describe("listVoiceSources", () => {
  it("lists groups and people, newest first, without status, newsletters or yourself", () => {
    const out = listVoiceSources(chats, "me@c.us");
    expect(out.map((c) => c.id)).toEqual(["g2@g.us", "a@c.us", "b@lid", "g1@g.us", "c@c.us"]);
    expect(out[0]).toMatchObject({ isGroup: true, lastAt: 60_000 });
    expect(out.at(-1)?.name).toBe("+c");
  });
  it("caps the list", () => expect(listVoiceSources(chats, "me@c.us", 2)).toHaveLength(2));
  it("carries names only", () => expect(Object.keys(listVoiceSources(chats, undefined)[0]).sort()).toEqual(["id", "isGroup", "lastAt", "name"]));
});

describe("pickVoiceChats", () => {
  const opts = { groupIds: new Set(["g1@g.us"]), me: "me@c.us" };
  it("recommended (or missing) = show groups + newest DMs", () => {
    expect(pickVoiceChats(undefined, chats, opts).map((c) => c.id)).toEqual(["g1@g.us", "a@c.us", "b@lid", "c@c.us"]);
    expect(pickVoiceChats({ mode: "recommended", chats: [{ id: "g2@g.us", name: "Family", isGroup: true }] }, chats, { ...opts, maxDms: 1 }).map((c) => c.id)).toEqual(["g1@g.us", "a@c.us"]);
  });
  it("selected = exactly those chats, never yourself or a non-chat", () => {
    const sel = { mode: "selected" as const, chats: ["g2@g.us", "b@lid", "me@c.us", "status@broadcast"].map((id) => ({ id, name: id, isGroup: id.endsWith("g.us") })) };
    expect(pickVoiceChats(sel, chats, opts).map((c) => c.id)).toEqual(["b@lid", "g2@g.us"]);
  });
  it("selected with nothing picked reads nothing", () => expect(pickVoiceChats({ mode: "selected", chats: [] }, chats, opts)).toEqual([]));
});

describe("summary and toggling", () => {
  const six = ["Bloom Comics", "Rohan", "Asha", "Ravi", "Zoe", "Kim"].map((name, i) => ({ id: `${i}@c.us`, name, isGroup: false }));
  it("summarises the pick", () => {
    expect(voiceSourcesSummary({ mode: "selected", chats: six })).toBe("Learning from 6 chats: Bloom Comics, Rohan, Asha and 3 more.");
    expect(voiceSourcesSummary({ mode: "selected", chats: six.slice(0, 1) })).toBe("Learning from 1 chat: Bloom Comics.");
    expect(voiceSourcesSummary({ mode: "selected", chats: [] })).toBe("No chats picked yet.");
    expect(voiceSourcesSummary(undefined)).toMatch(/80 most recent/);
  });
  it("ticks and unticks without duplicates", () => {
    const on = toggleVoiceChats(six.slice(0, 2), six.slice(1, 4), true);
    expect(on.map((c) => c.name)).toEqual(["Bloom Comics", "Rohan", "Asha", "Ravi"]);
    expect(toggleVoiceChats(on, six.slice(0, 2), false).map((c) => c.name)).toEqual(["Asha", "Ravi"]);
  });
});
