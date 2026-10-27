// The member directory: every approved member (name, email, photo) for the member picker. One callable, fetched once per session.
import { getApp } from "firebase/app";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";

export interface MemberEntry {
  uid: string;
  name: string;
  email: string;
  photoURL: string | null;
}

let pending: Promise<MemberEntry[]> | null = null;
let emulatorConnected = false;

function functions() {
  const fns = getFunctions(getApp(), "asia-south1");
  if (import.meta.env.DEV && import.meta.env.VITE_USE_EMULATORS === "1" && !emulatorConnected) {
    emulatorConnected = true;
    connectFunctionsEmulator(fns, "127.0.0.1", 5001);
  }
  return fns;
}

/** Everyone approved in the app, sorted by name. Cached for the session; a failure isn't cached, so the next call retries. */
export function loadMembers(): Promise<MemberEntry[]> {
  pending ??= httpsCallable<unknown, { members: MemberEntry[] }>(functions(), "listMembers")({})
    .then((r) => r.data.members)
    .catch((e: { message?: string }) => {
      pending = null;
      throw new Error(e.message && !/^internal$/i.test(e.message) ? e.message : "Couldn't load the members. Check your connection and try again.");
    });
  return pending;
}

/** Forget the cached list (after sign-out, or to pick up someone who has just joined). */
export const resetMembers = () => { pending = null; };
