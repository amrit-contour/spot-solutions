import { describe, expect, it } from "vitest";
import { hasPin, osmTile, parseMapsInput } from "./geo.ts";

const pin = (lat: number, lng: number) => ({ ok: true, pin: { lat, lng } });

describe("parseMapsInput", () => {
  it("reads @lat,lng from a place link", () => {
    expect(parseMapsInput("https://www.google.com/maps/place/Bloom/@12.9784,77.6408,17z/data=!4m6")).toEqual(pin(12.9784, 77.6408));
  });
  it("prefers the exact pin (!3d!4d) over the map centre", () => {
    expect(parseMapsInput("https://www.google.com/maps/place/X/@12.9,77.6,17z/data=!3d12.97841!4d77.64082")).toEqual(pin(12.97841, 77.64082));
  });
  it("reads ?q= and ll= and query=", () => {
    expect(parseMapsInput("https://maps.google.com/?q=12.9784,77.6408")).toEqual(pin(12.9784, 77.6408));
    expect(parseMapsInput("https://maps.google.com/?foo=1&ll=12.9784,77.6408&z=15")).toEqual(pin(12.9784, 77.6408));
    expect(parseMapsInput("https://www.google.com/maps/search/?api=1&query=12.9784%2C77.6408")).toEqual(pin(12.9784, 77.6408));
  });
  it("reads plain coordinates, with negatives", () => {
    expect(parseMapsInput(" 12.9784, 77.6408 ")).toEqual(pin(12.9784, 77.6408));
    expect(parseMapsInput("-33.8688, 151.2093")).toEqual(pin(-33.8688, 151.2093));
  });
  it("can't resolve short links", () => {
    expect(parseMapsInput("https://maps.app.goo.gl/AbC123")).toEqual({ ok: false, reason: "short" });
  });
  it("rejects nonsense and out-of-range values", () => {
    expect(parseMapsInput("")).toEqual({ ok: false, reason: "none" });
    expect(parseMapsInput("The Laugh Store")).toEqual({ ok: false, reason: "none" });
    expect(parseMapsInput("123.4, 77.6")).toEqual({ ok: false, reason: "range" });
  });
});

describe("pins", () => {
  it("hasPin needs both numbers in range", () => {
    expect(hasPin({ lat: 12.9, lng: 77.6 })).toBe(true);
    expect(hasPin({ lat: 12.9 })).toBe(false);
    expect(hasPin(undefined)).toBe(false);
  });
  it("finds the OSM tile", () => {
    const t = osmTile({ lat: 12.9784, lng: 77.6408 }, 16);
    expect(t.url).toMatch(/^https:\/\/tile\.openstreetmap\.org\/16\/\d+\/\d+\.png$/);
    expect(t.fx).toBeGreaterThanOrEqual(0);
    expect(t.fx).toBeLessThan(1);
  });
});
