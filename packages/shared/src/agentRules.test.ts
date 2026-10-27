import { describe, expect, it } from "vitest";
import { composeDigest, composeNotifyBatch, composeNotifyRich, confirmPending, formatMicStatus, isQuestion, parseIntentByRules, stepPending, strictNo, strictYes } from "./index.ts";

describe("yes / no, deterministic", () => {
  it.each(["yes", "Yes!", "y", "ok", "okay", "confirm", "do it", "go ahead", "haan", "haan ji", "ha", "👍", "✅", "yes please", "theek hai", "kar do"])("%s confirms", (t) => expect(strictYes(t)).toBe(true));
  it.each(["no", "no, cancel", "No cancel", "cancel", "stop", "never mind", "nahi", "na", "naa", "nope", "❌", "👎", "no thanks", "don't", "leave it", "nahi chahiye", "no stop"])("%s cancels", (t) => expect(strictNo(t)).toBe(true));
  it.each(["no one asked for Tuesday", "yes and add Rohan", "maybe", "what", "add Rohan to Monday"])("%s is neither", (t) => {
    expect(strictYes(t)).toBe(false);
    expect(strictNo(t)).toBe(false);
  });
  it("a pending confirmation: no / cancel / 'no, cancel' cancel, yes runs, other text is a new message", () => {
    const p = confirmPending({ type: "outcome", showId: "s", lineupId: "l", outcome: "canned" }, "Mark Monday as didn't happen?", 1000);
    for (const t of ["no", "no, cancel", "cancel", "nahi", "👎", "never mind"]) expect(stepPending(p, t, 2000).type).toBe("cancel");
    for (const t of ["yes", "haan", "👍", "✅", "do it"]) expect(stepPending(p, t, 2000).type).toBe("execute");
    expect(stepPending(p, "did mic on Monday happen this week?", 2000).type).toBe("drop");
    expect(stepPending(p, "yes", p.expiresAt + 1).type).toBe("expired");
  });
});

describe("question vs command", () => {
  it("the owner's message is a read-only question about Monday", () => {
    const i = parseIntentByRules("did mic on Monday happen this week?");
    expect(i).toEqual({ name: "mic_status", day: "monday" });
  });
  it.each([
    ["did Monday happen?", "mic_status"],
    ["was Monday cancelled?", "mic_status"],
    ["how did Monday go?", "mic_status"],
    ["did the Bloom mic happen", "mic_status"],
    ["has Thursday happened yet?", "mic_status"],
    ["did Monday not happen?", "mic_status"],
    ["how many requests are waiting?", "waiting"],
    ["who asked for Tuesday?", "asked"],
    ["what's pending?", "pending_confirm"],
  ])("%s is a question (%s), never a change", (t, name) => {
    expect(isQuestion(t)).toBe(true);
    expect(parseIntentByRules(t)?.name).toBe(name);
  });
  it.each([
    ["mark Monday as happened", "outcome", true],
    ["mark Monday as didn't happen", "outcome", false],
    ["Monday was cancelled", "outcome", false],
    ["Monday happened", "outcome", true],
    ["Monday didn't happen", "outcome", false],
  ])("%s is a command", (t, name, happened) => {
    expect(isQuestion(t)).toBe(false);
    expect(parseIntentByRules(t)).toMatchObject({ name, happened });
  });
  it("commands: add / remove / confirm / retime", () => {
    expect(parseIntentByRules("add Rohan to Tuesday")).toMatchObject({ name: "add", person: "rohan", day: "tuesday" });
    expect(parseIntentByRules("remove Rohan from Monday")?.name).toBe("remove");
    expect(parseIntentByRules("confirm Monday")?.name).toBe("confirm");
    expect(parseIntentByRules("Bloom moved Thursday to 9 PM")?.name).toBe("retime");
  });
  it("a question shaped like a command is never one", () => {
    expect(parseIntentByRules("did Rohan get added to Tuesday?")?.name).not.toBe("add");
    expect(parseIntentByRules("is Rohan on Monday?")?.name ?? "none").not.toMatch(/^(add|remove|outcome|confirm|retime)$/);
  });
});

describe("mic status answers", () => {
  const base = { showName: "Banter", date: "2026-10-26", time: "20:00" };
  it("from the outcome and mic check", () => {
    expect(formatMicStatus({ ...base, status: "confirmed", outcome: "happened" }, "2026-10-27")).toContain("yes, it happened");
    expect(formatMicStatus({ ...base, status: "confirmed", outcome: "canned" }, "2026-10-27")).toContain("didn't happen");
    expect(formatMicStatus({ ...base, status: "cancelled" }, "2026-10-27")).toContain("called off");
    expect(formatMicStatus({ ...base, status: "confirmed", micCheckSent: true }, "2026-10-27")).toContain("not marked yet");
    expect(formatMicStatus({ ...base, status: "confirmed" }, "2026-10-20")).toContain("hasn't happened yet");
  });
});

describe("notices: no repeats, one line per reason", () => {
  const why = "The AI couldn't read them (timeout). Trying again in a few minutes.";
  it("identical lines appear once", () => {
    const out = composeNotifyBatch([{ kind: "warn", text: `Couldn't read new messages from Ravi. ${why}` }, { kind: "warn", text: `Couldn't read new messages from Ravi. ${why}` }])!;
    expect(out.match(/Couldn't read/g)).toHaveLength(1);
  });
  it("the same reason about different people merges", () => {
    const out = composeNotifyBatch([{ kind: "warn", text: `Couldn't read new messages from Ravi. ${why}` }, { kind: "warn", text: `Couldn't read new messages from Priya. ${why}` }])!;
    expect(out).toBe(`Heads up: Couldn't read new messages from Ravi and Priya. ${why}`);
  });
  it("a repeated notice and the same sentence as a warning is one line", () => {
    const out = composeNotifyBatch([{ kind: "notice", text: "WhatsApp needs a scan." }, { kind: "warn", text: "whatsapp needs a scan" }])!;
    expect(out.match(/scan/gi)).toHaveLength(1);
  });
  it("requests mention people with an id, first names otherwise", () => {
    const r = composeNotifyRich([{ kind: "request", text: "Rohan Sharma Comic BLR", id: "91@c.us" }, { kind: "request", text: "Priya Nair" }])!;
    expect(r.text).toBe("2 new spot requests: @91, Priya.");
    expect(r.plain).toBe("2 new spot requests: Rohan, Priya.");
    expect(r.mentions).toEqual(["91@c.us"]);
  });
  it("the digest names people the same way", () => {
    const d = composeDigest({ today: "2026-10-26", todayShows: [{ showId: "s", showName: "Banter", weekday: 1, date: "2026-10-26", time: "20:00", slotCount: 5, status: "confirmed", names: ["Rohan Sharma", "Rohan Kapoor"] }], tomorrowShows: [], waiting: [{ name: "Priya Nair Comic BLR" }], updates: 0, unconfirmed: [] })!;
    expect(d).toContain("1. Rohan S.");
    expect(d).toContain("2. Rohan K.");
    expect(d).toContain("Priya");
    expect(d).not.toContain("Nair");
  });
});
