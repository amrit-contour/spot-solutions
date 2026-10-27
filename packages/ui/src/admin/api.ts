// Data and server calls behind the shared admin area (Members, Admins). Both apps share one Firebase project, one `access/{uid}`
// record per person and one `config/access.admins` list. Admins may read and decide every access record (firestore.rules); the
// admin list itself can only be changed by the `setAdmin` callable, which refuses to remove the last admin.
import { useCallback, useEffect, useState } from "react";
import { getApp } from "firebase/app";
import { collection, doc, onSnapshot, updateDoc } from "firebase/firestore";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";
import { db } from "../firebase";

export interface AccessRecord {
  uid: string;
  email: string | null;
  name: string | null;
  photo?: string | null;
  status: "pending" | "approved" | "removed";
  requestedAt: number;
  decidedAt?: number | null;
  decidedBy?: string | null;
  note?: string | null;
}

export interface Activity {
  curating: boolean;
  comedy: boolean;
  lastSeen: number | null;
}

let emulatorConnected = false;
function functions() {
  const fns = getFunctions(getApp(), "asia-south1");
  if (import.meta.env.DEV && import.meta.env.VITE_USE_EMULATORS === "1" && !emulatorConnected) {
    emulatorConnected = true;
    connectFunctionsEmulator(fns, "127.0.0.1", 5001);
  }
  return fns;
}

/** Turn a callable failure into words for the person (never a stack trace or "internal"). */
export const callError = (e: unknown, fallback: string) => {
  const m = (e as { message?: string })?.message;
  const clean = m?.replace(/\s*\[\d{3}\]$/, "");
  return clean && !/^(internal|functions\/)/i.test(clean) && !/Failed to fetch|NetworkError/i.test(clean) ? clean : fallback;
};

/** Every access record, live. Only admins can read them all, so call this from admin screens only. */
export function useAccessList() {
  const [list, setList] = useState<AccessRecord[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(
    () =>
      onSnapshot(
        collection(db, "access"),
        (q) => {
          setError(false);
          setList(q.docs.map((d) => ({ ...(d.data() as Omit<AccessRecord, "uid">), uid: d.id })));
        },
        () => setError(true),
      ),
    [],
  );
  return { list, error };
}

/** config/access.admins, lower-cased, live. */
export function useAdminEmails() {
  const [admins, setAdmins] = useState<string[] | null>(null);
  useEffect(() => onSnapshot(doc(db, "config", "access"), (s) => setAdmins(((s.data()?.admins as string[] | undefined) ?? []).map((a) => a.toLowerCase())), () => setAdmins([])), []);
  return admins;
}

/** Approve, decline, remove or restore someone (their access record). Firestore rules allow admins only. */
export const decideAccess = (uid: string, status: AccessRecord["status"], by: string) => updateDoc(doc(db, "access", uid), { status, decidedAt: Date.now(), decidedBy: by });

/** Add or remove an admin. The server checks everything that matters, including "never the last admin". */
export const setAdminRole = (email: string, admin: boolean) =>
  httpsCallable<{ email: string; admin: boolean }, { admins: string[] }>(functions(), "setAdmin")({ email, admin }).then((r) => r.data.admins);

/** Which app each member uses and when they were last seen; null while loading or if it can't be loaded (the list still works). */
export function useActivity() {
  const [activity, setActivity] = useState<Record<string, Activity> | null>(null);
  const load = useCallback(() => {
    httpsCallable<unknown, { activity: Record<string, Activity> }>(functions(), "memberActivity")({}).then(
      (r) => setActivity(r.data.activity),
      () => undefined,
    );
  }, []);
  useEffect(load, [load]);
  return activity;
}
