import { PlacePicker } from "@spot/ui";
import type { Pin } from "@spot/shared";

/**
 * The room's map pin: search a place (Google Places, OpenStreetMap as the fallback) or paste a Google Maps link / coordinates.
 * The pin keeps Google's own maps link, so every room has one.
 */
export function PinPicker({ pin, onChange, near }: { pin: Pin | undefined; onChange: (p: Pin | undefined) => void; near?: string }) {
  return (
    <PlacePicker
      near={near}
      value={pin ? { lat: pin.lat, lng: pin.lng, mapsUrl: pin.mapsUrl, placeId: pin.placeId, label: pin.label?.split(", ")[0], address: pin.address ?? pin.label?.split(", ").slice(1).join(", ") } : null}
      onChange={(v) => {
        if (!v) return onChange(undefined);
        if (typeof v.lat !== "number" || typeof v.lng !== "number") return;
        const first = v.address?.split(", ").find((x) => x && x !== v.label);
        onChange({
          lat: v.lat,
          lng: v.lng,
          ...(v.mapsUrl && { mapsUrl: v.mapsUrl }),
          ...(v.placeId && { placeId: v.placeId }),
          ...(v.address && { address: v.address }),
          ...(v.label && { label: [v.label, first].filter(Boolean).join(", ") }),
        });
      }}
    />
  );
}
