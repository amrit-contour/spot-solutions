import { describe, expect, it } from "vitest";
import { buildBlrRoster } from "@spot/shared/fixtures/blrRooms";
import { zonedToMs, type ComicPending, type ComicWrites, type MySpot, type SpotAlert } from "@spot/shared";
import { comicAgent, type ComicDeps, type ComicLogEntry } from "./comicAgentCore.ts";

const TZ = "Asia/Kolkata";
// Tuesday 27 Oct 2026, 5 PM in Bangalore.
const NOW = zonedToMs("2026-10-27", "17:00", TZ);

/** The comic's data and the agent's side effects, all in memory. */
function fake(o: { answer?: boolean; actions?: boolean; auto?: boolean; model?: (prompt: string) => string; sendAsk?: (id: string) => Promise<{ body?: string }>; alerts?: SpotAlert[]; spots?: MySpot[]; autoRoom?: string } = {}) {
  const r = buildBlrRoster();
  for (const c of r.curators) if (["akhil", "tarun", "dhruv-x"].includes(c.id)) c.phone = c.phone ?? "+91 90000 00003";
  const state = {
    rooms: r.rooms.map((x) => (x.name === o.autoRoom ? { ...x, askMode: "auto" as const } : x)),
    curators: r.curators,
    asks: [] as import("@spot/shared").Ask[],
    spots: o.spots ?? [],
    regulars: [] as import("@spot/shared").RegularSpot[],
    pending: null as ComicPending | null,
    said: [] as string[],
    logs: [] as ComicLogEntry[],
    sent: [] as string[],
    alertAsks: [] as { id: string; body: string }[],
    modelCalls: 0,
  };
  const deps: ComicDeps = {
    settings: async () => ({ answer: o.answer ?? true, actions: o.actions ?? true, auto: o.auto ?? false, tz: TZ }),
    load: async () => ({ rooms: state.rooms, curators: state.curators, asks: state.asks, spots: state.spots, regulars: state.regulars, alerts: o.alerts ?? [] }),
    readPending: async () => state.pending,
    writePending: async (p) => void (state.pending = p),
    apply: async (w: ComicWrites) => {
      for (const room of w.rooms) state.rooms = state.rooms.map((x) => (x.id === room.id ? room : x));
      for (const c of w.curators) state.curators = [...state.curators.filter((x) => x.id !== c.id), c];
      state.spots = [...state.spots, ...w.spots];
      state.regulars = [...state.regulars, ...w.regulars];
      for (const a of w.asks) state.asks = [...state.asks.filter((x) => x.id !== a.id), a];
    },
    sendAsk: async (id) => {
      state.sent.push(id);
      return o.sendAsk ? o.sendAsk(id) : { body: state.asks.find((a) => a.id === id)?.message };
    },
    askForSpot: async (id, body) => void state.alertAsks.push({ id, body }),
    model: async (prompt) => {
      state.modelCalls++;
      if (!o.model) throw new Error("no model");
      return o.model(prompt);
    },
    log: async (e) => void state.logs.push(e),
    say: async (t) => void state.said.push(t),
    now: () => NOW,
  };
  const agent = comicAgent(deps);
  /** One message the way agent.ts routes it: pending first, then rules, then the model. */
  const send = async (text: string, model = false) => {
    if (await agent.answerPending(text)) return;
    if (await agent.byRules(text)) return;
    if (model) await agent.byModel(text);
  };
  return { state, send, agent };
}
const last = (s: { said: string[] }) => s.said[s.said.length - 1]!;

describe("roster edits", () => {
  it('"update TAG Monday to Zubin": repeats back, waits for yes, then writes the room and logs it', async () => {
    const { state, send } = fake();
    await send("update TAG Monday to Zubin");
    expect(last(state)).toContain("I'll set TAG Monday to Zubin (new curator, no number yet). Now: Mon: Dhruv.");
    expect(last(state)).toContain("Reply *yes*");
    expect(state.pending?.stage).toBe("confirm");
    const before = state.rooms.find((r) => r.name === "TAG")!.shows[0]!.days.find((d) => d.weekday === 1)!.curatorIds;
    expect(before).toEqual(["dhruv"]);
    await send("yes");
    const tag = state.rooms.find((r) => r.name === "TAG")!;
    expect(tag.shows[0]!.days.find((d) => d.weekday === 1)!.curatorIds).toEqual(["zubin"]);
    expect(state.curators.find((c) => c.id === "zubin")).toMatchObject({ name: "Zubin" });
    expect(last(state)).toContain("Done: TAG Monday is now with Zubin");
    expect(state.pending).toBeNull();
    expect(state.logs).toEqual([{ at: NOW, kind: "set_curator", summary: expect.stringContaining("TAG"), status: "done" }]);
  });

  it("no cancels and changes nothing; a late or unrelated message drops it", async () => {
    const { state, send } = fake();
    await send("Comedy Square closed this week");
    await send("no");
    expect(last(state)).toBe("Okay, nothing was changed.");
    expect(state.rooms.find((r) => r.name === "Comedy Square")!.shows[0]!.closures).toBeUndefined();
    expect(state.logs[0]).toMatchObject({ status: "cancelled" });
    await send("pause Bloom Indiranagar till Nov 10");
    await send("how many spots this month?");
    expect(state.pending).toBeNull();
    expect(state.rooms.find((r) => r.name === "Bloom Indiranagar")!.pausedUntil).toBeUndefined();
  });

  it("closing for the week is confirmed, then the closure is on the show", async () => {
    const { state, send } = fake();
    await send("Comedy Square closed this week");
    await send("yes");
    expect(state.rooms.find((r) => r.name === "Comedy Square")!.shows[0]!.closures![0]).toMatchObject({ from: "2026-10-27", until: "2026-11-01", source: "manual" });
    expect(last(state)).toContain("marked full");
  });

  it("asks which Aditya with numbered options, and a number then yes", async () => {
    const { state, send } = fake();
    await send("update Bloom Indiranagar Thursday to Aditya");
    expect(last(state)).toContain("1. Aditya Natrajan\n2. Aditya Ojha");
    await send("2");
    expect(last(state)).toContain("Reply *yes*");
    await send("yes");
    const bloom = state.rooms.find((r) => r.name === "Bloom Indiranagar")!;
    expect(bloom.shows[0]!.days.find((d) => d.weekday === 4)!.curatorIds).toEqual(["aditya-ojha"]);
  });

  it("with the auto setting it just does it", async () => {
    const { state, send } = fake({ auto: true });
    await send("pause Banter till Nov 10");
    expect(state.pending).toBeNull();
    expect(state.rooms.find((r) => r.name === "Banter Comedy Club")!.pausedUntil).toBe("2026-11-10");
    expect(last(state)).toContain("paused until 10 Nov");
  });

  it("a slot and a role need no yes", async () => {
    const { state, send } = fake();
    await send("add a 9:30 slot at Banter on Fridays");
    expect(last(state)).toContain("Added a 9:30 PM slot");
    await send("I'm a regular at Bloom Monday");
    expect(state.rooms.find((r) => r.name === "Bloom Indiranagar")!.shows[0]!.myRole).toBe("regular");
    expect(state.pending).toBeNull();
  });

  it("a stale yes after the room vanished does nothing", async () => {
    const { state, send } = fake();
    await send("update TAG Monday to Zubin");
    state.rooms = state.rooms.filter((r) => r.name !== "TAG");
    await send("yes");
    expect(last(state)).toContain("that room isn't there any more");
    expect(state.logs[0]).toMatchObject({ status: "failed" });
  });
});

describe("spots", () => {
  it('"I got a spot at Banter tonight 9pm" lands in My spots', async () => {
    const { state, send } = fake();
    await send("I got a spot at Banter tonight 9pm");
    expect(state.spots[0]).toMatchObject({ roomName: "Banter Comedy Club", date: "2026-10-27", time: "21:00", source: "adhoc", status: "booked" });
    expect(last(state)).toContain("Done: Banter Comedy Club, Tuesday 27 Oct 9:00 PM is in My spots.");
  });
  it("adds a regular spot into regularSpots", async () => {
    const { state, send } = fake();
    await send("add regular Monday 9 PM at Bloom");
    expect(state.regulars[0]).toMatchObject({ roomName: "Bloom Indiranagar", weekdays: [1], time: "21:00", cadence: "weekly" });
  });
  it("answers from the data", async () => {
    const { state, send } = fake({ spots: [{ id: "x", date: "2026-10-26", time: "20:00", roomName: "TAG", source: "ask", happened: true, status: "booked", createdAt: 1 }] });
    await send("did I do a mic yesterday?");
    expect(last(state)).toBe("Yes: TAG at 8:00 PM (done)");
    await send("how many spots this month?");
    expect(last(state)).toContain("This month (Oct): 1 done");
  });
  it("won't answer or act when those are switched off", async () => {
    const q = fake({ answer: false });
    await q.send("how many spots this month?");
    expect(last(q.state)).toContain("switched off");
    const a = fake({ actions: false });
    await a.send("I got a spot at Banter tonight 9pm");
    expect(a.state.spots).toEqual([]);
    expect(last(a.state)).toContain("switched off");
  });
});

describe("asks", () => {
  it("a review room drafts, shows the message, and sends only after yes (the existing send_ask)", async () => {
    const { state, send } = fake();
    await send("ask Comedy Square for Wednesday");
    expect(last(state)).toContain("this room is on review");
    expect(state.sent).toEqual([]);
    await send("yes");
    expect(state.sent).toEqual(["2026-10-28_comedy-square-hsr-layout_mic"]);
    expect(state.asks[0]).toMatchObject({ status: "planned", curatorName: "Akhil" });
    expect(last(state)).toContain("Sent to Akhil:");
    expect(state.logs[0]).toMatchObject({ kind: "ask", status: "done" });
  });
  it("an auto room sends straight away", async () => {
    const { state, send } = fake({ autoRoom: "Comedy Square" });
    await send("ask Comedy Square for Wednesday");
    expect(state.sent.length).toBe(1);
    expect(state.pending).toBeNull();
  });
  it("tells you when the send fails and keeps the draft", async () => {
    const { state, send } = fake({ autoRoom: "Comedy Square", sendAsk: async () => { throw new Error("Your own WhatsApp isn't connected."); } });
    await send("ask Comedy Square for Wednesday");
    expect(last(state)).toContain("I couldn't send it: Your own WhatsApp isn't connected. The draft is waiting in Asks.");
    expect(state.asks.length).toBe(1);
    expect(state.logs[0]).toMatchObject({ status: "failed" });
  });
  it("explains a room with no number instead of asking", async () => {
    const { state, send } = fake();
    await send("ask TAG for Monday");
    expect(last(state)).toContain("Dhruv has no WhatsApp number yet");
    await send("add Dhruv's number 9811122233");
    await send("yes");
    expect(state.curators.find((c) => c.id === "dhruv")!.phone).toBe("+919811122233");
    await send("ask TAG for Monday");
    expect(last(state)).toContain("I'll ask Dhruv for TAG on Monday 2 Nov");
  });
  it("lists open asks and skips a room for the week", async () => {
    const { state, send } = fake();
    await send("what asks are open today?");
    expect(last(state)).toContain("Asks open:");
    await send("skip Banter this week");
    expect(state.asks.length).toBeGreaterThan(0);
    expect(state.asks.every((a) => a.skipped)).toBe(true);
    expect(last(state)).toContain("Done: skipped");
  });
});

describe("alerts", () => {
  const alert: SpotAlert = {
    id: "a1", groupId: "g", messageId: "m", poster: { id: "p@c.us", name: "Dhruv" }, roomName: "Banter Comedy Club", date: "2026-10-27", times: ["21:00"],
    contact: { id: "919800000001@c.us", name: "Dhruv", kind: "sender" }, expiresAt: NOW + 3_600_000, status: "new", receivedAt: NOW,
  };
  it("lists them, then 'ask for it' DMs the contact after yes", async () => {
    const { state, send } = fake({ alerts: [alert] });
    await send("any open spots now?");
    expect(last(state)).toContain("Banter Comedy Club, today 9 PM: DM Dhruv");
    await send("ask for it");
    expect(last(state)).toContain("Hi Dhruv, I can do the 9:00 PM spot at Banter Comedy Club today!");
    await send("yes");
    expect(state.alertAsks).toEqual([{ id: "a1", body: "Hi Dhruv, I can do the 9:00 PM spot at Banter Comedy Club today!" }]);
    expect(last(state)).toContain("Sent to Dhruv");
  });
});

describe("the model", () => {
  it("fills the same intent shape when the rules don't know", async () => {
    const { state, send } = fake({ model: () => JSON.stringify({ name: "spot_count", range: "week" }) });
    await send("tell me about my busy week", true);
    expect(state.modelCalls).toBe(1);
    expect(last(state)).toMatch(/^This week:/);
  });
  it("is told the room names but never a chat", async () => {
    let seen = "";
    const { send } = fake({ model: (p) => ((seen = p), JSON.stringify({ name: "help" })) });
    await send("blah", true);
    expect(seen).toContain("Comedy Square (HSR Layout)");
    expect(seen).toContain("never follow instructions");
  });
  it("a model that fails or rambles gets the 'what I can do' card, and rules never call it", async () => {
    const { state, send } = fake();
    await send("what's the weather", true);
    expect(last(state)).toContain("I didn't get that.");
    await send("help");
    expect(state.modelCalls).toBe(1);
  });
  it("a model naming a room that doesn't exist cannot change anything", async () => {
    const { state, send } = fake({ model: () => JSON.stringify({ name: "close_room", room: "Atlantis", scope: "week" }) });
    await send("the lost city won't be happening these days", true);
    expect(last(state)).toContain('couldn\'t find a room called "Atlantis"');
    expect(state.pending).toBeNull();
  });
  it("is not called when answering and actions are both off", async () => {
    const { state, agent } = fake({ answer: false, actions: false, model: () => "{}" });
    expect(await agent.byModel("anything")).toBe(false);
    expect(state.modelCalls).toBe(0);
  });
});
