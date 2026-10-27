import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: unknown[] = [];
vi.mock("./sendQueue.ts", () => ({ sendContent: vi.fn(async (_c: unknown, _to: string, content: unknown) => (sent.push(content), { id: { _serialized: `m${sent.length}` } })) }));
vi.mock("whatsapp-web.js", () => {
  class Poll {
    constructor(public question: string, public options: string[], public opts: unknown) {}
  }
  class Location {
    constructor(public lat: number, public lng: number, public opts: unknown) {}
  }
  return { default: { Poll, Location } };
});

const { sendRich } = await import("./sendRich.ts");
const client = {} as never;
const pinned = { name: "The Laugh Store", area: "Indiranagar", lat: 12.9784, lng: 77.6408 };

beforeEach(() => (sent.length = 0));

describe("sendRich", () => {
  it("sends rendered text, rewritten when asked", async () => {
    await sendRich(client, "x@c.us", { kind: "text", body: "Hi {{name}}" }, { name: "Rohan" }, null, { rewrite: async (t) => t + "!" });
    expect(sent).toEqual(["Hi Rohan!"]);
  });
  it("sends a pin after the text when the venue has coordinates", async () => {
    await sendRich(client, "x@c.us", { kind: "text", body: "Hi", attachLocation: true }, {}, pinned);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ lat: 12.9784, lng: 77.6408, opts: { name: "The Laugh Store", address: "Indiranagar" } });
  });
  it("skips the pin silently when there are no coordinates", async () => {
    await sendRich(client, "x@c.us", { kind: "text", body: "Hi", attachLocation: true }, {}, { name: "Bloom" });
    await sendRich(client, "x@c.us", { kind: "location", body: "" }, {}, { name: "Bloom" });
    expect(sent).toEqual(["Hi"]);
  });
  it("sends a location-only message", async () => {
    await sendRich(client, "x@c.us", { kind: "location", body: "" }, {}, pinned);
    expect(sent).toHaveLength(1);
  });
  it("sends a poll with variables filled, and never rewrites it", async () => {
    const rewrite = vi.fn();
    const m = await sendRich(client, "x@c.us", { kind: "poll", body: "", poll: { question: "{{name}}, Monday?", options: ["Yes", "Pass"], multi: true } }, { name: "Rohan" }, null, { rewrite });
    expect(sent[0]).toMatchObject({ question: "Rohan, Monday?", options: ["Yes", "Pass"], opts: { allowMultipleAnswers: true } });
    expect(rewrite).not.toHaveBeenCalled();
    expect(m?.id._serialized).toBe("m1");
  });
  it("refuses an invalid poll", async () => {
    await expect(sendRich(client, "x@c.us", { kind: "poll", body: "", poll: { question: "Q", options: ["only"], multi: false } }, {}, null)).rejects.toThrow(/at least 2/);
    expect(sent).toHaveLength(0);
  });
});

describe("sendRich with a picture", () => {
  const uid = "uidA1";
  const path = `users/${uid}/attachments/abcDEF1234567890_-xy.jpg`;
  const calls: { content: unknown; options: unknown }[] = [];
  const loaded: string[] = [];
  beforeEach(() => {
    calls.length = 0;
    loaded.length = 0;
  });

  it("sends the picture with the text as its caption: one message", async () => {
    vi.resetModules();
    vi.doMock("./sendQueue.ts", () => ({ sendContent: vi.fn(async (_c: unknown, _to: string, content: unknown, _t: number, options: unknown) => (calls.push({ content, options }), { id: { _serialized: "m1" } })) }));
    vi.doMock("whatsapp-web.js", () => ({ default: { MessageMedia: class { constructor(public mime: string, public data: string, public name: string) {} } } }));
    vi.doMock("./media.ts", () => ({ loadOutImage: vi.fn(async (u: string, img: { path: string }) => (loaded.push(`${u}:${img.path}`), { mime: "image/jpeg", data: "QUJD", name: "photo.jpg" })) }));
    const { sendRich: send } = await import("./sendRich.ts");
    await send(client, "x@c.us", { kind: "text", body: "Hi {{name}}", image: { path } }, { name: "Rohan" }, null, { uid });
    expect(calls).toHaveLength(1);
    expect(calls[0].content).toMatchObject({ mime: "image/jpeg", data: "QUJD" });
    expect(calls[0].options).toEqual({ caption: "Hi Rohan" });
    expect(loaded).toEqual([`${uid}:${path}`]);
  });

  it("sends a picture with no text without a caption", async () => {
    vi.resetModules();
    vi.doMock("./sendQueue.ts", () => ({ sendContent: vi.fn(async (_c: unknown, _to: string, content: unknown, _t: number, options: unknown) => (calls.push({ content, options }), { id: { _serialized: "m1" } })) }));
    vi.doMock("whatsapp-web.js", () => ({ default: { MessageMedia: class { constructor(public mime: string, public data: string, public name: string) {} } } }));
    vi.doMock("./media.ts", () => ({ loadOutImage: vi.fn(async () => ({ mime: "image/jpeg", data: "QUJD", name: "photo.jpg" })) }));
    const { sendRich: send } = await import("./sendRich.ts");
    await send(client, "x@c.us", { kind: "text", body: "", image: { path } }, {}, null, { uid, prerendered: true });
    expect(calls[0].options).toEqual({});
  });

  it("falls back to the text alone when the picture can't be loaded, unless the picture is required", async () => {
    vi.resetModules();
    vi.doMock("./sendQueue.ts", () => ({ sendContent: vi.fn(async (_c: unknown, _to: string, content: unknown, _t: number, options: unknown) => (calls.push({ content, options }), { id: { _serialized: "m1" } })) }));
    vi.doMock("whatsapp-web.js", () => ({ default: {} }));
    vi.doMock("./media.ts", () => ({ loadOutImage: vi.fn(async () => Promise.reject(new Error("The picture is no longer there. Attach it again."))) }));
    const { sendRich: send } = await import("./sendRich.ts");
    await send(client, "x@c.us", { kind: "text", body: "Hello", image: { path } }, {}, null, { uid });
    expect(calls.map((c) => c.content)).toEqual(["Hello"]);
    await expect(send(client, "x@c.us", { kind: "text", body: "Hello", image: { path } }, {}, null, { uid, imageRequired: true })).rejects.toThrow(/no longer there/);
    // No account to check the path against: the picture is not trusted.
    await send(client, "x@c.us", { kind: "text", body: "Again", image: { path } }, {}, null, {});
    expect(calls.map((c) => c.content)).toEqual(["Hello", "Again"]);
  });
});
