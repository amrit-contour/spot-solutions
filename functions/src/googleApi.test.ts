import { describe, expect, it, vi } from "vitest";
import { GrantRevokedError, People, exchangeCode, mintAccessToken, revokeToken, type Fetch } from "./googleApi";

const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ ok: status < 300, status, headers: { get: (n: string) => headers[n] ?? null }, json: async () => body });

describe("OAuth calls", () => {
  it("sends the code with the postmessage redirect and returns the tokens", async () => {
    const f = vi.fn<Fetch>(async () => res(200, { refresh_token: "r", access_token: "a", id_token: "i", scope: "s" }));
    const g = await exchangeCode(f, { clientId: "cid", clientSecret: "sec" }, "4/code");
    expect(g).toEqual({ refreshToken: "r", accessToken: "a", idToken: "i", scope: "s" });
    const body = new URLSearchParams(f.mock.calls[0]![1]!.body);
    expect(body.get("redirect_uri")).toBe("postmessage");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_secret")).toBe("sec");
  });
  it("turns invalid_grant on refresh into GrantRevokedError", async () => {
    const f: Fetch = async () => res(400, { error: "invalid_grant" });
    await expect(mintAccessToken(f, { clientId: "c", clientSecret: "s" }, "r")).rejects.toBeInstanceOf(GrantRevokedError);
  });
  it("revoke reports success, and never throws", async () => {
    expect(await revokeToken(async () => res(200, {}), "t")).toBe(true);
    expect(await revokeToken(async () => { throw new Error("net"); }, "t")).toBe(false);
  });
});

describe("People", () => {
  const sleep = vi.fn(async () => {});
  it("pages through connections and indexes by phone", async () => {
    const pages = [
      { connections: [{ resourceName: "people/c1", etag: "e1", names: [{ displayName: "Asha" }], phoneNumbers: [{ canonicalForm: "+919876543210" }] }, { resourceName: "people/c9", etag: "e", names: [] }], nextPageToken: "p2" },
      { connections: [{ resourceName: "people/c2", etag: "e2", names: [{ displayName: "Bo" }], phoneNumbers: [{ value: "98765 43211" }] }] },
    ];
    const f = vi.fn<Fetch>(async () => res(200, pages.shift()));
    const idx = await new People(f, "tok", sleep).loadIndex();
    expect(idx.get("919876543210")?.resourceName).toBe("people/c1");
    expect(idx.get("9876543211")?.resourceName).toBe("people/c2");
    expect(f.mock.calls[1]![0]).toContain("pageToken=p2");
    expect(f.mock.calls[0]![1]!.headers!.Authorization).toBe("Bearer tok");
  });
  it("backs off on 429 and then succeeds", async () => {
    const f = vi.fn<Fetch>().mockResolvedValueOnce(res(429, {}, { "Retry-After": "2" })).mockResolvedValueOnce(res(200, { connections: [] }));
    await new People(f, "t", sleep).loadIndex();
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("creates and renames in batches, retrying a failed rename with a fresh etag, and never deletes", async () => {
    const calls: { url: string; method?: string }[] = [];
    const f: Fetch = async (url, init) => {
      calls.push({ url, method: init?.method });
      if (url.endsWith("people:batchCreateContacts")) return res(200, { createdPeople: [{ person: { resourceName: "people/n1" } }] });
      if (url.endsWith("people:batchUpdateContacts")) return res(200, { updateResult: {} });
      if (url.includes(":updateContact") && JSON.parse(init!.body!).etag === "old") return res(400, { error: { message: "Request must contain the etag" } });
      if (url.includes(":updateContact")) return res(200, { resourceName: "people/c1", etag: "new" });
      return res(200, { resourceName: "people/c1", etag: "fresh" });
    };
    const r = await new People(f, "t", sleep).apply({
      create: [{ comicId: "a", name: "New One", phone: "919876543210" }],
      update: [{ comicId: "b", name: "Renamed", phone: "919876543211", resourceName: "people/c1", etag: "old", from: "Was" }],
    });
    expect(r).toEqual({ created: 1, updated: 1, failed: 0 });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(calls.some((c) => c.url.includes("deleteContact"))).toBe(false);
  });
});
