import { describe, expect, it } from "vitest";
import type { Show, Venue } from "@spot/shared";
import { buildReconcilePrompt, parseReconcileDecision } from "./reconcilePrompt.ts";

const replies = ["Hey! Yes, you're on Monday at 8:30", "bring your own mic btw"];
const ids = ["mon", "tue"];

describe("parseReconcileDecision", () => {
  it("keeps a decision whose evidence is quoted from the curator's messages", () => {
    const d = parseReconcileDecision('{"decision":"gave_spot","show_id":"mon","evidence":"Yes, you\'re on Monday"}', replies, ids);
    expect(d).toEqual({ decision: "gave_spot", showId: "mon", evidence: "Yes, you're on Monday" });
  });
  it("drops invented evidence", () => {
    const d = parseReconcileDecision('{"decision":"declined","show_id":"","evidence":"sorry we are completely full"}', replies, ids);
    expect(d.decision).toBe("unclear");
  });
  it("forgets a show id the week doesn't have, but keeps the spot", () => {
    const d = parseReconcileDecision('{"decision":"gave_spot","show_id":"zzz","evidence":"you\'re on Monday"}', replies, ids);
    expect(d).toMatchObject({ decision: "gave_spot", showId: null });
  });
  it("treats junk and unclear as unclear", () => {
    expect(parseReconcileDecision("not json", replies, ids).decision).toBe("unclear");
    expect(parseReconcileDecision('{"decision":"unclear","show_id":"mon","evidence":"yes"}', replies, ids)).toEqual({ decision: "unclear", showId: null, evidence: "" });
  });
});

describe("buildReconcilePrompt", () => {
  const shows = [{ id: "mon", name: "Open Mic Monday", weekday: 1, startTime: "20:30", venueId: "v" }] as Show[];
  const venues = [{ id: "v", name: "Bloom", area: "Indiranagar" }] as Venue[];
  const p = buildReconcilePrompt({ replies, ask: "any spot monday?", shows, venues });
  it("gives the shows with day, time and venue, and numbers the curator's messages", () => {
    expect(p).toContain('show_id "mon": Open Mic Monday, Monday 20:30, venue Bloom (Indiranagar)');
    expect(p).toContain("1. Hey! Yes, you're on Monday at 8:30");
    expect(p).toContain("2. bring your own mic btw");
  });
});
