// Place picker for venues and rooms: one search field (Google Places, OpenStreetMap when that isn't available), the chosen place as a
// compact card, and a quiet "paste a link or coordinates" fallback. No big empty areas, so it sits in a 360px sheet with the keyboard up.
import { useEffect, useRef, useState } from "react";
import { biasFromTimezone, newSessionToken, osmTile, placeFromPaste, resolveSuggestion, searchPlaces, type Bias, type Place, type PlaceSource, type Suggestion } from "@spot/shared";
import { Spinner, TextInput, cx } from "../ui";
import { IconClose, IconMap, IconSearch } from "../icons";

const KEY: string | undefined = import.meta.env.VITE_GOOGLE_PLACES_KEY || undefined;
const DEBOUNCE_MS = 250;
const MIN_CHARS = 3;

export interface PlaceValue {
  lat?: number;
  lng?: number;
  /** The Google Maps link to show and send. */
  mapsUrl?: string;
  placeId?: string;
  /** Shown bold on the card. */
  label?: string;
  /** Shown muted under it. */
  address?: string;
}

export function usePlaceSearch(text: string, near?: string, bias?: Bias) {
  const [state, setState] = useState<{ suggestions: Suggestion[]; loading: boolean; error: string | null; searched: string; source: PlaceSource; fellBack: boolean }>({ suggestions: [], loading: false, error: null, searched: "", source: "google", fellBack: false });
  const token = useRef(newSessionToken());
  useEffect(() => {
    const q = text.trim();
    if (q.length < MIN_CHARS) {
      setState((s) => (s.suggestions.length || s.loading || s.error || s.searched ? { ...s, suggestions: [], loading: false, error: null, searched: "" } : s));
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    const ctl = new AbortController();
    const t = setTimeout(() => {
      searchPlaces(q, { key: KEY, bias, near, token: token.current, signal: ctl.signal })
        .then((r) => setState({ suggestions: r.suggestions, loading: false, error: null, searched: q, source: r.source, fellBack: r.fellBack }))
        .catch((e: Error) => {
          if (e.name !== "AbortError") setState((s) => ({ ...s, suggestions: [], loading: false, error: e.message || "Couldn't search.", searched: q }));
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [text, near, bias]);
  return { ...state, token: token.current, rotate: () => (token.current = newSessionToken()) };
}

function PinTile({ lat, lng }: { lat: number; lng: number }) {
  const tile = osmTile({ lat, lng });
  return (
    <div className="relative size-14 flex-none overflow-hidden rounded-sm bg-surface-high" title="Map © OpenStreetMap contributors">
      <img src={tile.url} alt="" width={256} height={256} loading="lazy" className="size-full object-cover" style={{ objectPosition: `${tile.fx * 100}% ${tile.fy * 100}%` }} />
      <IconMap aria-hidden className="icon absolute size-5 -translate-x-1/2 -translate-y-full text-error drop-shadow" style={{ left: `${tile.fx * 100}%`, top: `${tile.fy * 100}%` }} />
    </div>
  );
}

export function PlacePicker({
  value,
  onChange,
  onPlace,
  near,
  label = "Find the place",
  allowLinkOnly,
}: {
  value: PlaceValue | null;
  /** Fires with the new value, or null on Remove. */
  onChange: (v: PlaceValue | null) => void;
  /** Also fires with the full Google/OSM place when one is picked (to fill a venue's name, say). */
  onPlace?: (p: Place) => void;
  /** City/area text for the OpenStreetMap fallback. */
  near?: string;
  label?: string;
  /** Accept a pasted link whose coordinates can't be read (a short maps.app.goo.gl link). Venues can keep it; room pins need coordinates. */
  allowLinkOnly?: boolean;
}) {
  const has = Boolean(value && (value.mapsUrl || (typeof value.lat === "number" && typeof value.lng === "number")));
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [paste, setPaste] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const bias = useRef(biasFromTimezone()).current;
  const s = usePlaceSearch(text, near, bias);
  const searching = !has || editing;

  const done = () => {
    setEditing(false);
    setText("");
    setPaste(false);
    setPasteText("");
    setPasteError(null);
    setPickError(null);
  };

  const pick = async (sg: Suggestion) => {
    setResolving(sg.id);
    setPickError(null);
    try {
      const p = await resolveSuggestion(sg, { key: KEY, token: s.token });
      s.rotate();
      onChange({ lat: p.lat, lng: p.lng, mapsUrl: p.mapsUrl, placeId: p.placeId, label: p.name, address: p.address });
      onPlace?.(p);
      done();
    } catch (e) {
      setPickError((e as Error).message || "Couldn't load that place. Try another.");
    } finally {
      setResolving(null);
    }
  };

  const applyPaste = (v: string) => {
    setPasteText(v);
    if (!v.trim()) return setPasteError(null);
    const r = placeFromPaste(v);
    if (r.ok) {
      onChange({ lat: r.lat, lng: r.lng, mapsUrl: r.mapsUrl, label: "Pinned from a link" });
      done();
    } else if (r.reason === "short") {
      if (allowLinkOnly && /^https?:\/\//i.test(v.trim())) {
        onChange({ mapsUrl: v.trim(), label: "Maps link saved" });
        done();
      } else setPasteError("Short maps.app.goo.gl links hide the spot. Open it, copy the full address from the address bar, and paste that.");
    } else if (r.reason === "range") setPasteError("Those numbers aren't a real place.");
    else setPasteError("Couldn't find coordinates in that. Paste a full Google Maps link or type 12.9784, 77.6408.");
  };

  if (!searching && value) {
    const hasCoords = typeof value.lat === "number" && typeof value.lng === "number";
    const href = value.mapsUrl;
    return (
      <div className="flex min-w-0 flex-col gap-1 rounded-md bg-surface-container p-2.5">
        <div className="flex min-w-0 items-start gap-3">
          {hasCoords ? <PinTile lat={value.lat!} lng={value.lng!} /> : <span className="grid size-14 flex-none place-items-center rounded-sm bg-surface-high text-on-surface-variant"><IconMap aria-hidden className="icon size-6" /></span>}
          <div className="min-w-0 flex-1 py-0.5">
            <p className="truncate type-body-l font-medium">{value.label || "Pinned place"}</p>
            <p className="line-clamp-2 type-body-s text-on-surface-variant">{value.address || (hasCoords ? `${value.lat!.toFixed(5)}, ${value.lng!.toFixed(5)}` : "No map pin yet. Location messages need one.")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-5">
          {href && (
            <a href={href} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center type-label-l text-primary underline-offset-4 hover:underline">
              Open in Google Maps
            </a>
          )}
          <button type="button" onClick={() => setEditing(true)} className="pressable inline-flex min-h-9 items-center type-label-l text-primary underline-offset-4 hover:underline">
            Change
          </button>
          <button type="button" onClick={() => onChange(null)} className="pressable inline-flex min-h-9 items-center type-label-l text-on-surface-variant underline-offset-4 hover:underline">
            Remove
          </button>
        </div>
      </div>
    );
  }

  const q = text.trim();
  const showNone = q.length >= MIN_CHARS && !s.loading && !s.error && s.searched === q && s.suggestions.length === 0;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="relative">
        <IconSearch aria-hidden className="icon pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-on-surface-variant" />
        <TextInput value={text} onChange={(e) => setText(e.target.value)} className="pr-11 pl-11 [&::-webkit-search-cancel-button]:hidden" placeholder="Bloom Indiranagar" aria-label={label} type="search" enterKeyHint="search" autoComplete="off" />
        {s.loading ? <Spinner className="absolute top-1/2 right-3.5 size-5 -translate-y-1/2 text-primary" /> : text && (
          <button type="button" aria-label="Clear" onClick={() => setText("")} className="pressable absolute top-1/2 right-2 grid size-9 -translate-y-1/2 place-items-center text-on-surface-variant">
            <IconClose aria-hidden className="icon size-5" />
          </button>
        )}
      </div>
      {(s.error || pickError) && (
        <p role="alert" className="type-body-s text-error">
          {pickError || s.error}
        </p>
      )}
      {showNone && <p className="type-body-s text-on-surface-variant">Nothing found. Try the area or street, or paste a Google Maps link.</p>}
      {s.suggestions.length > 0 && (
        <div className="flex min-w-0 flex-col overflow-hidden rounded-md bg-surface-container">
          {s.suggestions.map((r, i) => (
            <button
              key={r.id}
              type="button"
              disabled={resolving !== null}
              onClick={() => pick(r)}
              className={cx("state-layer pressable flex min-h-12 w-full min-w-0 items-center gap-3 px-3.5 py-2 text-left", i > 0 && "border-t border-outline-variant/40", resolving === r.id && "opacity-60")}
            >
              <IconMap aria-hidden className="icon size-5 flex-none text-primary" />
              <span className="min-w-0 flex-1">
                <span className="block truncate type-body-l font-medium">{r.name}</span>
                {r.detail && <span className="block truncate type-body-s text-on-surface-variant">{r.detail}</span>}
              </span>
              {resolving === r.id && <Spinner className="size-4 flex-none text-primary" />}
            </button>
          ))}
          {s.fellBack && <p className="border-t border-outline-variant/40 px-3.5 py-1.5 type-label-s text-on-surface-variant">Results from OpenStreetMap</p>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4">
        <button type="button" onClick={() => setPaste((p) => !p)} aria-expanded={paste} className="pressable inline-flex min-h-9 items-center type-label-l text-primary underline-offset-4 hover:underline">
          {paste ? "Hide link box" : "Paste a link or coordinates"}
        </button>
        {has && (
          <button type="button" onClick={done} className="pressable inline-flex min-h-9 items-center type-label-l text-on-surface-variant underline-offset-4 hover:underline">
            Cancel
          </button>
        )}
      </div>
      {paste && (
        <div className="flex flex-col gap-1.5">
          <TextInput value={pasteText} onChange={(e) => applyPaste(e.target.value)} placeholder="Google Maps link, or 12.9784, 77.6408" aria-label="Google Maps link or coordinates" inputMode="url" autoComplete="off" />
          {pasteError && (
            <p role="alert" className="type-body-s text-error">
              {pasteError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
