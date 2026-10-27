import { describe, expect, it } from "vitest";
import type { AgentIntent } from "@spot/shared";
import { curateIntent } from "./agentIntent.ts";

const boom = async (): Promise<AgentIntent> => {
  throw new Error("the model must not be called");
};

describe("curator intents: rules first, the model only when rules can't classify", () => {
  const paths: string[] = [];
  const log = (path: string, name: string) => paths.push(`${path}:${name}`);
  it.each([
    "did mic on Monday happen this week?",
    "how did Monday go",
    "Monday lineup?",
    "who's waiting?",
    "what's left to confirm?",
    "who asked for Tuesday?",
    "mark Monday as didn't happen",
    "Monday was cancelled",
    "add Rohan to Tuesday",
    "remove Rohan from Monday",
    "confirm Monday",
    "Bloom moved Thursday to 9 PM",
    "how many requests are waiting?",
    "did Monday not happen?",
  ])("%s never calls the model", async (t) => {
    const r = await curateIntent(t, boom, log);
    expect(r.intent.name).not.toBe("unknown");
  });
  it("the owner's message is a mic_status question, not an outcome", async () => {
    paths.length = 0;
    const r = await curateIntent("did mic on Monday happen this week?", boom, log);
    expect(r.intent).toEqual({ name: "mic_status", day: "monday" });
    expect(paths).toEqual(["rules:mic_status"]);
  });
  it("the model runs only when nothing matches, and is logged as such", async () => {
    paths.length = 0;
    const r = await curateIntent("zzz something odd", async () => ({ name: "lineup", day: "monday" }), log);
    expect(r.intent.name).toBe("lineup");
    expect(paths).toEqual(["model:lineup"]);
  });
  it("a model that picks a change for a question is overruled", async () => {
    const r = await curateIntent("is it true that Monday didn't go well, mark it off?", async () => ({ name: "outcome", day: "monday", happened: false }), log);
    expect(r.intent.name).toBe("unknown");
    expect(r.questionNote).toBe(true);
  });
  it("no model allowed: unknown, no call", async () => {
    const r = await curateIntent("zzz something odd", null, log);
    expect(r.intent.name).toBe("unknown");
  });
});
