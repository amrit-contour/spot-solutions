// "Pin" fields for a venue: paste a Google Maps link or type coordinates; a small OpenStreetMap tile confirms it.
import { useState } from "react";
import { googleMapsLink, hasPin, osmTile, parseMapsInput } from "@spot/shared";
import { Button, Field, TextInput } from "../ui";
import { IconMap } from "../icons";

const fmt = (n: number | undefined) => (typeof n === "number" ? String(n) : "");
const num = (s: string) => (s.trim() === "" ? NaN : Number(s));

const problemText = (reason: "short" | "none" | "range") =>
  reason === "short"
    ? "Short links like maps.app.goo.gl hide the location. Open the link, copy the full address from the address bar, and paste that here. Or type the coordinates below."
    : reason === "range"
      ? "Those numbers aren't a real place. Latitude goes from -90 to 90, longitude from -180 to 180."
      : "Couldn't find coordinates in that. Paste a full Google Maps link, or type them like 12.9784, 77.6408.";

export function VenuePin({ lat, lng, onChange }: { lat?: number; lng?: number; onChange: (pin: { lat: number; lng: number } | null) => void }) {
  const [link, setLink] = useState("");
  const [latText, setLatText] = useState(fmt(lat));
  const [lngText, setLngText] = useState(fmt(lng));
  const [error, setError] = useState<string | null>(null);

  const setTexts = (a: string, b: string) => {
    setLatText(a);
    setLngText(b);
    const la = num(a);
    const lo = num(b);
    if (a.trim() === "" && b.trim() === "") return onChange(null), setError(null);
    const r = parseMapsInput(`${la}, ${lo}`);
    if (r.ok) return onChange(r.pin), setError(null);
    onChange(null);
    setError(Number.isNaN(la) || Number.isNaN(lo) ? "Fill in both latitude and longitude." : problemText("range"));
  };

  const paste = (v: string) => {
    setLink(v);
    if (!v.trim()) return setError(null);
    const r = parseMapsInput(v);
    if (r.ok) {
      setLatText(String(r.pin.lat));
      setLngText(String(r.pin.lng));
      onChange(r.pin);
      setError(null);
    } else setError(problemText(r.reason));
  };

  const pin = hasPin({ lat, lng }) ? { lat: lat!, lng: lng! } : null;
  const tile = pin ? osmTile(pin) : null;

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="type-label-l text-on-surface-variant">Map pin</legend>
      <Field label="Paste a Google Maps link" hint="Used when a message sends the venue's location. A full link works; short maps.app.goo.gl links can't be read here.">
        <TextInput value={link} onChange={(e) => paste(e.target.value)} placeholder="https://www.google.com/maps/place/…/@12.9784,77.6408" inputMode="url" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Latitude">
          <TextInput value={latText} onChange={(e) => setTexts(e.target.value, lngText)} placeholder="12.9784" inputMode="decimal" />
        </Field>
        <Field label="Longitude">
          <TextInput value={lngText} onChange={(e) => setTexts(latText, e.target.value)} placeholder="77.6408" inputMode="decimal" />
        </Field>
      </div>
      {error && (
        <p role="alert" className="type-body-s text-error">
          {error}
        </p>
      )}
      {pin && tile && (
        <div className="flex items-center gap-3 rounded-md bg-surface-container p-2">
          <div className="relative size-24 flex-none overflow-hidden rounded-sm bg-surface-high">
            <img src={tile.url} alt="" width={256} height={256} loading="lazy" className="size-full object-cover" style={{ objectPosition: `${tile.fx * 100}% ${tile.fy * 100}%`, transform: "scale(1.0)" }} />
            <IconMap aria-hidden className="icon absolute size-6 -translate-x-1/2 -translate-y-full text-error drop-shadow" style={{ left: `${tile.fx * 100}%`, top: `${tile.fy * 100}%` }} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="type-body-m tabular">
              {pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}
            </p>
            <p className="type-label-s text-on-surface-variant">Map © OpenStreetMap contributors</p>
            <a href={googleMapsLink(pin)} target="_blank" rel="noreferrer" className="type-label-l text-primary underline-offset-4 hover:underline">
              Open in Maps
            </a>
          </div>
          <Button
            size="sm"
            variant="text"
            onClick={() => {
              setLink("");
              setTexts("", "");
            }}
          >
            Remove
          </Button>
        </div>
      )}
    </fieldset>
  );
}
