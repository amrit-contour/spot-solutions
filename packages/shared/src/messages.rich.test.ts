import { describe, expect, it } from "vitest";
import { cleanPoll, messageRich, messageTemplate, normalizeMessage, offerVote, pollProblem, renderRich, snippetRich, storeMessage } from "./messages.ts";

describe("backward-compatible parsing", () => {
  it("reads a plain string override as text", () => {
    expect(messageRich({ messages: { cancelNone: "No spot, {{name}}." } }, "cancelNone")).toEqual({ kind: "text", body: "No spot, {{name}}." });
    expect(messageTemplate({ messages: { cancelNone: "No spot, {{name}}." } }, "cancelNone")).toBe("No spot, {{name}}.");
  });
  it("falls back to the default when nothing (or only spaces) is saved", () => {
    expect(messageRich({ messages: {} }, "cancelNone").kind).toBe("text");
    expect(messageRich({ messages: { cancelNone: "  " } }, "cancelNone").body).toContain("nothing to cancel");
  });
  it("offers are polls by default, with text as the fallback body", () => {
    const m = messageRich({}, "offer");
    expect(m.kind).toBe("poll");
    expect(m.poll?.options).toEqual(["Yes, I'll take it", "Pass"]);
    expect(m.body).toContain("Reply *yes* or *no*");
  });
  it("a string override of the offer is text, as before", () => {
    expect(messageRich({ messages: { offer: "Want it, {{name}}?" } }, "offer")).toEqual({ kind: "text", body: "Want it, {{name}}?" });
  });
  it("reads object overrides and keeps the location toggle", () => {
    const m = normalizeMessage({ kind: "text", body: "Hi", attachLocation: true });
    expect(m).toEqual({ kind: "text", body: "Hi", attachLocation: true });
    expect(normalizeMessage({ kind: "poll", body: "", poll: { question: "Q", options: ["a", "b"], multi: true } }).poll?.multi).toBe(true);
    expect(normalizeMessage({ kind: "location", body: "" }).kind).toBe("location");
  });
  it("ignores junk", () => {
    expect(normalizeMessage(42, { kind: "text", body: "x" })).toEqual({ kind: "text", body: "x" });
    expect(normalizeMessage({ kind: "bogus", body: "ok" }).kind).toBe("text");
  });
  it("saved snippets without a kind are text", () => {
    expect(snippetRich({ id: "1", title: "t", body: "hello" })).toEqual({ kind: "text", body: "hello" });
    expect(snippetRich({ id: "1", title: "t", body: "", kind: "poll", poll: { question: "Q?", options: ["a", "b"], multi: false } }).kind).toBe("poll");
  });
});

describe("poll validation", () => {
  const ok = { question: "Which night?", options: ["Mon", "Tue"], multi: false };
  it("accepts 2 to 12 options", () => {
    expect(pollProblem(ok)).toBeNull();
    expect(pollProblem({ ...ok, options: Array.from({ length: 12 }, (_, i) => `o${i}`) })).toBeNull();
  });
  it("rejects a missing question, too few, too many, repeats and long options", () => {
    expect(pollProblem({ ...ok, question: " " })).toMatch(/question/);
    expect(pollProblem({ ...ok, options: ["only", " "] })).toMatch(/at least 2/);
    expect(pollProblem({ ...ok, options: Array.from({ length: 13 }, (_, i) => `o${i}`) })).toMatch(/at most 12/);
    expect(pollProblem({ ...ok, options: ["Mon", "mon"] })).toMatch(/same/);
    expect(pollProblem({ ...ok, options: ["a", "x".repeat(101)] })).toMatch(/100/);
    expect(pollProblem(undefined)).toBeTruthy();
  });
  it("cleans a poll before sending", () => {
    expect(cleanPoll({ question: " Q ", options: [" a ", "", "A", "b"], multi: true })).toEqual({ question: "Q", options: ["a", "b"], multi: true });
  });
});

describe("rendering and votes", () => {
  it("fills variables in the question and options", () => {
    const r = renderRich({ kind: "poll", body: "", poll: { question: "{{name}}, {{show}}?", options: ["Yes for {{day}}", "Pass"], multi: false } }, { name: "Rohan", show: "Monday Mic", day: "Monday" });
    expect(r.poll).toEqual({ question: "Rohan, Monday Mic?", options: ["Yes for Monday", "Pass"], multi: false });
  });
  it("maps offer votes to a decision", () => {
    const opts = ["Yes, I'll take it", "Pass"];
    expect(offerVote(["Yes, I'll take it"], opts)).toBe(true);
    expect(offerVote(["Pass"], opts)).toBe(false);
    expect(offerVote([], opts)).toBeNull();
    expect(offerVote(["Something else"], opts)).toBeNull();
  });
});

describe("storing", () => {
  it("keeps plain text as a string so older apps still read it", () => {
    expect(storeMessage({ kind: "text", body: "Hi" })).toBe("Hi");
  });
  it("stores kinds and the location toggle as objects, and they read back the same", () => {
    const poll = { kind: "poll" as const, body: "", poll: { question: "Q", options: ["a", " ", "b"], multi: true } };
    expect(normalizeMessage(storeMessage(poll)).poll?.options).toEqual(["a", "b"]);
    const withPin = { kind: "text" as const, body: "Hi", attachLocation: true };
    expect(normalizeMessage(storeMessage(withPin))).toEqual(withPin);
  });
});
