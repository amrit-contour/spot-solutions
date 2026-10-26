// Per-user Firestore reads the worker needs on hot paths, kept warm with snapshot listeners.
import { DEFAULT_SETTINGS, aiFromLegacy, closedRequestsWeeks, type Settings, type Show, type Venue } from "@spot/shared";
import { col, userRef } from "./firebase.ts";

interface Cache {
  settings: Settings;
  shows: Show[];
  venues: Venue[];
  unsub: (() => void)[];
}

const caches = new Map<string, Cache>();

export function watchUser(uid: string): Cache {
  let c = caches.get(uid);
  if (c) return c;
  const cache: Cache = { settings: DEFAULT_SETTINGS, shows: [], venues: [], unsub: [] };
  cache.unsub.push(
    userRef(uid).onSnapshot((s) => {
      const data = s.data()?.settings as Partial<Settings> | undefined;
      cache.settings = { ...DEFAULT_SETTINGS, ...data, ack: { ...DEFAULT_SETTINGS.ack, ...data?.ack }, confirm: { ...DEFAULT_SETTINGS.confirm, ...data?.confirm }, cancelSpot: { ...DEFAULT_SETTINGS.cancelSpot, ...data?.cancelSpot }, reject: { ...DEFAULT_SETTINGS.reject, ...data?.reject }, rules: { ...DEFAULT_SETTINGS.rules, ...data?.rules, window: { ...DEFAULT_SETTINGS.rules.window, ...data?.rules?.window } }, selfService: { ...DEFAULT_SETTINGS.selfService, ...data?.selfService }, onboarding: { ...DEFAULT_SETTINGS.onboarding, ...data?.onboarding }, micCheck: { ...DEFAULT_SETTINGS.micCheck, ...data?.micCheck }, hostPoll: { ...DEFAULT_SETTINGS.hostPoll, ...data?.hostPoll }, offers: { ...DEFAULT_SETTINGS.offers, ...data?.offers }, googleContacts: { ...DEFAULT_SETTINGS.googleContacts, ...data?.googleContacts }, retention: { closedRequestsWeeks: closedRequestsWeeks(data) }, ai: aiFromLegacy(data) };
    }),
    col(uid, "shows").onSnapshot((q) => {
      cache.shows = q.docs.map((d) => ({ ...(d.data() as Show), id: d.id }));
    }),
    col(uid, "venues").onSnapshot((q) => {
      cache.venues = q.docs.map((d) => ({ ...(d.data() as Venue), id: d.id }));
    }),
  );
  caches.set(uid, cache);
  return cache;
}

export function unwatchUser(uid: string) {
  caches.get(uid)?.unsub.forEach((u) => u());
  caches.delete(uid);
}
