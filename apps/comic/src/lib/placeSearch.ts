// Place search for the map pin: OpenStreetMap's free Nominatim. No key. Its policy: identify the app (a browser sends our
// Referer automatically; it won't let a page set User-Agent), at most one request a second, and don't search as you type
// without a pause. So: a 700 ms debounce, three characters minimum, one request at a time (the last one wins).
import { useEffect, useState } from "react";

export interface PlaceResult {
  id: string;
  /** "Bloom Indiranagar" */
  name: string;
  /** The rest of the address. */
  detail: string;
  lat: number;
  lng: number;
}

const ENDPOINT = "https://nominatim.openstreetmap.org/search";

interface NominatimRow {
  place_id: number;
  lat: string;
  lon: string;
  display_name: string;
  name?: string;
}

export async function searchPlaces(q: string, signal?: AbortSignal, near?: string): Promise<PlaceResult[]> {
  const query = near && !q.toLowerCase().includes(near.toLowerCase()) ? `${q}, ${near}` : q;
  const url = `${ENDPOINT}?${new URLSearchParams({ q: query, format: "jsonv2", limit: "6", "accept-language": "en" })}`;
  const res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(res.status === 429 ? "Too many searches. Wait a moment and try again." : "Place search isn't answering right now.");
  const rows = (await res.json()) as NominatimRow[];
  return rows
    .map((r) => {
      const [first, ...rest] = r.display_name.split(", ");
      return { id: String(r.place_id), name: r.name || first || r.display_name, detail: rest.join(", "), lat: Number(r.lat), lng: Number(r.lon) };
    })
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

export function usePlaceSearch(text: string, near?: string) {
  const [state, setState] = useState<{ results: PlaceResult[]; loading: boolean; error: string | null; searched: string }>({ results: [], loading: false, error: null, searched: "" });
  useEffect(() => {
    const q = text.trim();
    if (q.length < 3) {
      setState({ results: [], loading: false, error: null, searched: "" });
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    const ctl = new AbortController();
    const t = setTimeout(() => {
      searchPlaces(q, ctl.signal, near)
        .then((results) => setState({ results, loading: false, error: null, searched: q }))
        .catch((e: Error) => {
          if (e.name !== "AbortError") setState({ results: [], loading: false, error: e.message || "Couldn't search.", searched: q });
        });
    }, 700);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [text, near]);
  return state;
}
