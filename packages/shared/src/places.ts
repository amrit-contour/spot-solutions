// Place search for venue / room pins. Google Places (New) first; OpenStreetMap's Nominatim when there is no key, Google errors or runs
// out of quota, or it finds nothing. Pure functions over an injectable fetch so the fallback is testable. Never log the key.
import { parseMapsInput } from "./geo.ts";

export type PlaceSource = "google" | "osm";

export interface Suggestion {
  id: string;
  /** "Bloom Indiranagar" */
  name: string;
  /** The rest of the address. */
  detail: string;
  source: PlaceSource;
  /** Google: needs a Place Details call to get these. OSM: already here. */
  placeId?: string;
  lat?: number;
  lng?: number;
}

export interface Place {
  name: string;
  address: string;
  lat: number;
  lng: number;
  /** A real Google Maps link: Google's own `googleMapsUri`, or one we generate for an OSM pick. */
  mapsUrl: string;
  placeId?: string;
  source: PlaceSource;
}

export interface Bias {
  lat: number;
  lng: number;
  /** Metres, Google allows up to 50 000. */
  radiusM: number;
  /** ISO 3166-1 alpha-2, lowercase for Nominatim; Google takes it as-is. */
  region?: string;
}

export interface SearchOpts {
  /** The Google Places browser key; empty/undefined means OpenStreetMap only. */
  key?: string;
  bias?: Bias;
  /** City / area text appended to an OSM query so "Bloom" finds Bloom in the right city. */
  near?: string;
  token?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface SearchOutcome {
  suggestions: Suggestion[];
  source: PlaceSource;
  /** True when Google was tried (a key exists) and OpenStreetMap answered instead. */
  fellBack: boolean;
}

const GOOGLE = "https://places.googleapis.com/v1";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";

/** The best default region from the device's timezone. India for now (Bangalore); nothing elsewhere. */
export function biasFromTimezone(tz?: string): Bias | undefined {
  let zone = tz;
  if (!zone) {
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return undefined;
    }
  }
  return zone === "Asia/Kolkata" || zone === "Asia/Calcutta" ? { lat: 12.9716, lng: 77.5946, radiusM: 50000, region: "in" } : undefined;
}

export function newSessionToken(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** A Google Maps link for a place we only have coordinates (and maybe a name / placeId) for. */
export function googleMapsPlaceLink(p: { lat: number; lng: number; name?: string; placeId?: string }): string {
  const coords = `${p.lat},${p.lng}`;
  if (p.placeId) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name || coords)}&query_place_id=${encodeURIComponent(p.placeId)}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(coords)}`;
}

const failText = (status: number) => `Google search failed (${status})`;

export async function googleAutocomplete(q: string, o: SearchOpts): Promise<Suggestion[]> {
  const f = o.fetchImpl ?? fetch;
  const body: Record<string, unknown> = { input: q, languageCode: "en" };
  if (o.token) body.sessionToken = o.token;
  if (o.bias) {
    body.locationBias = { circle: { center: { latitude: o.bias.lat, longitude: o.bias.lng }, radius: Math.min(o.bias.radiusM, 50000) } };
    if (o.bias.region) body.regionCode = o.bias.region;
  }
  const res = await f(`${GOOGLE}/places:autocomplete`, {
    method: "POST",
    signal: o.signal,
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": o.key ?? "" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(failText(res.status));
  const json = (await res.json()) as { suggestions?: { placePrediction?: { placeId?: string; text?: { text?: string }; structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } } } }[] };
  const out: Suggestion[] = [];
  for (const s of json.suggestions ?? []) {
    const p = s.placePrediction;
    if (!p?.placeId) continue;
    const full = p.text?.text ?? "";
    const name = p.structuredFormat?.mainText?.text ?? full.split(", ")[0] ?? full;
    const detail = p.structuredFormat?.secondaryText?.text ?? full.split(", ").slice(1).join(", ");
    out.push({ id: p.placeId, name, detail, source: "google", placeId: p.placeId });
  }
  return out;
}

export async function googlePlaceDetails(placeId: string, o: SearchOpts): Promise<Place> {
  const f = o.fetchImpl ?? fetch;
  const qs = o.token ? `?sessionToken=${encodeURIComponent(o.token)}` : "";
  const res = await f(`${GOOGLE}/places/${encodeURIComponent(placeId)}${qs}`, {
    signal: o.signal,
    headers: { "X-Goog-Api-Key": o.key ?? "", "X-Goog-FieldMask": "id,displayName,formattedAddress,location,googleMapsUri,shortFormattedAddress" },
  });
  if (!res.ok) throw new Error(failText(res.status));
  const j = (await res.json()) as { id?: string; displayName?: { text?: string }; formattedAddress?: string; shortFormattedAddress?: string; location?: { latitude?: number; longitude?: number }; googleMapsUri?: string };
  const lat = j.location?.latitude;
  const lng = j.location?.longitude;
  if (typeof lat !== "number" || typeof lng !== "number") throw new Error("Google didn't return a location for that place.");
  const name = j.displayName?.text ?? "";
  const id = j.id ?? placeId;
  return {
    name,
    address: j.formattedAddress ?? j.shortFormattedAddress ?? "",
    lat,
    lng,
    mapsUrl: j.googleMapsUri || googleMapsPlaceLink({ lat, lng, name, placeId: id }),
    placeId: id,
    source: "google",
  };
}

interface NominatimRow {
  place_id: number;
  lat: string;
  lon: string;
  display_name: string;
  name?: string;
}

async function nominatim(query: string, o: SearchOpts): Promise<Suggestion[]> {
  const f = o.fetchImpl ?? fetch;
  const params: Record<string, string> = { q: query, format: "jsonv2", limit: "6", "accept-language": "en" };
  if (o.bias?.region) params.countrycodes = o.bias.region;
  const res = await f(`${NOMINATIM}?${new URLSearchParams(params)}`, { signal: o.signal, headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(res.status === 429 ? "Too many searches. Wait a moment and try again." : "Place search isn't answering right now.");
  const rows = (await res.json()) as NominatimRow[];
  const out: Suggestion[] = [];
  for (const r of rows) {
    const lat = Number(r.lat);
    const lng = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const [first, ...rest] = r.display_name.split(", ");
    out.push({ id: `osm-${r.place_id}`, name: r.name || first || r.display_name, detail: rest.join(", "), source: "osm", lat, lng });
  }
  return out;
}

/** With a city/area hint the first try is "query, near"; when that finds nothing the plain query gets a go (the hint may be the wrong area). */
export async function osmSearch(q: string, o: SearchOpts): Promise<Suggestion[]> {
  const near = o.near;
  if (near && !q.toLowerCase().includes(near.toLowerCase())) {
    const hit = await nominatim(`${q}, ${near}`, o);
    if (hit.length) return hit;
  }
  return nominatim(q, o);
}

const isAbort = (e: unknown) => (e as { name?: string })?.name === "AbortError";

/** Google first (when there is a key), then OpenStreetMap if Google errors, is over quota, or finds nothing. A cancel is never a fallback. */
export async function searchPlaces(q: string, o: SearchOpts = {}): Promise<SearchOutcome> {
  if (o.key) {
    try {
      const g = await googleAutocomplete(q, o);
      if (g.length) return { suggestions: g, source: "google", fellBack: false };
    } catch (e) {
      if (isAbort(e) || o.signal?.aborted) throw e;
    }
    return { suggestions: await osmSearch(q, o), source: "osm", fellBack: true };
  }
  return { suggestions: await osmSearch(q, o), source: "osm", fellBack: false };
}

/** Turn a picked suggestion into a full place: Google needs Place Details, an OSM pick already has its coordinates. */
export async function resolveSuggestion(s: Suggestion, o: SearchOpts = {}): Promise<Place> {
  if (s.source === "google" && s.placeId) return googlePlaceDetails(s.placeId, o);
  const lat = s.lat as number;
  const lng = s.lng as number;
  return { name: s.name, address: [s.name, s.detail].filter(Boolean).join(", "), lat, lng, mapsUrl: googleMapsPlaceLink({ lat, lng, name: s.name }), source: "osm" };
}

/** What a pasted Google Maps link or "lat, lng" gives us: coordinates plus a link to keep (the pasted one if it is a URL). */
export function placeFromPaste(input: string): { ok: true; lat: number; lng: number; mapsUrl: string } | { ok: false; reason: "short" | "none" | "range" } {
  const r = parseMapsInput(input);
  if (!r.ok) return r;
  const s = input.trim();
  return { ok: true, lat: r.pin.lat, lng: r.pin.lng, mapsUrl: /^https?:\/\//i.test(s) ? s : googleMapsPlaceLink(r.pin) };
}
