import { describe, expect, it } from "vitest";
import { agentHelpText, agentScope, chooseSide, cueSide, parseSideChoice, HELP_TEXT, COMIC_HELP_TEXT } from "./index.ts";

describe("agentScope", () => {
  it("curate: shows, venues, lineups or a Curate-app device", () => {
    for (const f of [{ shows: true }, { venues: true }, { lineups: true }, { curateDevice: true }]) expect(agentScope(f)).toEqual({ curate: true, comedy: false });
  });
  it("comedy: rooms, comic settings or a Comedy-app device", () => {
    for (const f of [{ rooms: true }, { comicSettings: true }, { comicDevice: true }]) expect(agentScope(f)).toEqual({ curate: false, comedy: true });
  });
  it("both", () => expect(agentScope({ shows: true, rooms: true })).toEqual({ curate: true, comedy: true }));
  it("a brand-new account is Curate (the agent existed there first)", () => expect(agentScope({})).toEqual({ curate: true, comedy: false }));
});

describe("cues and chooseSide", () => {
  it("reads each side's own words", () => {
    expect(cueSide("Monday lineup?")).toBe("curate");
    expect(cueSide("confirm Monday")).toBe("curate");
    expect(cueSide("who's waiting?")).toBe("curate");
    expect(cueSide("I got a spot at Banter tonight 9pm")).toBe("comedy");
    expect(cueSide("how many spots this month?")).toBe("comedy");
    expect(cueSide("any open spots now?")).toBe("comedy");
    expect(cueSide("ask TAG for Monday")).toBe("comedy");
    expect(cueSide("I'm a regular at Bloom Monday")).toBe("comedy");
    expect(cueSide("add Rohan to Tuesday")).toBe("curate");
    expect(cueSide("hmm")).toBeNull();
  });
  it("cues win; rules decide when there are no cues; both readable means ask; neither means the model", () => {
    expect(chooseSide("Monday lineup?", { curate: true, comedy: false })).toBe("curate");
    expect(chooseSide("I got a spot tonight", { curate: false, comedy: true })).toBe("comedy");
    expect(chooseSide("something", { curate: true, comedy: true })).toBe("ask");
    expect(chooseSide("something", { curate: true, comedy: false })).toBe("curate");
    expect(chooseSide("something", { curate: false, comedy: false })).toBe("model");
  });
  it("parses the answer to the side question", () => {
    expect(parseSideChoice("1")).toBe("curate");
    expect(parseSideChoice("2")).toBe("comedy");
    expect(parseSideChoice("Comedy")).toBe("comedy");
    expect(parseSideChoice("no")).toBe("cancel");
    expect(parseSideChoice("add Rohan to Monday")).toBeNull();
  });
});

describe("agentHelpText", () => {
  it("lists only the apps in use", () => {
    expect(agentHelpText({ curate: true, comedy: false })).toBe(HELP_TEXT);
    expect(agentHelpText({ curate: false, comedy: true })).toBe(COMIC_HELP_TEXT);
    const both = agentHelpText({ curate: true, comedy: true });
    expect(both).toContain("Monday lineup?");
    expect(both).toContain("I got a spot at Banter tonight");
  });
});
