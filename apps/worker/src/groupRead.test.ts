import { describe, expect, it } from "vitest";
import { BLR_ROSTER } from "@spot/shared/fixtures/blrRooms";
import { interpret, zonedToMs, type GroupMsg } from "@spot/shared";
import { buildGroupPrompt, parseAiRead, readGroupMessage, readWithFallback, roomLines } from "./groupRead.ts";

const TZ = "Asia/Kolkata";
const NOW = zonedToMs("2026-10-27", "17:00", TZ);
const msg = (text: string, extra: Partial<GroupMsg> = {}): GroupMsg => ({ id: "m", groupId: "g@g.us", text, at: NOW, sender: { id: "919800000001@c.us", name: "Dhruv" }, mentioned: [], ...extra });
const ctx = { rooms: BLR_ROSTER.rooms, curators: BLR_ROSTER.curators, tz: TZ, now: NOW };
const parts = { date: "2026-10-27", time: "17:00", weekday: 2 };

describe("the prompt", () => {
  it("has the message, the comic's rooms with their other names, and the day", () => {
    const p = buildGroupPrompt(msg("Spots available for both 9:30 and 11 pm today at TAG. DM"), BLR_ROSTER.rooms, parts);
    expect(p).toContain("Message: Spots available for both 9:30 and 11 pm today at TAG. DM\nReply ONLY with JSON");
    expect(p).toContain("- Underground Comedy Club (Koramangala), also called: UGC");
    expect(p).toContain("Today is Tuesday 2026-10-27, 17:00 now");
    expect(p).toContain("written by Dhruv");
    for (const kind of ["spot_offer", "closure", "opening_notice", "schedule_update", "other"]) expect(p).toContain(kind);
  });
  it("cuts a long message and lists a long roster in full up to the cap", () => {
    expect(buildGroupPrompt(msg("x".repeat(2000)), [], parts)).toContain("x".repeat(600) + "…");
    expect(roomLines([], 5)).toBe("- (none yet)");
    expect(roomLines(BLR_ROSTER.rooms, 3).split("\n")).toHaveLength(3);
  });
});

describe("the model's answer", () => {
  it("is read from JSON, even with talk around it", () => {
    expect(parseAiRead('Sure! {"kind":"spot_offer","room":"TAG","show":"","contact":"sender","contact_name":""} hope that helps')).toEqual({ kind: "spot_offer", room: "TAG", show: "", contactKind: "sender", contactName: "" });
    expect(parseAiRead('```json\n{"kind":"closure","room":"","show":"","contact":"mentioned","contact_name":"Akhil"}\n```')).toMatchObject({ kind: "closure", contactKind: "mentioned", contactName: "Akhil" });
  });
  it("treats an unknown kind as other and a missing contact as the sender", () => {
    expect(parseAiRead('{"kind":"party"}')).toMatchObject({ kind: "other", contactKind: "sender" });
  });
  it("refuses an answer with no JSON", () => {
    expect(() => parseAiRead("I think it's a spot offer")).toThrow();
    expect(() => parseAiRead('{"kind": ')).toThrow();
  });
  it("feeds the rules: model says offer + room, the text gives times and day", () => {
    const m = msg("Spots at 7 and 9pm today at Banter comedy club. DM.");
    const r = interpret(parseAiRead('{"kind":"spot_offer","room":"Banter","show":"","contact":"sender","contact_name":""}'), m, ctx);
    expect(r.kind).toBe("spot_offer");
    if (r.kind === "spot_offer") expect(r.offer).toMatchObject({ times: ["19:00", "21:00"], date: "2026-10-27", roomName: "Banter Comedy Club" });
  });
});

describe("when the model can't answer", () => {
  const m = msg("One spot available at 10.30 at UGC today, DM");
  it("uses the model when it answers in time", async () => {
    const r = await readWithFallback(async () => '{"kind":"other","room":"","show":"","contact":"sender","contact_name":""}', m, 1000);
    expect(r).toMatchObject({ by: "model", read: { kind: "other" } });
  });
  it("falls back to the rules on an error, a bad answer or a slow model", async () => {
    const fail = await readWithFallback(async () => { throw new Error("ollama 500"); }, m, 1000);
    expect(fail).toMatchObject({ by: "rules", why: "ollama 500", read: { kind: "spot_offer" } });
    expect(await readWithFallback(async () => "not json", m, 1000)).toMatchObject({ by: "rules", read: { kind: "spot_offer" } });
    const slow = await readWithFallback(() => new Promise<string>(() => undefined), m, 20);
    expect(slow).toMatchObject({ by: "rules", read: { kind: "spot_offer" } });
    expect(slow.why).toMatch(/no answer/);
  });
});

describe("readGroupMessage: rules first", () => {
  const boom = () => {
    throw new Error("the model must not be called");
  };
  it("a confident offer never calls the model, even if the room isn't matched", async () => {
    let calls = 0;
    const ask = async () => (calls++, "{}");
    for (const t of ["Spots at 7 and 9 today at Banter, DM", "Spots at 7 today, DM"]) {
      const r = await readGroupMessage(ask, msg(t), ctx, 20_000);
      expect(r.path).toBe("rules-fast");
      expect(r.reading.kind).toBe("spot_offer");
    }
    expect(calls).toBe(0);
  });
  it("a confident closure never calls the model", async () => {
    const r = await readGroupMessage(boom as never, msg("Closed Thank you"), ctx, 20_000);
    expect(r.path).toBe("rules-fast");
    expect(r.reading.kind).toBe("closure");
  });
  it("doubtful messages go to the model; a dead model falls back to the rules", async () => {
    let calls = 0;
    const model = await readGroupMessage(async () => (calls++, '{"kind":"opening_notice","room":"ministry"}'), msg("ministry spots will open by 3:15pm"), ctx, 20_000);
    expect(calls).toBe(1);
    expect(model.path).toBe("model");
    expect(model.reading.kind).toBe("opening_notice");
    const down = await readGroupMessage(async () => { throw new Error("offline"); }, msg("Any spots available today?"), ctx, 20_000);
    expect(down.path).toBe("rules-fallback");
  });
});
