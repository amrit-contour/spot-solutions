import { describe, expect, it } from "vitest";
import { COMIC_PUSH_KEY_OF, COMIC_PUSH_KEYS, askSendFromOf, askVoiceDefault, comicPushOn } from "./comicSettings.ts";
import { askDue, planAsks } from "./asks.ts";
import type { Curator, Room } from "./rooms.ts";

describe("comicPushOn", () => {
  it("is on for everything by default", () => {
    for (const k of Object.keys(COMIC_PUSH_KEY_OF)) {
      expect(comicPushOn(undefined, k)).toBe(true);
      expect(comicPushOn({}, k)).toBe(true);
      expect(comicPushOn({ push: {} }, k)).toBe(true);
    }
  });
  it("switches off only the kind that was turned off", () => {
    const s = { push: { askClosing: false, opening: false } };
    expect(comicPushOn(s, "ask_closing")).toBe(false);
    expect(comicPushOn(s, "spot_opening")).toBe(false);
    expect(comicPushOn(s, "spot_alert")).toBe(true);
    expect(comicPushOn(s, "ask_open")).toBe(true);
    expect(comicPushOn(s, "ask_reply")).toBe(true);
  });
  it("never silences a kind it doesn't know (a test push)", () => {
    expect(comicPushOn({ push: { spotAlert: false } }, "test")).toBe(true);
  });
  it("covers every setting with a kind", () => {
    expect(Object.values(COMIC_PUSH_KEY_OF).sort()).toEqual([...COMIC_PUSH_KEYS].sort());
  });
});

describe("ask settings", () => {
  it("send time defaults to 9 AM and ignores junk", () => {
    expect(askSendFromOf(undefined)).toBe("09:00");
    expect(askSendFromOf({ askSendFrom: "nope" })).toBe("09:00");
    expect(askSendFromOf({ askSendFrom: "25:00" })).toBe("09:00");
    expect(askSendFromOf({ askSendFrom: "7:30" })).toBe("07:30");
    expect(askSendFromOf({ askSendFrom: "18:15" })).toBe("18:15");
  });
  it("voice is on unless switched off", () => {
    expect(askVoiceDefault(undefined)).toBe(true);
    expect(askVoiceDefault({ askVoice: false })).toBe(false);
    expect(askVoiceDefault({ askVoice: true })).toBe(true);
  });
});

describe("the send time moves when an auto ask goes out", () => {
  const TZ = "Asia/Kolkata";
  const at = (iso: string) => new Date(`${iso}+05:30`);
  const curators: Curator[] = [{ id: "adi", name: "Adi", phone: "+91 98765 43210" }];
  const room: Room = {
    id: "r", name: "Bloom", area: "A", city: "B", aliases: [], tags: [], notes: [], limits: [], askMode: "auto",
    shows: [{ id: "m", name: "Mic", type: "mic", cadence: "weekly", times: ["20:00"], days: [{ weekday: 4, curatorIds: ["adi"] }], askRule: { kind: "weekday", day: 1, morning: true } }],
  };
  // Monday 26 Oct 2026 is the ping day for Thursday 29 Oct.
  const run = (nowIso: string, sendFrom?: string) => {
    const now = at(nowIso);
    const a = planAsks([room], curators, { from: "2026-10-26", to: "2026-10-29" }, now, TZ, { sendFrom }).find((p) => p.showDate === "2026-10-29")!;
    return { a, due: askDue(a, now.getTime()) };
  };
  it("default 9 AM", () => {
    expect(run("2026-10-26T08:30:00").due).toBeNull();
    expect(run("2026-10-26T09:30:00").due).toBe("send");
  });
  it("a later start holds the send", () => {
    expect(run("2026-10-26T09:30:00", "11:00").due).toBeNull();
    expect(run("2026-10-26T11:05:00", "11:00").due).toBe("send");
  });
  it("an earlier start sends sooner", () => {
    expect(run("2026-10-26T07:30:00", "07:00").due).toBe("send");
  });
});
