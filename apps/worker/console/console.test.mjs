import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAi, maskKey, pickModels, scrub, validKey, validModel } from "./ai.mjs";
import { connectLink, createConnect, qrSvg } from "./connect.mjs";
import { createUpdater, isUpdateAvailable, parseLatest, staggerMs } from "./update.mjs";

const SHA = "a".repeat(64);

describe("update checks", () => {
  it("accepts only a well-formed release", () => {
    expect(parseLatest({ version: "abc1234", sha256: SHA, builtAt: 5, model: "gemma3:4b" })).toMatchObject({ version: "abc1234", model: "gemma3:4b" });
    expect(parseLatest({ version: "abc1234", sha256: "nope" })).toBeNull();
    expect(parseLatest({ version: "a b; rm -rf /", sha256: SHA })).toBeNull();
    expect(parseLatest({ version: "abc1234", sha256: SHA, model: "x; y" }).model).toBeNull();
    expect(parseLatest(null)).toBeNull();
  });
  it("offers an update only to a released copy on a different version", () => {
    const latest = parseLatest({ version: "def5678", sha256: SHA });
    expect(isUpdateAvailable("abc1234", latest)).toBe(true);
    expect(isUpdateAvailable("def5678", latest)).toBe(false);
    expect(isUpdateAvailable("dev", latest)).toBe(false);
    expect(isUpdateAvailable("abc1234", null)).toBe(false);
  });
  it("staggers servers by a stable 0 to 10 minutes", () => {
    expect(staggerMs("studio-mac")).toBe(staggerMs("studio-mac"));
    expect(staggerMs("studio-mac")).toBeLessThan(600_000);
    expect(new Set(["a", "b", "c", "d", "e"].map(staggerMs)).size).toBeGreaterThan(1);
  });
  it("checks, starts once, and refuses a development copy", async () => {
    const data = mkdtempSync(path.join(os.tmpdir(), "spot-upd-"));
    const fetchImpl = async () => ({ ok: true, json: async () => ({ version: "def5678", sha256: SHA, builtAt: 1 }) });
    const u = createUpdater({ version: "abc1234", data, hostname: "h", platform: "linux", dryRun: true, fetchImpl, log: () => {} });
    await u.check();
    expect(u.view().available).toBe(true);
    expect(await u.start({ by: "test" })).toEqual({ ok: true });
    expect((await u.start({ by: "test" })).already).toBe(true);
    expect(JSON.parse(readFileSync(path.join(data, "task.json"), "utf8")).task).toBe("update");
    const dev = createUpdater({ version: "dev", data: mkdtempSync(path.join(os.tmpdir(), "spot-upd-")), hostname: "h", platform: "linux", dryRun: true, fetchImpl, log: () => {} });
    await expect(dev.start()).rejects.toThrow(/development copy/);
  });
  it("remembers the automatic-update switch, on by default", () => {
    const data = mkdtempSync(path.join(os.tmpdir(), "spot-upd-"));
    const u = createUpdater({ version: "abc1234", data, hostname: "h", platform: "linux", dryRun: true, log: () => {} });
    expect(u.view().autoUpdate).toBe(true);
    u.setAuto(false);
    expect(u.view().autoUpdate).toBe(false);
  });
  it("treats a run that stopped reporting as failed", () => {
    const data = mkdtempSync(path.join(os.tmpdir(), "spot-upd-"));
    writeFileSync(path.join(data, "update.json"), JSON.stringify({ state: "running", startedAt: 1 }));
    const u = createUpdater({ version: "abc1234", data, hostname: "h", platform: "linux", dryRun: true, now: () => 1 + 2 * 3_600_000, log: () => {} });
    expect(u.view().progress.state).toBe("error");
    expect(u.view().running).toBe(false);
  });
});

describe("AI models helpers", () => {
  it("masks and validates keys and names, and scrubs messages", () => {
    expect(maskKey("AIzaSyABCDEFGHIJKLMNOPQRSTUV1234")).toBe("••••1234");
    expect(validKey("AIzaSyABCDEFGHIJKLMNOPQRSTUV1234")).toBe(true);
    expect(validKey("short")).toBe(false);
    expect(validKey("has space AIzaSyABCDEFGHIJKLMNOPQRSTUV")).toBe(false);
    expect(validModel("gemma3:4b")).toBe(true);
    expect(validModel("x; rm -rf")).toBe(false);
    expect(scrub("bad key AIzaSyABCDEFGHIJKLMNOPQRSTUV1234 in url", "AIzaSyABCDEFGHIJKLMNOPQRSTUV1234")).not.toContain("AIza");
  });
  it("keeps text models, Gemini first and newest first", () => {
    const m = (name, g = ["generateContent"]) => ({ name: `models/${name}`, supportedGenerationMethods: g });
    expect(pickModels([m("gemma-3-27b-it"), m("gemini-2.0-flash"), m("gemini-2.5-pro"), m("text-embedding-004"), m("gemini-2.5-flash-image"), m("gemini-x", ["embedContent"])])).toEqual(["gemini-2.5-pro", "gemini-2.0-flash", "gemma-3-27b-it"]);
  });
  it("sends the key in a header, never the URL, and never echoes it", async () => {
    const seen = [];
    const key = "AIzaSyABCDEFGHIJKLMNOPQRSTUV1234";
    const fetchImpl = async (url, init) => {
      seen.push({ url: String(url), headers: init?.headers });
      return { ok: false, status: 403, json: async () => ({ error: { message: `API key ${key} not valid` } }) };
    };
    const env = { GEMINI_API_KEY: key };
    const ai = createAi({ readEnv: () => env, writeEnv: () => {}, restartWorker: async () => {}, ollamaUrl: "http://x", ollamaInfo: async () => ({ up: false, models: [] }), noLocalModel: () => false, fetchImpl });
    const err = await ai.listModels().catch((e) => e);
    expect(err.message).not.toContain(key);
    expect(seen[0].url).not.toContain("key=");
    expect(seen[0].headers["x-goog-api-key"]).toBe(key);
    expect(JSON.stringify(await ai.view())).not.toContain(key);
  });
  it("validates defaults before writing the .env", async () => {
    const writes = [];
    const ai = createAi({ readEnv: () => ({}), writeEnv: (p) => writes.push(p), restartWorker: async () => {}, ollamaUrl: "http://x", ollamaInfo: async () => ({ up: false, models: [] }), noLocalModel: () => false });
    await expect(ai.setDefaults({ mode: "nope" })).rejects.toThrow();
    await expect(ai.setDefaults({ localModel: "a b" })).rejects.toThrow();
    await ai.setDefaults({ mode: "gemini_first", localModel: "gemma3:1b", geminiModel: "gemini-2.5-flash" });
    expect(writes).toEqual([{ SPOT_AI_MODE: "gemini_first", SPOT_LOCAL_MODEL: "gemma3:1b", SPOT_GEMINI_MODEL: "gemini-2.5-flash" }]);
  });
});

describe("connect flow", () => {
  const link = (code, base = "https://spot-solutions.web.app") => connectLink(code, base);
  it("builds the link and a QR", () => {
    expect(link("K7QF3XM9PT2R")).toBe("https://spot-solutions.web.app/connect-server?c=K7QF3XM9PT2R");
    expect(qrSvg(link("K7QF3XM9PT2R"))).toMatch(/^<svg/);
  });
  it("sends only a hash of its secret, installs the key once approved, and keeps the secret out of its state", async () => {
    const calls = [];
    let polls = 0;
    let installed = null;
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ fn: String(url).split("/").pop(), body });
      if (String(url).endsWith("startDeviceLink")) return { ok: true, status: 200, json: async () => ({ ok: true, code: "K7QF3XM9PT2R", expiresAt: Date.now() + 900_000, verify: "K7QF" }) };
      polls++;
      return { ok: true, status: 200, json: async () => (polls < 2 ? { status: "pending" } : { status: "approved", approvedBy: "Admin@x.co", serviceAccount: "sa@x", key: { private_key: "PK" } }) };
    };
    const c = createConnect({ hostname: "h", fetchImpl, pollMs: 10, onApproved: async (a) => { installed = a; } });
    const s = await c.start("");
    expect(s.phase).toBe("waiting");
    expect(s.link).toContain("c=K7QF3XM9PT2R");
    await new Promise((r) => setTimeout(r, 120));
    expect(installed.key.private_key).toBe("PK");
    expect(c.state().phase).toBe("done");
    const start = calls[0].body;
    const poll = calls.find((x) => x.fn === "pollDeviceLink").body;
    expect(start.challenge).toBe(createHash("sha256").update(poll.secret).digest("hex"));
    expect(JSON.stringify(start)).not.toContain(poll.secret);
    expect(JSON.stringify(c.state())).not.toContain(poll.secret);
    expect(JSON.stringify(c.state())).not.toContain("PK");
  });
  it("reports a server error, and an expired link", async () => {
    const bad = async () => ({ ok: false, status: 429, json: async () => ({ error: "Too many attempts." }) });
    const c = createConnect({ hostname: "h", fetchImpl: bad, onApproved: async () => {} });
    expect((await c.start()).error).toBe("Too many attempts.");
    const gone = async (url) => (String(url).endsWith("startDeviceLink") ? { ok: true, status: 200, json: async () => ({ code: "K7QF3XM9PT2R", expiresAt: Date.now() + 900_000, verify: "K7QF" }) } : { ok: true, status: 200, json: async () => ({ status: "expired" }) });
    const c2 = createConnect({ hostname: "h", fetchImpl: gone, pollMs: 10, onApproved: async () => {} });
    await c2.start();
    await new Promise((r) => setTimeout(r, 80));
    expect(c2.state().phase).toBe("expired");
  });
});
