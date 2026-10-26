import { useState } from "react";
import { VenuePin, Field, TextInput, Spinner, IconSearch, IconMap } from "@spot/ui";
import type { Pin } from "@spot/shared";
import { usePlaceSearch, type PlaceResult } from "../lib/placeSearch";

/**
 * The room's map pin: search a place (OpenStreetMap, free), or paste a Google Maps link or type coordinates (VenuePin).
 * A search result fills the coordinates; a remount key makes VenuePin show them.
 */
export function PinPicker({ pin, onChange, near }: { pin: Pin | undefined; onChange: (p: Pin | undefined) => void; near?: string }) {
  const [text, setText] = useState("");
  const [version, setVersion] = useState(0);
  const { results, loading, error, searched } = usePlaceSearch(text, near);
  const pick = (r: PlaceResult) => {
    onChange({ lat: r.lat, lng: r.lng, label: [r.name, r.detail.split(", ")[0]].filter(Boolean).join(", ") });
    setVersion((v) => v + 1);
    setText("");
  };
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Field label="Search for the place" hint="Searches OpenStreetMap. Try the venue's name and area.">
        <div className="relative">
          <IconSearch aria-hidden className="icon pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-on-surface-variant" />
          <TextInput value={text} onChange={(e) => setText(e.target.value)} className="pl-11" placeholder="Bloom Indiranagar" type="search" enterKeyHint="search" autoComplete="off" />
          {loading && <Spinner className="absolute top-1/2 right-3.5 size-5 -translate-y-1/2 text-primary" />}
        </div>
      </Field>
      {error && (
        <p role="alert" className="type-body-s text-error">
          {error}
        </p>
      )}
      {text.trim().length >= 3 && !loading && !error && searched === text.trim() && results.length === 0 && (
        <p className="type-body-s text-on-surface-variant">Nothing found. Try the area or street instead, or paste a Google Maps link below.</p>
      )}
      {results.length > 0 && (
        <ul className="flex min-w-0 flex-col overflow-hidden rounded-md bg-surface-container">
          {results.map((r) => (
            <li key={r.id} className="min-w-0">
              <button onClick={() => pick(r)} className="state-layer flex min-h-14 w-full min-w-0 items-center gap-3 px-3 py-2 text-left">
                <IconMap aria-hidden className="icon size-5 flex-none text-primary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate type-body-l">{r.name}</span>
                  <span className="block truncate type-body-s text-on-surface-variant">{r.detail}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <VenuePin key={version} lat={pin?.lat} lng={pin?.lng} onChange={(p) => onChange(p ? { ...pin, ...p } : undefined)} />
      {pin?.label && <p className="type-body-s text-on-surface-variant">Pinned from: {pin.label}</p>}
    </div>
  );
}
