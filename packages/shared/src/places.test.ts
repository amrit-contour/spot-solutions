import { describe, expect, it, vi } from "vitest";
import { biasFromTimezone, googleMapsPlaceLink, placeFromPaste, resolveSuggestion, searchPlaces } from "./places.ts";

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const google = { suggestions: [{ placePrediction: { placeId: "P1", text: { text: "Bloom, Indiranagar, Bengaluru" }, structuredFormat: { mainText: { text: "Bloom" }, secondaryText: { text: "Indiranagar, Bengaluru" } } } }] };
const osm = [{ place_id: 9, lat: "12.97", lon: "77.64", display_name: "Bloom, 100 Feet Road, Bengaluru", name: "Bloom" }];

describe("searchPlaces", () => {
  it("uses Google when a key is set", async () => {
    const f = vi.fn(() => json(google));
    const r = await searchPlaces("bloom", { key: "k", token: "t", fetchImpl: f as never, bias: { lat: 12.9, lng: 77.5, radiusM: 99999, region: "in" } });
    expect(r).toMatchObject({ source: "google", fellBack: false });
    expect(r.suggestions[0]).toMatchObject({ name: "Bloom", detail: "Indiranagar, Bengaluru", placeId: "P1" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://places.googleapis.com/v1/places:autocomplete");
    expect((init.headers as Record<string, string>)["X-Goog-Api-Key"]).toBe("k");
    const body = JSON.parse(init.body as string);
    expect(body.sessionToken).toBe("t");
    expect(body.locationBias.circle.radius).toBe(50000);
  });
  it("falls back to OpenStreetMap on a Google error", async () => {
    const f = vi.fn((u: string) => (u.includes("googleapis") ? json({ error: "quota" }, 429) : json(osm)));
    const r = await searchPlaces("bloom", { key: "k", fetchImpl: f as never });
    expect(r).toMatchObject({ source: "osm", fellBack: true });
    expect(r.suggestions[0]).toMatchObject({ source: "osm", lat: 12.97, lng: 77.64 });
  });
  it("falls back when Google finds nothing", async () => {
    const f = vi.fn((u: string) => (u.includes("googleapis") ? json({}) : json(osm)));
    expect((await searchPlaces("zzz", { key: "k", fetchImpl: f as never })).fellBack).toBe(true);
  });
  it("goes straight to OpenStreetMap with no key, without claiming a fallback", async () => {
    const f = vi.fn(() => json(osm));
    const r = await searchPlaces("bloom", { near: "Bengaluru", fetchImpl: f as never });
    expect(r).toMatchObject({ source: "osm", fellBack: false });
    expect(f).toHaveBeenCalledTimes(1);
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain("nominatim");
  });
  it("retries OpenStreetMap without the area hint when the hinted query finds nothing", async () => {
    const f = vi.fn((u: string) => json(u.includes("Church") ? [] : osm));
    const r = await searchPlaces("bloom", { near: "Church Street", fetchImpl: f as never });
    expect(f).toHaveBeenCalledTimes(2);
    expect(r.suggestions).toHaveLength(1);
  });
  it("does not fall back when the request was cancelled", async () => {
    const f = vi.fn(() => Promise.reject(Object.assign(new Error("x"), { name: "AbortError" })));
    await expect(searchPlaces("bloom", { key: "k", fetchImpl: f as never })).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("resolveSuggestion", () => {
  it("fetches Google details and keeps googleMapsUri", async () => {
    const f = vi.fn(() => json({ id: "P1", displayName: { text: "Bloom" }, formattedAddress: "1 Rd, Bengaluru", location: { latitude: 12.97, longitude: 77.64 }, googleMapsUri: "https://maps.google.com/?cid=1" }));
    const p = await resolveSuggestion({ id: "P1", name: "Bloom", detail: "", source: "google", placeId: "P1" }, { key: "k", token: "t", fetchImpl: f as never });
    expect(p).toMatchObject({ name: "Bloom", lat: 12.97, mapsUrl: "https://maps.google.com/?cid=1", placeId: "P1" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://places.googleapis.com/v1/places/P1?sessionToken=t");
    expect((init.headers as Record<string, string>)["X-Goog-FieldMask"]).toContain("googleMapsUri");
  });
  it("generates a Google Maps link for an OSM pick", async () => {
    const p = await resolveSuggestion({ id: "osm-1", name: "Bloom", detail: "Bengaluru", source: "osm", lat: 12.97, lng: 77.64 });
    expect(p.mapsUrl).toBe("https://www.google.com/maps/search/?api=1&query=12.97%2C77.64");
  });
});

describe("links and paste", () => {
  it("builds links with and without a placeId", () => {
    expect(googleMapsPlaceLink({ lat: 1, lng: 2 })).toBe("https://www.google.com/maps/search/?api=1&query=1%2C2");
    expect(googleMapsPlaceLink({ lat: 1, lng: 2, name: "A B", placeId: "X" })).toBe("https://www.google.com/maps/search/?api=1&query=A%20B&query_place_id=X");
  });
  it("keeps a pasted URL and generates one for bare coordinates", () => {
    const u = "https://www.google.com/maps/place/Bloom/@12.9784,77.6408,17z";
    expect(placeFromPaste(u)).toMatchObject({ ok: true, lat: 12.9784, mapsUrl: u });
    expect(placeFromPaste("12.9784, 77.6408")).toMatchObject({ ok: true, mapsUrl: expect.stringContaining("api=1") });
    expect(placeFromPaste("https://maps.app.goo.gl/abc")).toEqual({ ok: false, reason: "short" });
  });
  it("biases to Bangalore for India timezones only", () => {
    expect(biasFromTimezone("Asia/Kolkata")?.region).toBe("in");
    expect(biasFromTimezone("Australia/Melbourne")).toBeUndefined();
  });
});
