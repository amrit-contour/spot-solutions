import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCloud, KEY_REJECTED, NOT_SIGNED_IN } from "./ollamacloud.mjs";
import { createNetProfile, parseNetProfile, psMakePrivate } from "./netprofile.mjs";

const KEY = "fake-test-key-0123456789ab12";
function setup({ env = {}, fetchImpl, live = () => null, localModels = async () => [] } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nbs-cloud-"));
  const file = path.join(dir, "ollama-cloud.json");
  const e = { ...env };
  let restarts = 0;
  const cloud = createCloud({ file, readEnv: () => ({ ...e }), writeEnv: (p) => Object.assign(e, p), restartWorker: async () => { restarts++; return true; }, ollamaUrl: "http://127.0.0.1:11434", live, localModels, now: () => 1000, fetchImpl });
  return { cloud, file, env: e, restarts: () => restarts };
}
const answer = (status, body) => async () => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

describe("Ollama Cloud settings (console)", () => {
  it("never returns the key, only its last 4 characters", async () => {
    const { cloud } = setup();
    const r = await cloud.save({ key: KEY, model: "beam:cloud", use: "primary" });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(r.view.key).toEqual({ hint: "ab12", savedAt: 1000, legacy: false });
    expect(r.view.model).toBe("beam"); // stored as ollama.com names it
    expect(r.restarted).toBe(true);
  });
  it("moves a key an older console put in .env into the file, and points OLLAMA_URL back at the local daemon", async () => {
    const { cloud, file, env } = setup({ env: { OLLAMA_URL: "https://ollama.com", OLLAMA_API_KEY: KEY } });
    expect((await cloud.view()).key).toMatchObject({ hint: "ab12", legacy: true });
    await cloud.save({ use: "fallback" });
    expect(JSON.parse(readFileSync(file, "utf8")).key).toBe(KEY);
    expect(env.OLLAMA_API_KEY).toBe("");
    expect(env.OLLAMA_URL).toBe("");
  });
  it("refuses a non-https URL, a junk key and an unknown use; removes the key", async () => {
    const { cloud, file } = setup();
    await expect(cloud.save({ url: "http://example.com" })).rejects.toThrow(/https/);
    await expect(cloud.save({ key: "short" })).rejects.toThrow(/Ollama API key/);
    await expect(cloud.save({ use: "always" })).rejects.toThrow(/use the cloud for/);
    await cloud.save({ key: KEY });
    await cloud.save({ removeKey: true });
    expect(JSON.parse(readFileSync(file, "utf8")).key).toBeUndefined();
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false); // atomic write leaves no temp file
  });
  it("Fetch models and Test call ollama.com with the bearer key", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, auth: init?.headers?.authorization, body: init?.body }); return url.endsWith("/api/tags") ? answer(200, { models: [{ name: "gpt-oss:20b" }, { name: "beam" }] })() : answer(200, { message: { content: "OK" } })(); };
    const { cloud } = setup({ fetchImpl });
    expect(await cloud.models({ key: KEY })).toEqual(["beam", "gpt-oss:20b"]);
    const t = await cloud.test({ key: KEY, model: "beam:cloud" });
    expect(t).toMatchObject({ reply: "OK", via: "ollama.com" });
    expect(calls[1]).toMatchObject({ url: "https://ollama.com/api/chat", auth: `Bearer ${KEY}` });
    expect(JSON.parse(calls[1].body).model).toBe("beam");
  });
  it("says what a 401 means: a bad key, or a local Ollama that isn't signed in", async () => {
    const { cloud } = setup({ fetchImpl: answer(401, { error: "unauthorized" }) });
    await expect(cloud.test({ key: KEY, model: "beam" })).rejects.toThrow(KEY_REJECTED);
    const local = [];
    const { cloud: noKey } = setup({ fetchImpl: async (url, init) => { local.push({ url, auth: init.headers.authorization, model: JSON.parse(init.body).model }); return answer(401, { error: "unauthorized" })(); } });
    await expect(noKey.test({ model: "beam" })).rejects.toThrow(NOT_SIGNED_IN);
    expect(local[0]).toEqual({ url: "http://127.0.0.1:11434/api/chat", auth: undefined, model: "beam:cloud" });
  });
  it("network failures say so and never echo the key", async () => {
    const dns = Object.assign(new TypeError(`fetch failed ${KEY}`), { cause: { code: "ENOTFOUND" } });
    const { cloud } = setup({ fetchImpl: async () => { throw dns; } });
    await expect(cloud.models({ key: KEY })).rejects.toThrow(/DNS/);
  });
  it("shows the account-key source and the worker's last 401, but not one from before the last save", async () => {
    const lv = { ollamaCloud: { source: "account", accounts: 2, keyHint: null, lastError: KEY_REJECTED, lastErrorAt: 500 } };
    const { cloud } = setup({ live: () => lv, localModels: async () => ["beam:cloud", "gemma3:4b"] });
    const v = await cloud.view();
    expect(v).toMatchObject({ source: "account", accountKeys: 2, lastError: KEY_REJECTED, localCloudModels: ["beam:cloud"] });
    await cloud.save({ key: KEY }); // savedAt 1000 > 500
    expect((await cloud.view()).lastError).toBeNull();
  });
});

describe("network profile (Windows)", () => {
  const read = JSON.stringify({ profiles: { name: "HomeWiFi", alias: "Wi-Fi", index: 12, category: "Public" }, rules: [{ enabled: "True", profile: "Private", action: "Allow" }] });
  it("finds a Public network and a firewall rule that misses Domain", () => {
    const v = parseNetProfile(read);
    expect(v.public).toEqual([{ name: "HomeWiFi", alias: "Wi-Fi", index: 12, category: "Public" }]);
    expect(v.firewall).toEqual({ found: true, ok: false, profiles: "Private" });
    expect(parseNetProfile(JSON.stringify({ profiles: [], rules: { enabled: "True", profile: "Domain, Private", action: "Allow" } })).firewall.ok).toBe(true);
    expect(parseNetProfile("not json")).toBeNull();
  });
  it("the fix only touches interfaces from our own read, and adds the rule for Private and Domain", () => {
    const s = psMakePrivate([12, "3; Remove-Item C:\\"]);
    expect(s).toContain("Set-NetConnectionProfile -InterfaceIndex 12 -NetworkCategory Private");
    expect(s).not.toContain("Remove-Item");
    expect(s).toContain("-Profile Private,Domain");
  });
  it("Make private reports PowerShell's real error", async () => {
    let n = 0;
    const ps = async () => (n++ === 1 ? { ok: true, out: JSON.stringify({ done: [], errors: ["interface 12: Access is denied."] }) } : { ok: true, out: read });
    await expect(createNetProfile({ platform: "win32", ps }).makePrivate()).rejects.toThrow(/Access is denied/);
    expect(await createNetProfile({ platform: "linux", ps }).view()).toBeNull();
  });
});
