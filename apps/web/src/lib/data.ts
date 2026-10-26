import { useEffect, useState } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  Timestamp,
  type QueryConstraint,
} from "firebase/firestore";
import { TTL_DAYS, ttlMs, type Command, type CommandType } from "@spot/shared";
import { db } from "./firebase";
import { isDemoUser } from "./demo";

/** Firestore TTL field: a Timestamp (not a number), `days` from now. See deploy/setup-cost-controls.sh. */
export const expireAt = (days: number) => Timestamp.fromMillis(ttlMs(days));

export const userCol = (uid: string, name: string) => collection(db, "users", uid, name);
export const userDoc = (uid: string, name: string, id: string) => doc(db, "users", uid, name, id);

/** Live collection under users/{uid}. `key` re-subscribes when constraints change. */
export function useCollection<T>(uid: string | undefined, name: string, constraints: QueryConstraint[] = [], key = "") {
  const [state, setState] = useState<{ data: T[]; loading: boolean }>({ data: [], loading: true });
  useEffect(() => {
    if (!uid) return;
    setState((s) => ({ ...s, loading: true }));
    return onSnapshot(
      query(userCol(uid, name), ...constraints),
      (q) => setState({ data: q.docs.map((d) => ({ ...(d.data() as T), id: d.id })), loading: false }),
      (e) => {
        console.error(name, e);
        setState({ data: [], loading: false });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, name, key]);
  return state;
}

export function useDocument<T>(path: string[] | null) {
  const [state, setState] = useState<{ data: T | null; loading: boolean }>({ data: null, loading: true });
  const k = path?.join("/");
  useEffect(() => {
    if (!path) return;
    return onSnapshot(doc(db, path.join("/")), (s) => setState({ data: (s.data() as T) ?? null, loading: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k]);
  return state;
}

/** Drop a command for the worker and resolve when it finishes. */
export async function runCommand<R = unknown>(uid: string, type: CommandType, payload: Record<string, unknown> = {}, timeoutMs = 10 * 60_000, opts: { ephemeral?: boolean } = {}) {
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

export const initials = (name: string) =>
  name
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("") || "?";
