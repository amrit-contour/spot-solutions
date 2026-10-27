import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  queryEqual,
  Timestamp,
  type Query,
  type QueryConstraint,
} from "firebase/firestore";
import { TTL_DAYS, ttlMs, type Command, type CommandType } from "@spot/shared";
import { db } from "@spot/ui/firebase";
import { isDemoUser } from "./demo";

/** Firestore TTL field: a Timestamp (not a number), `days` from now. See deploy/setup-cost-controls.sh. */
export const expireAt = (days: number) => Timestamp.fromMillis(ttlMs(days));

export const userCol = (uid: string, name: string) => collection(db, "users", uid, name);
export const userDoc = (uid: string, name: string, id: string) => doc(db, "users", uid, name, id);

/* ---------- Shared live subscriptions ----------
 * Every useCollection/useDocument call with the same query shares one Firestore listener and one copy of the data. A listener
 * is opened by the first component that needs it and kept for KEEP_MS after the last one unmounts, so going back to a page
 * shows its data at once (no loading state, no re-read) and a page nobody is looking at costs nothing. Unchanged documents
 * keep the same object between snapshots, so memoised rows don't re-render when a neighbour changes. */
const KEEP_MS = 120_000;

class Shared<S> {
  subs = new Set<() => void>();
  stop?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  state: S;
  private open: (set: (s: S) => void) => () => void;
  private drop: () => void;
  constructor(state: S, open: (set: (s: S) => void) => () => void, drop: () => void) {
    this.state = state;
    this.open = open;
    this.drop = drop;
    this.arm();
  }
  set = (s: S) => {
    this.state = s;
    this.subs.forEach((f) => f());
  };
  private arm() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.subs.size) return;
      this.stop?.();
      this.stop = undefined;
      this.drop();
    }, KEEP_MS);
  }
  subscribe = (cb: () => void) => {
    this.subs.add(cb);
    clearTimeout(this.timer);
    this.stop ??= this.open(this.set);
    return () => {
      this.subs.delete(cb);
      if (!this.subs.size) this.arm();
    };
  };
  getSnapshot = () => this.state;
}

type ColState<T> = { data: T[]; loading: boolean };
const LOADING: ColState<never> = { data: [], loading: true };
const noop = () => undefined;
const idle = { subscribe: () => noop, getSnapshot: () => LOADING };

const collections: { q: Query; shared: Shared<ColState<never>> }[] = [];
function sharedCollection(q: Query, name: string) {
  const hit = collections.find((c) => queryEqual(c.q, q));
  if (hit) return hit.shared;
  const byId = new Map<string, unknown>();
  const shared: Shared<ColState<never>> = new Shared<ColState<never>>(
    LOADING,
    (set) =>
      onSnapshot(
        q,
        (snap) => {
          const changed = new Set(snap.docChanges().filter((c) => c.type !== "removed").map((c) => c.doc.id));
          const next = new Map<string, unknown>();
          const data = snap.docs.map((d) => {
            const old = byId.get(d.id);
            const v = old && !changed.has(d.id) ? old : { ...d.data(), id: d.id };
            next.set(d.id, v);
            return v;
          });
          byId.clear();
          next.forEach((v, k) => byId.set(k, v));
          set({ data: data as never[], loading: false });
        },
        (e) => {
          console.error(name, e);
          set({ data: [], loading: false });
        },
      ),
    () => collections.splice(collections.findIndex((c) => c.shared === shared), 1),
  );
  collections.push({ q, shared });
  return shared;
}

/** Live collection under users/{uid}. `key` says when the constraints change; identical queries share one listener. */
export function useCollection<T>(uid: string | undefined, name: string, constraints: QueryConstraint[] = [], key = "") {
  const shared = useMemo(() => (uid ? sharedCollection(query(userCol(uid, name), ...constraints), name) : null), // eslint-disable-line react-hooks/exhaustive-deps
    [uid, name, key]);
  const store = shared ?? idle;
  const cur = useSyncExternalStore(store.subscribe, store.getSnapshot) as ColState<T>;
  // Changing the constraints (another week) keeps showing the last rows, marked loading, until the new ones arrive.
  const last = useRef<ColState<T>>(undefined);
  if (!cur.loading) last.current = cur;
  const prev = last.current;
  return useMemo(() => (cur.loading && prev ? { data: prev.data, loading: true } : cur), [cur, prev]);
}

const documents = new Map<string, Shared<{ data: unknown; loading: boolean }>>();
const DOC_LOADING = { data: null, loading: true };

export function useDocument<T>(path: string[] | null) {
  const k = path?.join("/");
  const shared = useMemo(() => {
    if (!k) return null;
    let s = documents.get(k);
    if (!s) {
      s = new Shared<{ data: unknown; loading: boolean }>(
        DOC_LOADING,
        (set) => onSnapshot(doc(db, k), (d) => set({ data: d.data() ?? null, loading: false })),
        () => documents.delete(k),
      );
      documents.set(k, s);
    }
    return s;
  }, [k]);
  const store = shared ?? { subscribe: () => noop, getSnapshot: () => DOC_LOADING };
  return useSyncExternalStore(store.subscribe, store.getSnapshot) as { data: T | null; loading: boolean };
}

/** Drop a command for the worker and resolve when it finishes. */
export async function runCommand<R = unknown>(uid: string, type: CommandType, payload: Record<string, unknown> = {}, timeoutMs = 10 * 60_000, opts: { ephemeral?: boolean; /** Progress lines the worker writes while it runs ("Reading 28 messages…"). */ onStage?: (stage: string) => void } = {}) {
  if (isDemoUser()) throw new Error("This needs a linked WhatsApp, so it's off in the demo. Sign in with Google to try it for real.");
  // `ephemeral`: the result holds chat text (Messages page). It expires fast, and is deleted here the moment it has been read.
  const ref = await addDoc(userCol(uid, "commands"), { type, payload, status: "pending", createdAt: Date.now(), expireAt: expireAt(opts.ephemeral ? TTL_DAYS.messages : TTL_DAYS.commands) } satisfies Command);
  const forget = () => (opts.ephemeral ? void deleteDoc(ref).catch(() => undefined) : undefined);
  return new Promise<R>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error("The worker didn't respond. Is your server running?"));
    }, timeoutMs);
    const unsub = onSnapshot(ref, (s) => {
      const d = s.data() as (Command & { result?: R }) | undefined;
      if (d?.stage) opts.onStage?.(d.stage);
      if (d?.status === "done") {
        clearTimeout(timer);
        unsub();
        forget();
        resolve(d.result as R);
      } else if (d?.status === "error") {
        clearTimeout(timer);
        unsub();
        forget();
        // An older server doesn't know newer commands: say what to do instead of "Unknown command x".
        reject(new Error(/^Unknown command /.test(d.error ?? "") ? "The server running your account is on an older version that can't do this yet. Update it (Server page, or its console), then try again." : (d.error ?? "Command failed")));
      }
    });
  });
}

export function useNow(intervalMs = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function timeAgo(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}
