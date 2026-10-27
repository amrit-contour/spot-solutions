// "Ask for it" on a group alert makes an Ask the ordinary reply reader handles (stubbed model: no network).
import { describe, expect, it } from "vitest";
import { alertAsk, alertAskId, alertPatchForReply, alertSpotId, alertTakesReply, awaitingReply, missedReply, spotFromAsk, type SpotAlert } from "@spot/shared";
import { readAskReply } from "./askReplyPrompt.ts";

const alert: SpotAlert = {
  id: "g1__m1", groupId: "g1@g.us", messageId: "m1", poster: { id: "9198@c.us", name: "Dhruv" }, roomId: "tag-koramangala", roomName: "TAG", showId: "mic",
  date: "2026-10-27", times: ["21:30", "23:00"], contact: { id: "9198@c.us", name: "Dhruv", kind: "sender" }, expiresAt: 1, status: "asked", receivedAt: 0,
};
const sent = { body: "Hi Dhruv, I can do the 9:30 PM spot at TAG today!", time: "21:30", chatId: "9198@c.us", messageId: "true_9198@c.us_ABC", now: 1_000 };
const ctxOf = (a: ReturnType<typeof alertAsk>) => ({ curatorName: a.curatorName, roomName: a.roomName!, show: a.roomName!, showDate: a.showDate, time: a.time, asked: a.message ?? "" });
const model = (json: object) => async () => JSON.stringify(json);

describe("the Ask a group alert makes", () => {
  const ask = alertAsk(alert, sent);
  it("carries what the reply reader needs: contact chat, message id, sent time, show date and time", () => {
    expect(ask).toMatchObject({ id: alertAskId(alert.id), source: "group_alert", alertId: alert.id, status: "sent", sentAt: 1_000, chatId: "9198@c.us", messageId: "true_9198@c.us_ABC", showDate: "2026-10-27", time: "21:30", roomName: "TAG", curatorName: "Dhruv", roomId: "tag-koramangala", showId: "mic" });
    expect(awaitingReply(ask, "2026-10-27")).toBe(true);
    expect(missedReply(ask, "2026-10-28")).toBe(true);
  });
  it("works for a room the comic doesn't have (no ids) and takes the only time offered", () => {
    const a = alertAsk({ ...alert, roomId: undefined, showId: undefined, times: ["18:00"] }, { ...sent, time: undefined });
    expect(a).toMatchObject({ roomId: "", showId: "", time: "18:00" });
  });
  it("a yes (model stubbed) becomes the alert's spot and marks the alert got", async () => {
    const r = await readAskReply(ctxOf(ask), [{ text: "Yes you're on at 9:30, see you", at: 2_000, id: "m2" }], model({ decision: "got_it", time: "21:30", evidence: "Yes you're on at 9:30" }));
    expect(r).toMatchObject({ decision: "got_it", time: "21:30" });
    const spot = spotFromAsk(ask, { name: "TAG" }, r!.time, 3_000);
    expect(spot).toMatchObject({ id: alertSpotId(alert.id), source: "group_offer", alertId: alert.id, date: "2026-10-27", time: "21:30", roomName: "TAG" });
    expect(spot.askId).toBeUndefined();
    expect(alertPatchForReply(r!)).toMatchObject({ status: "got", reply: { decision: "got_it" } });
  });
  it("tapping 'I got it' as well can't make a second spot: both write the same id", () => {
    const viaTap = alertSpotId(alert.id);
    expect(spotFromAsk(ask, undefined, undefined, 1).id).toBe(viaTap);
  });
  it("a no marks the alert declined and makes no spot", async () => {
    const r = await readAskReply(ctxOf(ask), [{ text: "Sorry, full tonight", at: 2_000 }], model({ decision: "declined", time: "", evidence: "Sorry, full tonight" }));
    expect(alertPatchForReply(r!)).toMatchObject({ status: "declined", reply: { decision: "declined", text: "Sorry, full tonight" } });
  });
  it("an unclear reply only shows what they said; a model that invents evidence is ignored; an emoji is a yes to confirm", async () => {
    const u = await readAskReply(ctxOf(ask), [{ text: "will let you know", at: 2_000 }], model({ decision: "unclear", time: "", evidence: "" }));
    expect(alertPatchForReply(u!)).toEqual({ reply: expect.objectContaining({ decision: "unclear", text: "will let you know" }) });
    const lie = await readAskReply(ctxOf(ask), [{ text: "will let you know", at: 2_000 }], model({ decision: "got_it", time: "", evidence: "you're on" }));
    expect(lie?.decision).toBe("unclear");
    const e = await readAskReply(ctxOf(ask), [{ text: "👍", at: 2_000 }], async () => {
      throw new Error("no model for an emoji");
    });
    expect(alertPatchForReply(e!)).toMatchObject({ status: "got", reply: { unsure: true } });
  });
  it("a dismissed alert stays dismissed when the reply comes late", () => {
    expect(alertTakesReply({ status: "dismissed" })).toBe(false);
    expect(alertTakesReply({ status: "asked" })).toBe(true);
    expect(alertTakesReply({ status: "expired" })).toBe(true);
  });
});
