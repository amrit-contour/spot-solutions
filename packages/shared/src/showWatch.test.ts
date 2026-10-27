import { describe, expect, it } from "vitest";
import {
  AUTO_CANCEL_CONFIDENCE,
  DEFAULT_SHOW_WATCH,
  cancelDecision,
  etaFromText,
  liveActive,
  liveExpireAt,
  liveLabel,
  mergeLive,
  parseLiveRead,
  pickWatchLineup,
  prefilter,
  rulesRead,
  showWatchOf,
  strongCancel,
  worthRaising,
  type CancelInput,
  type SlotLive,
} from "./showWatch.ts";

const TZ = "Asia/Kolkata";
// 2026-10-28 19:30 IST
const AT = Date.UTC(2026, 9, 28, 14, 0);

describe("prefilter", () => {
  it.each([
    ["running late, stuck in traffic", "late"],
    ["bro 10 mins late", "late"],
    ["thoda late ho jaunga", "late"],
    ["on my way", "late"],
    ["can't make it tonight", "cancel"],
    ["can’t make it tonight", "cancel"],
    ["aaj nahi aa paunga bhai", "cancel"],
    ["please cancel my spot", "cancel"],
    ["need to drop out", "cancel"],
    ["can someone take my spot?", "swap"],
    ["can we swap slots", "swap"],
    ["reached the venue", "here"],
    ["I'm here", "here"],
    ["pahunch gaya", "here"],
    ["what time am I going on?", "question"],
  ])("%s -> %s", (text, kind) => {
    expect(prefilter(text)).toContain(kind);
  });

  it("lets ordinary chat through to nothing, so the model is never asked", () => {
    for (const t of ["great show last night everyone", "who's hosting tomorrow", "lol", "see you all there", "Spots available at Banter tonight 9pm DM", "", "   "]) {
      expect(prefilter(t)).toEqual([]);
    }
  });

  it("ignores long forwards and announcements", () => {
    expect(prefilter(`running late ${"x".repeat(700)}`)).toEqual([]);
  });

  it("puts a cancel before a late when both are there", () => {
    expect(prefilter("running late, actually can't make it")[0]).toBe("cancel");
  });
});

describe("strongCancel", () => {
  it("accepts a plain cancellation", () => {
    expect(strongCancel("Sorry, can't make it tonight")).toBe(true);
    expect(strongCancel("aaj nahi aa paunga, please remove my name")).toBe(true);
  });
  it("refuses questions, conditions and negations", () => {
    for (const t of ["can I cancel if I'm late?", "I'm not cancelling", "don't cancel my spot", "what's the cancel policy", "agar late hua toh cancel kar dena", "what if I can't make it", "cancel?"]) {
      expect(strongCancel(t)).toBe(false);
    }
  });
});

describe("parseLiveRead", () => {
  const msg = "stuck in traffic, 15 mins late";
  it("takes a real quote", () => {
    expect(parseLiveRead(JSON.stringify({ evidence: "stuck in traffic", kind: "late", confidence: 0.93 }), msg)).toEqual({ kind: "late", confidence: 0.93 });
  });
  it("finds the JSON in chatter and clamps confidence", () => {
    expect(parseLiveRead(`Sure! {"evidence":"15 mins late","kind":"late","confidence":7} done`, msg)?.confidence).toBe(1);
  });
  it("drops 'other', unknown kinds and quotes that aren't in the message", () => {
    expect(parseLiveRead(JSON.stringify({ evidence: "", kind: "other", confidence: 0.9 }), msg)).toBeNull();
    expect(parseLiveRead(JSON.stringify({ evidence: "stuck in traffic", kind: "dance", confidence: 0.9 }), msg)).toBeNull();
    expect(parseLiveRead(JSON.stringify({ evidence: "I will cancel my spot", kind: "cancel", confidence: 0.99 }), msg)).toBeNull();
  });
  it("throws on a reply that isn't JSON, so the keywords take over", () => {
    expect(() => parseLiveRead("I think they are late", msg)).toThrow();
  });
  it("keyword reading is never sure enough to act", () => {
    const r = rulesRead("sorry can't make it tonight");
    expect(r?.kind).toBe("cancel");
    expect(r!.confidence).toBeLessThan(AUTO_CANCEL_CONFIDENCE);
    expect(rulesRead("can I cancel if I'm late?")).toBeNull();
    expect(rulesRead("good show")).toBeNull();
  });
});

describe("etaFromText", () => {
  it("counts minutes from when they wrote it", () => {
    expect(etaFromText("10 mins late", AT, TZ, "20:00")).toBe("19:40");
    expect(etaFromText("will be there in half an hour", AT, TZ)).toBe("20:00");
    expect(etaFromText("aadha ghanta lagega", AT, TZ)).toBe("20:00");
  });
  it("reads a clock time, pm for an evening show", () => {
    expect(etaFromText("reaching by 8:40", AT, TZ, "20:00")).toBe("20:40");
    expect(etaFromText("will reach at 9", AT, TZ, "20:00")).toBe("21:00");
    expect(etaFromText("8:40pm", AT, TZ)).toBe("20:40");
    expect(etaFromText("by 9am sharp", AT, TZ)).toBe("09:00");
  });
  it("gives nothing when no time was said", () => {
    expect(etaFromText("stuck in traffic", AT, TZ, "20:00")).toBeNull();
    expect(etaFromText("running late sorry", AT, TZ)).toBeNull();
  });
});

describe("one message, one pill", () => {
  const live = (o: Partial<SlotLive> = {}): SlotLive => ({ kind: "late", at: 1000, msgId: "m1", snippet: "late", expireAt: 9e12, ...o });
  it("sets the first pill", () => {
    expect(mergeLive(undefined, live())?.msgId).toBe("m1");
  });
  it("the same message again changes nothing (no second pill, no second notice)", () => {
    expect(mergeLive(live(), live())).toBeNull();
    expect(mergeLive(live(), live({ eta: "20:40" }))).toBeNull();
  });
  it("an older message never replaces a newer one", () => {
    expect(mergeLive(live({ at: 2000 }), live({ msgId: "m0", at: 1000 }))).toBeNull();
  });
  it("a newer message updates the pill", () => {
    expect(mergeLive(live(), live({ msgId: "m2", at: 2000, eta: "20:40" }))?.eta).toBe("20:40");
    expect(mergeLive(live(), live({ msgId: "m2", at: 2000, kind: "here" }))?.kind).toBe("here");
  });
  it("an unhandled cancel is not buried by a later late, swap or question, but 'here' replaces it", () => {
    const c = live({ kind: "cancel" });
    expect(mergeLive(c, live({ msgId: "m2", at: 2000, kind: "late" }))).toBeNull();
    expect(mergeLive(c, live({ msgId: "m3", at: 2000, kind: "swap" }))).toBeNull();
    expect(mergeLive(c, live({ msgId: "m4", at: 2000, kind: "here" }))?.kind).toBe("here");
    expect(mergeLive({ ...c, handled: "ignored" }, live({ msgId: "m5", at: 2000, kind: "late" }))?.kind).toBe("late");
  });
  it("pills expire after the show and hide when ignored", () => {
    const exp = liveExpireAt("2026-10-28", "20:00", TZ, AT);
    expect(exp).toBe(Date.UTC(2026, 9, 28, 14, 30) + 6 * 3_600_000);
    expect(liveActive(live({ expireAt: exp }), AT)).toBe(true);
    expect(liveActive(live({ expireAt: exp }), exp + 1)).toBe(false);
    expect(liveActive(live({ expireAt: exp, handled: "ignored" }), AT)).toBe(false);
    expect(liveActive(null, AT)).toBe(false);
  });
  it("labels", () => {
    expect(liveLabel({ kind: "late", eta: "20:40" }, "8:40 PM")).toBe("Running late · ETA 8:40 PM");
    expect(liveLabel({ kind: "late" })).toBe("Running late");
    expect(liveLabel({ kind: "here" })).toBe("Here ✓");
  });
});

describe("settings", () => {
  it("defaults: off overall, late and cancel on", () => {
    expect(showWatchOf(undefined)).toEqual(DEFAULT_SHOW_WATCH);
    expect(DEFAULT_SHOW_WATCH.enabled).toBe(false);
    expect(DEFAULT_SHOW_WATCH.kinds).toMatchObject({ late: true, cancel: true, swap: false, here: false });
  });
  it("merges a partial doc", () => {
    expect(showWatchOf({ showWatch: { enabled: true, kinds: { swap: true } as never } })).toMatchObject({ enabled: true, kinds: { late: true, cancel: true, swap: true, here: false } });
  });
  it("worthRaising: the master switch, the kind's switch and the floor", () => {
    const on = { enabled: true, kinds: { ...DEFAULT_SHOW_WATCH.kinds } };
    expect(worthRaising({ kind: "late", confidence: 0.8 }, on)).toBe(true);
    expect(worthRaising({ kind: "late", confidence: 0.3 }, on)).toBe(false);
    expect(worthRaising({ kind: "here", confidence: 0.9 }, on)).toBe(false);
    expect(worthRaising({ kind: "late", confidence: 0.9 }, { ...on, enabled: false })).toBe(false);
  });
});

describe("pickWatchLineup", () => {
  const l = (date: string, status = "confirmed", backfilled = false) => ({ date, status, backfilled });
  it("takes tonight's, else the next one; never past, called off or recorded ones", () => {
    expect(pickWatchLineup([l("2026-10-21"), l("2026-11-04"), l("2026-10-28")], "2026-10-28")?.date).toBe("2026-10-28");
    expect(pickWatchLineup([l("2026-10-21"), l("2026-11-04")], "2026-10-28")?.date).toBe("2026-11-04");
    expect(pickWatchLineup([l("2026-10-28", "cancelled"), l("2026-10-28", "canned"), l("2026-10-28", "draft", true)], "2026-10-28")).toBeNull();
  });
});

describe("cancelDecision: when a cancel runs the flow by itself", () => {
  const base = (o: Partial<CancelInput> = {}): CancelInput => ({
    watch: { enabled: true, kinds: { ...DEFAULT_SHOW_WATCH.kinds } },
    selfService: { enabled: true, autoSend: true },
    read: { kind: "cancel", confidence: 0.95 },
    rulesOnly: false,
    text: "sorry can't make it tonight",
    age: 60_000,
    upcoming: true,
    ...o,
  });
  it("runs when every guard holds", () => {
    expect(cancelDecision(base())).toBe("auto");
  });
  it("only suggests when the curator hasn't enabled the automatic flow", () => {
    expect(cancelDecision(base({ selfService: { enabled: true, autoSend: false } }))).toBe("suggest");
    expect(cancelDecision(base({ selfService: { enabled: false, autoSend: true } }))).toBe("suggest");
  });
  it("only suggests below the confidence threshold, and ignores noise below the floor", () => {
    expect(cancelDecision(base({ read: { kind: "cancel", confidence: 0.84 } }))).toBe("suggest");
    expect(cancelDecision(base({ read: { kind: "cancel", confidence: 0.5 } }))).toBe("suggest");
    expect(cancelDecision(base({ read: { kind: "cancel", confidence: 0.49 } }))).toBe("ignore");
  });
  it("never acts on the keywords alone, on a stale or replayed message, or on a show that is over", () => {
    expect(cancelDecision(base({ rulesOnly: true }))).toBe("suggest");
    expect(cancelDecision(base({ age: 11 * 60_000 }))).toBe("suggest");
    expect(cancelDecision(base({ upcoming: false }))).toBe("suggest");
  });
  it("never acts on a question, a condition or a negation even when the model is sure", () => {
    for (const text of ["can I cancel if I'm late?", "I'm not cancelling", "cancel?"]) expect(cancelDecision(base({ text }))).toBe("suggest");
  });
  it("is off when the watch or its cancel switch is off, and for other kinds", () => {
    expect(cancelDecision(base({ watch: { enabled: false, kinds: { ...DEFAULT_SHOW_WATCH.kinds } } }))).toBe("ignore");
    expect(cancelDecision(base({ watch: { enabled: true, kinds: { ...DEFAULT_SHOW_WATCH.kinds, cancel: false } } }))).toBe("ignore");
    expect(cancelDecision(base({ read: { kind: "late", confidence: 0.99 } }))).toBe("ignore");
  });
});
