// Google Contacts sync planning: pure, so the browser code and the tests share it.
import { normalizePhone } from "./people.ts";
import type { Comic } from "./types.ts";

/** What we remember about a Google contact that has a phone number. */
export interface GoogleContactRef {
  resourceName: string; // people/c123
  etag: string;
  displayName: string;
}

/** Normalised phone key (last 10 digits, or the full number) to the Google contact that owns it. */
export type GoogleIndex = Map<string, GoogleContactRef>;

type SyncComic = Pick<Comic, "id" | "name" | "phone">;

/** Keys one number is filed under: the full E.164 digits and the last 10 (so "098765 43210" still matches +91 98765 43210). */
export function phoneKeys(raw: string): string[] {
  const full = normalizePhone(raw);
  if (!full) return [];
  const last10 = full.slice(-10);
  return full === last10 ? [full] : [full, last10];
}

/** Add a contact to the index under every key of each of its numbers. The first contact to claim a key keeps it. */
export function indexGoogleContact(index: GoogleIndex, ref: GoogleContactRef, phones: string[]) {
  for (const p of phones) for (const k of phoneKeys(p)) if (!index.has(k)) index.set(k, ref);
}

const squash = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** "Priya Nair" becomes given "Priya", family "Nair", splitting on the last space. */
export function splitName(name: string): { givenName: string; familyName?: string } {
  const n = name.trim().replace(/\s+/g, " ");
  const i = n.lastIndexOf(" ");
  return i < 0 ? { givenName: n } : { givenName: n.slice(0, i), familyName: n.slice(i + 1) };
}

export interface ContactCreate {
  comicId: string;
  name: string;
  phone: string; // digits with country code
}
export interface ContactUpdate extends ContactCreate {
  resourceName: string;
  etag: string;
  /** The name Google has now. */
  from: string;
}
export interface ContactSkip {
  comicId: string;
  name: string;
  reason: "no-phone" | "hidden-number" | "bad-phone" | "no-name";
}
export interface ContactPlan {
  create: ContactCreate[];
  update: ContactUpdate[];
  unchanged: ContactCreate[];
  skipped: ContactSkip[];
}

/** Decide, per comic, whether Google needs a new contact, a new name, or nothing. Matches by phone only. */
export function planContactSync(comics: SyncComic[], google: GoogleIndex): ContactPlan {
  const plan: ContactPlan = { create: [], update: [], unchanged: [], skipped: [] };
  const seen = new Set<string>(); // two comics with one number must not create two contacts
  for (const c of comics) {
    const skip = (reason: ContactSkip["reason"]) => plan.skipped.push({ comicId: c.id, name: c.name, reason });
    if (!c.phone) {
      skip(c.id.endsWith("@lid") ? "hidden-number" : "no-phone");
      continue;
    }
    const keys = phoneKeys(c.phone);
    if (!keys.length) {
      skip("bad-phone");
      continue;
    }
    if (!squash(c.name ?? "")) {
      skip("no-name");
      continue;
    }
    const phone = normalizePhone(c.phone);
    const item = { comicId: c.id, name: c.name.trim().replace(/\s+/g, " "), phone };
    const hit = keys.map((k) => google.get(k)).find(Boolean);
    if (hit) {
      if (squash(hit.displayName) === squash(c.name)) plan.unchanged.push(item);
      else plan.update.push({ ...item, resourceName: hit.resourceName, etag: hit.etag, from: hit.displayName });
    } else if (!seen.has(keys[keys.length - 1])) {
      seen.add(keys[keys.length - 1]);
      plan.create.push(item);
    }
  }
  return plan;
}
