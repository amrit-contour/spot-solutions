import { beforeEach, describe, expect, it, vi } from "vitest";

// A comic with two devices and whatever comicSettings the test sets.
const state: { settings: Record<string, unknown> | undefined; deviceApp: string } = { settings: undefined, deviceApp: "comic" };
const sent: { data: Record<string, string> }[] = [];
vi.mock("firebase-admin/messaging", () => ({
  getMessaging: () => ({
    sendEachForMulticast: async (m: { tokens: string[]; data: Record<string, string> }) => {
      sent.push({ data: m.data });
      return { successCount: m.tokens.length, responses: m.tokens.map(() => ({ success: true })) };
    },
  }),
}));
vi.mock("./firebase.ts", () => ({
  userRef: () => ({ get: async () => ({ data: () => (state.settings ? { comicSettings: state.settings } : {}) }) }),
  col: () => ({
    where: () => ({ get: async () => ({ docs: state.deviceApp === "comic" ? [{ id: "t1", data: () => ({ token: "t1", app: "comic" }) }] : [] }) }),
    get: async () => ({ docs: [{ id: "c1", data: () => ({ token: "c1" }) }] }),
    doc: () => ({ delete: async () => undefined }),
  }),
}));

const { notifyComic, pushAsk } = await import("./notify.ts");
const msg = (kind: string) => ({ kind, title: "T", body: "B", path: "/asks" });

beforeEach(() => {
  sent.length = 0;
  state.settings = undefined;
  state.deviceApp = "comic";
});

describe("notifyComic respects the comic's switches", () => {
  it("sends by default", async () => {
    expect(await notifyComic("u", msg("spot_alert"))).toBe(1);
    expect(sent).toHaveLength(1);
  });
  it("skips a kind switched off, still sends the others", async () => {
    state.settings = { push: { spotAlert: false } };
    expect(await notifyComic("u", msg("spot_alert"))).toBe(0);
    expect(await notifyComic("u", msg("spot_opening"))).toBe(1);
    expect(sent).toHaveLength(1);
  });
  it("opening notices have their own switch", async () => {
    state.settings = { push: { opening: false } };
    expect(await notifyComic("u", msg("spot_opening"))).toBe(0);
    expect(await notifyComic("u", msg("spot_alert"))).toBe(1);
  });
});

describe("pushAsk", () => {
  it("goes to the comic's devices", async () => {
    await pushAsk("u", "ask_open", "Time");
    expect(sent.map((s) => s.data.kind)).toEqual(["ask_open"]);
  });
  it("sends nothing for a kind that is off, not even to other devices", async () => {
    state.settings = { push: { askClosing: false, askReply: false } };
    state.deviceApp = "none";
    await pushAsk("u", "ask_closing", "soon");
    await pushAsk("u", "ask_reply", "yes");
    expect(sent).toHaveLength(0);
  });
  it("falls back to the Curate devices when the comic has no Comedy device", async () => {
    state.deviceApp = "none";
    await pushAsk("u", "ask_open", "Time");
    expect(sent.map((s) => s.data.kind)).toEqual(["ask_open"]);
  });
});
