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
