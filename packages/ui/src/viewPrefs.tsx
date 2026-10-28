// View preferences kept per account and synced across devices: the Home calendar view, "Hide empty days", the Requests sort and tab,
// whether Lineup activity is open. Each lives in a `prefs` map on the user doc (settings.prefs in Curate, comicSettings.prefs in Comedy).
//
// Reading: this tab's pending choice, else the synced value, else the last value this device saw (localStorage, so the first paint is
// right before Firestore answers), else the default. Writing: the screen updates and localStorage is written at once; Firestore is
// written 800 ms after the last change (and when the tab hides), so tapping through views is a single write.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type PrefValue = string | boolean;
type PrefMap = Record<string, unknown>;

export interface PrefDef<T extends PrefValue> {
  /** Field name inside `prefs`. */
  key: string;
  default: T;
  /** The value if `raw` is a legal one, else undefined (a stale or hand-edited value is ignored). */
  parse: (raw: unknown) => T | undefined;
  /** localStorage key for the instant first paint (an old key keeps working). */
  local: string;
  /** How the value is written to / read from localStorage. Defaults to the value itself, booleans as "1" / "0". */
  encode?: (v: T) => string;
  decode?: (s: string) => T | undefined;
}

export const boolPref = (key: string, local: string, dflt: boolean): PrefDef<boolean> => ({
  key,
  local,
  default: dflt,
  parse: (r) => (typeof r === "boolean" ? r : undefined),
});

export const enumPref = <T extends string>(key: string, local: string, values: readonly T[], dflt: T): PrefDef<T> => ({
  key,
  local,
  default: dflt,
  parse: (r) => (typeof r === "string" && (values as readonly string[]).includes(r) ? (r as T) : undefined),
});

const enc = <T extends PrefValue>(d: PrefDef<T>, v: T) => (d.encode ? d.encode(v) : typeof v === "boolean" ? (v ? "1" : "0") : String(v));
const dec = <T extends PrefValue>(d: PrefDef<T>, s: string): T | undefined => (d.decode ? d.decode(s) : d.parse(typeof d.default === "boolean" ? (s === "1" ? true : s === "0" ? false : undefined) : s));

function readLocal<T extends PrefValue>(d: PrefDef<T>): T | undefined {
  try {
    const s = localStorage.getItem(d.local);
    return s === null ? undefined : dec(d, s);
  } catch {
    return undefined;
  }
}
function writeLocal<T extends PrefValue>(d: PrefDef<T>, v: T) {
  try {
    localStorage.setItem(d.local, enc(d, v));
  } catch {
    /* blocked storage: only the instant first paint is lost */
  }
}

interface Api {
  remote: PrefMap | undefined;
  pending: PrefMap;
  set: (key: string, value: PrefValue) => void;
}
const Ctx = createContext<Api | null>(null);

export const PREF_SAVE_DELAY_MS = 800;

/**
 * `remote` is the prefs map from the user doc (undefined until the doc has loaded). `save` merges a patch into it.
 * Without a provider (a screen in a test or the dev demo) prefs still work, held in memory and localStorage.
 */
export function ViewPrefsProvider({ remote, save, children }: { remote: PrefMap | undefined; save: (patch: PrefMap) => Promise<unknown> | void; children: ReactNode }) {
  const [pending, setPending] = useState<PrefMap>({});
  const queue = useRef<PrefMap>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveRef = useRef(save);
  saveRef.current = save;

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const patch = queue.current;
    queue.current = {};
    if (!Object.keys(patch).length) return;
    try {
      void Promise.resolve(saveRef.current(patch)).catch(() => undefined);
    } catch {
      /* offline or signed out: this device keeps its choice in localStorage */
    }
  }, []);

  const set = useCallback(
    (key: string, value: PrefValue) => {
      setPending((p) => ({ ...p, [key]: value }));
      queue.current[key] = value;
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, PREF_SAVE_DELAY_MS);
    },
    [flush],
  );

  // Don't lose the last tap when the tab hides or the app unmounts.
  useEffect(() => {
    const hide = () => document.visibilityState === "hidden" && flush();
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  // Once the synced copy agrees with a pending choice, the pending one has done its job: later changes from another device win.
  useEffect(() => {
    if (!remote) return;
    setPending((p) => {
      const keys = Object.keys(p).filter((k) => remote[k] === p[k] && !(k in queue.current));
      if (!keys.length) return p;
      const n = { ...p };
      for (const k of keys) delete n[k];
      return n;
    });
  }, [remote]);

  const api = useMemo<Api>(() => ({ remote, pending, set }), [remote, pending, set]);
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/** [value, setValue] for one preference. */
export function usePref<T extends PrefValue>(def: PrefDef<T>): readonly [T, (v: T) => void] {
  const api = useContext(Ctx);
  const [memory, setMemory] = useState<T | undefined>(undefined);
  const fromPending = api ? def.parse(api.pending[def.key]) : undefined;
  const fromRemote = api?.remote ? def.parse(api.remote[def.key]) : undefined;
  const value = fromPending ?? fromRemote ?? memory ?? readLocal(def) ?? def.default;

  // Remember what the account says on this device so the next cold open paints it straight away.
  useEffect(() => {
    if (fromRemote !== undefined && readLocal(def) !== fromRemote) writeLocal(def, fromRemote);
  }, [def, fromRemote]);

  const setValue = useCallback(
    (v: T) => {
      writeLocal(def, v);
      setMemory(v);
      api?.set(def.key, v);
    },
    [def, api],
  );
  return [value, setValue] as const;
}
