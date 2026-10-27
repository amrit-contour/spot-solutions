import { beforeEach, describe, expect, it, vi } from "vitest";

let stored: { id: string; name: string }[] = [];
const set = vi.fn(async () => undefined);
vi.mock("./firebase.ts", () => ({ col: () => ({ doc: () => ({ get: async () => ({ data: () => ({ list: stored }) }), set }) }) }));

import { nameChats, resetChatNames, resolveNames } from "./chatNames.ts";

type Contact = { name?: string; pushname?: string; verifiedName?: string; isMyContact?: boolean };
const fake = (contacts: Record<string, Contact>, lids: Record<string, string> = {}) =>
  ({
    info: { wid: { user: "61400000000" } },
    getContactLidAndPhone: async (ids: string[]) => ids.filter((i) => lids[i]).map((i) => ({ lid: i, pn: lids[i] })),
    getContactById: async (id: string) => contacts[id] ?? null,
  }) as never;

const comics = [{ id: "919800000001@c.us", chatId: undefined, phone: "919800000001", name: "Rahul Comic" }];

beforeEach(() => {
  resetChatNames();
  stored = [];
  set.mockClear();
});

describe("nameChats", () => {
  it("prefers the comic name, matched through an @lid", async () => {
    const client = fake({}, { "111@lid": "919800000001@c.us" });
    const out = await nameChats("u", client, [{ id: "111@lid", name: "111", isGroup: false }], comics);
    expect(out.get("111@lid")).toBe("Rahul Comic");
  });
  it("replaces a numeric chat name with the contact name, then pushname, then verified name", async () => {
    const client = fake({ "1@c.us": { name: "Saved Sam", isMyContact: true }, "2@c.us": { pushname: "Pat" }, "3@c.us": { verifiedName: "Biz Ltd" } });
    const chats = ["1", "2", "3"].map((n) => ({ id: `${n}@c.us`, name: `+${n}`, isGroup: false }));
    const out = await nameChats("u", client, chats, []);
    expect([...out.values()]).toEqual(["Saved Sam", "Pat", "Biz Ltd"]);
  });
  it("keeps a real WhatsApp chat name, and group subjects are untouched", async () => {
    const out = await nameChats("u", fake({}), [{ id: "5@c.us", name: "Dana", isGroup: false }, { id: "g@g.us", name: "Show", isGroup: true }], []);
    expect(out.get("5@c.us")).toBe("Dana");
    expect(out.has("g@g.us")).toBe(false);
  });
  it("falls back to +number when nothing is known", async () => {
    const out = await nameChats("u", fake({}), [{ id: "919811112222@c.us", name: "+91 98111 12222", isGroup: false }], []);
    expect(out.get("919811112222@c.us")).toBe("+919811112222");
  });
});

describe("resolveNames persistence", () => {
  it("uses names saved earlier when the new session has none", async () => {
    stored = [{ id: "7@c.us", name: "Old Name" }];
    const out = await resolveNames("u", fake({}), ["7@c.us"], []);
    expect(out.get("7@c.us")).toBe("Old Name");
  });
  it("saves real names but not numbers", async () => {
    vi.useFakeTimers();
    await resolveNames("u", fake({ "8@c.us": { pushname: "Quinn" } }), ["8@c.us", "9@c.us"], []);
    await vi.advanceTimersByTimeAsync(6000);
    vi.useRealTimers();
    expect(set).toHaveBeenCalledTimes(1);
    expect((set.mock.calls[0] as unknown as [{ list: unknown[] }])[0].list).toEqual([{ id: "8@c.us", name: "Quinn" }]);
  });
});
