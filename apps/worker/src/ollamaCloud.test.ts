import { describe, expect, it } from "vitest";
import type { AiRoute } from "@spot/shared";
import {
  DEFAULT_CLOUD_URL, DEFAULT_LOCAL_OLLAMA, KEY_REJECTED, NOT_SIGNED_IN, cloudApiModel, cloudRouteName, describeOllamaError, isCloudModelName, isCloudUrl,
  localOllamaUrl, localTimeoutMs, ollamaTarget, resolveCloud, validCloudUrl, withCloudRoutes, type CloudConfig,
} from "./ollamaCloud.ts";
import { planRoutes } from "./aiRouting.ts";
// @ts-expect-error the console is plain .mjs
import * as consoleCloud from "../console/ollamacloud.mjs";

const cloud = (extra: Partial<CloudConfig> = {}): CloudConfig => ({ url: DEFAULT_CLOUD_URL, key: "sk-test-ab12", source: "server", model: "beam", use: "primary", ...extra });
const local: AiRoute = { provider: "ollama", model: "gemma3:4b" };
const gem: AiRoute = { provider: "gemini", model: "gemini-2.5-flash" };

describe("cloud model names", () => {
  it("knows a cloud model by its :cloud or -cloud suffix", () => {
    expect(isCloudModelName("beam:cloud")).toBe(true);
    expect(isCloudModelName("gpt-oss:120b-cloud")).toBe(true);
    expect(isCloudModelName("gemma3:4b")).toBe(false);
    expect(isCloudModelName("beam")).toBe(false);
  });
  it("maps to the name ollama.com's API expects, and back", () => {
    expect(cloudApiModel("beam:cloud")).toBe("beam");
    expect(cloudApiModel("gpt-oss:20b-cloud")).toBe("gpt-oss:20b");
    expect(cloudApiModel("beam")).toBe("beam");
    expect(cloudRouteName("beam")).toBe("beam:cloud");
    expect(cloudRouteName("gpt-oss:20b")).toBe("gpt-oss:20b-cloud");
    expect(cloudRouteName("beam:cloud")).toBe("beam:cloud");
    for (const n of ["beam", "gpt-oss:20b", "deepseek-v4.1-flash:1017", "kimi-k3"]) expect(cloudApiModel(cloudRouteName(n))).toBe(n);
  });
});

describe("URLs", () => {
  it("never treats a cloud URL as the local daemon (an older console wrote OLLAMA_URL=https://ollama.com)", () => {
    expect(localOllamaUrl({})).toBe(DEFAULT_LOCAL_OLLAMA);
    expect(localOllamaUrl({ OLLAMA_URL: "https://ollama.com" })).toBe(DEFAULT_LOCAL_OLLAMA);
    expect(localOllamaUrl({ OLLAMA_URL: "https://api.ollama.com/" })).toBe(DEFAULT_LOCAL_OLLAMA);
    expect(localOllamaUrl({ OLLAMA_URL: "http://10.0.0.5:11434/" })).toBe("http://10.0.0.5:11434");
    expect(localOllamaUrl({ OLLAMA_BASE_URL: "http://127.0.0.1:11500" })).toBe("http://127.0.0.1:11500");
  });
  it("sends a key only over https (or to this machine)", () => {
    expect(validCloudUrl("https://ollama.com")).toBe(true);
    expect(validCloudUrl("http://ollama.com")).toBe(false);
    expect(validCloudUrl("http://127.0.0.1:9000")).toBe(true);
    expect(validCloudUrl("ollama.com")).toBe(false);
    expect(isCloudUrl("https://ollama.com/")).toBe(true);
    expect(isCloudUrl("https://notollama.com")).toBe(false);
  });
});

describe("resolveCloud: which key", () => {
  it("the server console's key wins over the account's", () => {
    const r = resolveCloud({ key: "server-key-1111", model: "beam:cloud", use: "fallback" }, { key: "acct-key-2222", model: "kimi-k3:cloud" });
    expect(r).toMatchObject({ key: "server-key-1111", source: "server", model: "beam:cloud", use: "fallback", url: DEFAULT_CLOUD_URL });
  });
  it("uses the account's key when the server has none", () => {
    expect(resolveCloud(null, { key: "acct-key-2222", url: "https://ollama.com/" })).toMatchObject({ key: "acct-key-2222", source: "account", url: "https://ollama.com", use: "off" });
  });
  it("honours a key an older console left in .env as a server key", () => {
    expect(resolveCloud(null, { key: "acct" }, { OLLAMA_API_KEY: "legacy-key-3333", OLLAMA_URL: "https://ollama.com" })).toMatchObject({ key: "legacy-key-3333", source: "server" });
  });
  it("is null with no key anywhere, and ignores an http URL for the key", () => {
    expect(resolveCloud({ url: "https://ollama.com", use: "primary" }, null)).toBeNull();
    expect(resolveCloud({ key: "k", url: "http://evil.example" }, null)?.url).toBe(DEFAULT_CLOUD_URL);
  });
});

describe("ollamaTarget: URL and auth", () => {
  it("a cloud model with a key goes to the cloud, bearer key, API name", () => {
    const t = ollamaTarget("beam:cloud", DEFAULT_LOCAL_OLLAMA, cloud());
    expect(t).toEqual({ url: "https://ollama.com/api/chat", model: "beam", headers: { "content-type": "application/json", authorization: "Bearer sk-test-ab12" }, cloud: true });
  });
  it("a local model never gets the key, even with cloud configured", () => {
    const t = ollamaTarget("gemma3:4b", "http://127.0.0.1:11434/", cloud());
    expect(t).toEqual({ url: "http://127.0.0.1:11434/api/chat", model: "gemma3:4b", headers: { "content-type": "application/json" }, cloud: false });
  });
  it("a cloud model without a key goes to the local daemon (it must be signed in), no auth", () => {
    const t = ollamaTarget("beam:cloud", DEFAULT_LOCAL_OLLAMA, null);
    expect(t.url).toBe(`${DEFAULT_LOCAL_OLLAMA}/api/chat`);
    expect(t.model).toBe("beam:cloud");
    expect(t.headers.authorization).toBeUndefined();
  });
});

describe("withCloudRoutes: order", () => {
  it("primary: cloud first, local as the fallback", () => {
    expect(withCloudRoutes([local, gem], cloud({ use: "primary" }), "local_first", true)).toEqual([{ provider: "ollama", model: "beam:cloud" }, local, gem]);
  });
  it("fallback only: local first, cloud right after", () => {
    expect(withCloudRoutes([local, gem], cloud({ use: "fallback" }), "local_first", true)).toEqual([local, { provider: "ollama", model: "beam:cloud" }, gem]);
  });
  it("fallback with no local model installed: cloud takes its place", () => {
    expect(withCloudRoutes([gem], cloud({ use: "fallback" }), "local_first", true)).toEqual([{ provider: "ollama", model: "beam:cloud" }, gem]);
  });
  it("off, no model, or an account that never chose a local model: unchanged", () => {
    expect(withCloudRoutes([local, gem], cloud({ use: "off" }), "local_first", true)).toEqual([local, gem]);
    expect(withCloudRoutes([local, gem], cloud({ model: null }), "local_first", true)).toEqual([local, gem]);
    expect(withCloudRoutes([gem], cloud(), "local_first", false)).toEqual([gem]);
    expect(withCloudRoutes([local], null, "local_first", true)).toEqual([local]);
  });
  it("never adds the same cloud model twice", () => {
    expect(withCloudRoutes([{ provider: "ollama", model: "beam:cloud" }, local], cloud({ use: "fallback" }), "local_first", true)).toEqual([local, { provider: "ollama", model: "beam:cloud" }]);
  });
  it("local_only drops everything that runs on ollama.com", () => {
    expect(withCloudRoutes([{ provider: "ollama", model: "beam:cloud" }, local], cloud(), "local_only", true)).toEqual([local]);
  });
});

describe("planRoutes with cloud models", () => {
  it("never swaps a cloud model for a local one because it isn't installed", () => {
    expect(planRoutes({ primary: { provider: "ollama", model: "beam:cloud" }, fallback: local }, false, ["gemma3:4b"])).toEqual([{ provider: "ollama", model: "beam:cloud" }, local]);
  });
  it("never picks a cloud model as the stand-in for a missing local one", () => {
    expect(planRoutes({ primary: { provider: "ollama", model: "qwen3:4b" }, fallback: null }, false, ["beam:cloud", "gemma3:4b"])).toEqual([local]);
  });
});

describe("localTimeoutMs: too slow", () => {
  it("caps a local route only when a cloud route waits behind it", () => {
    const r: AiRoute[] = [local, { provider: "ollama", model: "beam:cloud" }];
    expect(localTimeoutMs(r, 0, 300_000)).toBe(90_000);
    expect(localTimeoutMs(r, 0, 300_000, { NBS_CLOUD_FALLBACK_AFTER_MS: "20000" })).toBe(20_000);
    expect(localTimeoutMs(r, 1, 300_000)).toBe(300_000);
    expect(localTimeoutMs([local, gem], 0, 300_000)).toBe(300_000);
  });
});

describe("describeOllamaError", () => {
  it("401 from the cloud: the key", () => {
    expect(describeOllamaError({ cloud: true, model: "beam:cloud", status: 401, body: '{"error":"Unauthorized"}' })).toBe(KEY_REJECTED);
  });
  it("401 from the local daemon for a cloud model: not signed in", () => {
    expect(describeOllamaError({ cloud: false, model: "beam:cloud", status: 401, body: "unauthorized" })).toBe(NOT_SIGNED_IN);
  });
  it("DNS and network failures say so", () => {
    const dns = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND ollama.com" } });
    expect(describeOllamaError({ cloud: true, model: "beam", err: dns })).toMatch(/DNS/);
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    expect(describeOllamaError({ cloud: true, model: "beam", err: refused })).toMatch(/Couldn't connect to ollama\.com \(ECONNRESET\)/);
    const down = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    expect(describeOllamaError({ cloud: false, model: "gemma3:4b", err: down })).toMatch(/isn't running/);
  });
  it("404 names the model", () => {
    expect(describeOllamaError({ cloud: true, model: "nope:cloud", status: 404, body: "" })).toMatch(/model called nope/);
  });
});

describe("the console's copy agrees", () => {
  it("same names, URLs, targets and messages", () => {
    for (const n of ["beam", "beam:cloud", "gpt-oss:20b", "gpt-oss:20b-cloud", "gemma3:4b"]) {
      expect(consoleCloud.isCloudModelName(n)).toBe(isCloudModelName(n));
      expect(consoleCloud.cloudApiModel(n)).toBe(cloudApiModel(n));
      expect(consoleCloud.cloudRouteName(n)).toBe(cloudRouteName(n));
    }
    for (const u of ["https://ollama.com", "http://ollama.com", "http://127.0.0.1:1", "x"]) expect(consoleCloud.validCloudUrl(u)).toBe(validCloudUrl(u));
    expect(consoleCloud.KEY_REJECTED).toBe(KEY_REJECTED);
    expect(consoleCloud.NOT_SIGNED_IN).toBe(NOT_SIGNED_IN);
    expect(consoleCloud.describeOllamaError({ cloud: true, model: "beam", status: 401 })).toBe(KEY_REJECTED);
  });
});
