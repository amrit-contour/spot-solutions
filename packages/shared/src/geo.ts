// Venue pins: read coordinates out of whatever the curator pastes from Google Maps.

export interface LatLng {
  lat: number;
  lng: number;
}

const inRange = (lat: number, lng: number) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
const NUM = "(-?\\d{1,3}(?:\\.\\d+)?)";
const PAIR = `${NUM}\\s*,\\s*${NUM}`;

export type ParsedPin = { ok: true; pin: LatLng } | { ok: false; reason: "short" | "none" | "range" };

/**
 * Accepts a full Google Maps link (@lat,lng · ?q=lat,lng · ll= · query= · !3d…!4d…) or plain "lat, lng".
 * Short links (maps.app.goo.gl, goo.gl/maps) hide the coordinates behind a redirect a browser can't follow, so they say so.
 */
export function parseMapsInput(input: string): ParsedPin {
  const s = input.trim();
  if (!s) return { ok: false, reason: "none" };
  const patterns = [
    new RegExp(`!3d${NUM}!4d${NUM}`),
    new RegExp(`@${PAIR}`),
    new RegExp(`[?&](?:q|ll|query|center|destination)=${PAIR.replace(/\\s\*,\\s\*/, "(?:,|%2C)")}`, "i"),
    new RegExp(`^${PAIR}$`),
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (!m) continue;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    return inRange(lat, lng) ? { ok: true, pin: { lat, lng } } : { ok: false, reason: "range" };
  }
  return { ok: false, reason: /(?:maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(s) ? "short" : "none" };
}

export const hasPin = (v: { lat?: number | null; lng?: number | null } | undefined | null): v is { lat: number; lng: number } =>
  typeof v?.lat === "number" && typeof v?.lng === "number" && inRange(v.lat, v.lng);

export const openStreetMapLink = (p: LatLng) => `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=17/${p.lat}/${p.lng}`;
export const googleMapsLink = (p: LatLng) => `https://www.google.com/maps?q=${p.lat},${p.lng}`;

/** An OpenStreetMap tile covering the point, for a tiny static preview (no key, no library). */
export function osmTile(p: LatLng, zoom = 16) {
  const n = 2 ** zoom;
  const x = Math.floor(((p.lng + 180) / 360) * n);
  const latRad = (p.lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  // Where the pin sits inside the tile, 0..1.
  const fx = ((p.lng + 180) / 360) * n - x;
  const fy = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n - y;
  return { url: `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`, fx, fy };
}
