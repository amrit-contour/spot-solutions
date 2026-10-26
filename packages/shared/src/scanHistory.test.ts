import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./defaults.ts";
import { burstGapMs, burstWeek, clampScanDays, planScanMerge, scanHold, scanNeedsReading, splitBursts } from "./scanHistory.ts";
import type { InboundMessage, Intent, SpotRequest } from "./types.ts";

const msg = (id: string, at: number, body = "hi"): InboundMessage => ({ id, at, body });
const intent = (over: Partial<Intent> = {}): Intent => ({ isSpotRequest: true, confidence: 0.9, preferredDays: [], ...over });
const request = (over: Partial<SpotRequest> = {}): SpotRequest => ({
  id: "2026-10-26_c1",
  comicId: "c1",
  comicName: "Sam",
  weekOf: "2026-10-26",
  messages: [msg("a", 1000)],
  intent: intent({ confidence: 0.8, note: "wants a spot" }),
  status: "new",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe("clampScanDays", () => {
  it("keeps 1 to 21 and rounds", () => {
    expect(clampScanDays(7)).toBe(7);
    expect(clampScanDays(0)).toBe(1);
    expect(clampScanDays(99)).toBe(21);
    expect(clampScanDays(3.6)).toBe(4);
    expect(clampScanDays("14")).toBe(14);
  });
  it("falls back on junk", () => {
    expect(clampScanDays(undefined)).toBe(7);
    expect(clampScanDays("abc", 3)).toBe(3);
    expect(clampScanDays(NaN)).toBe(7);
  });
});

describe("splitBursts", () => {
  it("splits on a gap longer than the limit, oldest first", () => {
    const gap = burstGapMs(45);
    const m = [msg("c", 200_000), msg("a", 0), msg("b", 30_000), msg("d", 200_000 + 45_000)];
    const out = splitBursts(m, gap).map((b) => b.map((x) => x.id));
    expect(out).toEqual([["a", "b"], ["c", "d"]]);
  });
  it("a gap of exactly the limit stays in one burst", () => {
    expect(splitBursts([msg("a", 0), msg("b", 45_000)], 45_000)).toHaveLength(1);
    expect(splitBursts([msg("a", 0), msg("b", 45_001)], 45_000)).toHaveLength(2);
  });
  it("handles no messages and uses 45 s without a setting", () => {
    expect(splitBursts([], 1)).toEqual([]);
    expect(burstGapMs(undefined)).toBe(45_000);
    expect(burstGapMs(60)).toBe(60_000);
  });
});

describe("burstWeek", () => {
  it("uses the newest message and the rollover day", () => {
    // Mon 2026-10-26 12:00 UTC, with Wednesday rollover: still the week of the 26th.
    const mon = Date.UTC(2026, 9, 26, 12);
    expect(burstWeek([msg("a", mon)], "UTC", 3)).toBe("2026-10-26");
    // Thursday 2026-10-29: past the Wednesday rollover, so next week.
    const thu = Date.UTC(2026, 9, 29, 12);
    expect(burstWeek([msg("a", mon), msg("b", thu)], "UTC", 3)).toBe("2026-11-02");
  });
});

describe("planScanMerge", () => {
  it("creates a request from a clear burst", () => {
    const p = planScanMerge({ burst: [msg("b", 2), msg("a", 1)], intent: intent() });
    expect(p).toMatchObject({ action: "create" });
    if (p.action === "create") expect(p.messages.map((m) => m.id)).toEqual(["a", "b"]);
  });
  it("never stores chatter or non-request kinds", () => {
    expect(planScanMerge({ burst: [msg("a", 1)], intent: intent({ isSpotRequest: false, confidence: 0.1 }) })).toEqual({ action: "skip", reason: "not_a_request" });
    expect(planScanMerge({ burst: [msg("a", 1)], intent: intent({ kind: "cancel_spot" }) })).toEqual({ action: "skip", reason: "not_a_request" });
  });
  it("never touches placed, confirmed, closed or dismissed requests", () => {
    for (const status of ["assigned", "confirmed", "rejected", "dismissed"] as const) {
      expect(planScanMerge({ existing: request({ status }), burst: [msg("z", 5)], intent: intent() })).toEqual({ action: "skip", reason: "locked" });
    }
  });
  it("merges new messages into an open request, deduped, and keeps the clearer reading", () => {
    const existing = request({ status: "acked" });
    const p = planScanMerge({ existing, burst: [msg("a", 1000), msg("b", 2000, "thanks")], intent: intent({ confidence: 0.5, isSpotRequest: false, note: "thanks" }) });
    expect(p.action).toBe("update");
    if (p.action === "update") {
      expect(p.messages.map((m) => m.id)).toEqual(["a", "b"]);
      expect(p.intent.confidence).toBe(0.8);
      expect(p.intent.note).toBe("thanks");
    }
  });
  it("takes a stronger new reading", () => {
    const p = planScanMerge({ existing: request(), burst: [msg("b", 2000)], intent: intent({ confidence: 0.95, note: "clear" }) });
    if (p.action === "update") expect(p.intent.confidence).toBe(0.95);
    else throw new Error("expected update");
  });
  it("does nothing when every message is already there", () => {
    expect(planScanMerge({ existing: request(), burst: [msg("a", 1000)], intent: intent() })).toEqual({ action: "skip", reason: "no_new_messages" });
  });
  it("caps stored context", () => {
    const burst = Array.from({ length: 20 }, (_, i) => msg(`m${i}`, i));
    const p = planScanMerge({ burst, intent: intent(), maxContext: 12 });
    if (p.action === "create") expect(p.messages).toHaveLength(12);
    else throw new Error("expected create");
  });
});

describe("scanNeedsReading", () => {
  it("skips locked requests and fully seen bursts without a model call", () => {
    expect(scanNeedsReading(request({ status: "confirmed" }), [msg("z", 1)])).toBe(false);
    expect(scanNeedsReading(request(), [msg("a", 1000)])).toBe(false);
    expect(scanNeedsReading(request(), [msg("b", 2000)])).toBe(true);
    expect(scanNeedsReading(undefined, [msg("b", 2000)])).toBe(true);
    expect(scanNeedsReading(undefined, [])).toBe(false);
  });
});

describe("scanHold", () => {
  const rules = { ...DEFAULT_SETTINGS.rules, window: { enabled: true, startDay: 1 as const, startTime: "00:00", endDay: 2 as const, endTime: "23:59" } };
  it("holds an old burst sent outside the window instead of dropping it", () => {
    const sat = Date.UTC(2026, 9, 24, 12); // Saturday
    expect(scanHold({ week: "2026-10-19", burst: [msg("a", sat)], rules, timeZone: "UTC" })).toBe("midweek");
  });
  it("lets an in-window burst through and holds banned senders", () => {
    const mon = Date.UTC(2026, 9, 26, 12);
    expect(scanHold({ week: "2026-10-26", burst: [msg("a", mon)], rules, timeZone: "UTC" })).toBeNull();
    expect(scanHold({ week: "2026-10-26", burst: [msg("a", mon)], rules, timeZone: "UTC", comic: { id: "c", name: "x", tier: "open", lastPerformedWeek: null, regularOf: [], list: "banned" } as never })).toBe("banned");
  });
  it("keeps an existing request's hold as the curator left it", () => {
    expect(scanHold({ existing: { hold: null, holdOverridden: true }, week: "w", burst: [msg("a", 1)], rules, timeZone: "UTC" })).toBeNull();
    expect(scanHold({ existing: { hold: "banned" }, week: "w", burst: [msg("a", 1)], rules, timeZone: "UTC" })).toBe("banned");
  });
});
