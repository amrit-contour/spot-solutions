import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIRM_TEMPLATE, renderTemplate } from "./template.ts";
import { looksLikeTemplate, pickVoiceSamples, voiceDraftProblem } from "./voice.ts";

const facts = { name: "Rohan", show: "Monday Mic", venue: "The Laugh Store", day: "Monday", date: "27 Oct", time: "8:30 PM", minutes: 5 };
const reference = renderTemplate(DEFAULT_CONFIRM_TEMPLATE, facts);

describe("voiceDraftProblem", () => {
  it("accepts a reworded message with every fact", () => {
    expect(voiceDraftProblem("Rohan bhai you're on! 🎤 Monday Mic, Monday 27 Oct at 8:30 pm, The Laugh Store. 5 min set, see you there", reference, facts)).toBeNull();
  });
  it("rejects a changed time", () => {
    expect(voiceDraftProblem("Rohan you're on! Monday Mic, Monday 27 Oct at 9:30 PM, The Laugh Store. 5 min", reference, facts)).toMatch(/time|number/);
  });
  it("rejects a dropped venue", () => {
    expect(voiceDraftProblem("Rohan you're on! Monday Mic, Monday 27 Oct at 8:30 PM. 5 min", reference, facts)).toBe("missing venue");
  });
  it("rejects invented numbers and links", () => {
    expect(voiceDraftProblem("Rohan you're on! Monday Mic, Monday 27 Oct at 8:30 PM, The Laugh Store, 5 min. Come by 7", reference, facts)).toBe("new number 7");
    expect(voiceDraftProblem("Rohan you're on! Monday Mic, Monday 27 Oct 8:30 PM The Laugh Store 5 min https://x.y", reference, facts)).toBe("new link");
  });
  it("rejects a ballooned message", () => {
    expect(voiceDraftProblem(`${reference} ${"blah ".repeat(80)}`, reference, facts)).toBe("too long");
  });
  it("doesn't require facts the template didn't use", () => {
    expect(voiceDraftProblem("Yo Rohan, got your ask 🙌 will confirm soon", "Hey Rohan! Got your spot request 🙌 Will get back with confirmation.", { name: "Rohan", show: "Monday Mic" })).toBeNull();
  });
});

describe("samples", () => {
  it("keeps real sentences, masks numbers, drops links and one-worders", () => {
    const out = pickVoiceSamples([
      { body: "ok", at: 1 },
      { body: "https://maps.app.goo.gl/xyz", at: 2 },
      { body: "Bhai Monday full ho gaya, Tuesday chalega?", at: 3 },
      { body: "Call me on +91 98450 12345 bro", at: 4 },
      { body: "Bhai Monday full ho gaya, Tuesday chalega?", at: 5 },
    ]);
    expect(out).toEqual(["Bhai Monday full ho gaya, Tuesday chalega?", "Call me on <number> bro"]);
  });
  it("spots messages the app sent from a template", () => {
    expect(looksLikeTemplate(reference, [DEFAULT_CONFIRM_TEMPLATE])).toBe(true);
    expect(looksLikeTemplate("Bhai Monday full ho gaya, Tuesday chalega?", [DEFAULT_CONFIRM_TEMPLATE])).toBe(false);
  });
});
