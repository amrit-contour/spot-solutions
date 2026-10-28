// App-wide state: the signed-in curator, their config, WhatsApp session and the week being curated.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { doc, getDoc, onSnapshot, setDoc } from "firebase/firestore";
import { toast } from "sonner";
import {
  DEFAULT_AI_POLICY,
  DEFAULT_SETTINGS,
  aiFromLegacy,
  weekOf,
  deriveLink,
  deriveServer,
  type Derived,
  type PhoneLink,
  type RestartMarker,
  type Comic,
  type SessionState,
  closedRequestsWeeks,
  type Settings,
  type Show,
  type Venue,
} from "@spot/shared";
import { auth, db } from "@spot/ui/firebase";
import { registerProbe, reportSnapshot, useKnownLinks, usePhoneLink, useRememberLink } from "@spot/ui/phoneLink";
import { useCollection, useDocument, useNow } from "./data";
import { cloneDemo, needsDemoClone } from "./demo";
import { useForegroundPush } from "./push";
import { useNeverReadLinkSync } from "./neverRead";
import { setBrand, ViewPrefsProvider } from "@spot/ui";

interface UserDoc {
  settings?: Partial<Settings>;
  waEnabled?: boolean;
  selfId?: string | null;
}

interface AppState {
  user: User;
  uid: string;
  settings: Settings;
  session: SessionState | null;
  /** The server is alive AND this phone can see it. False also when the phone is offline: check `server.reach` to tell "offline" from "can't tell". */
  workerOnline: boolean;
  /** THE derivation (shared connection.ts deriveServer): up / restarting / offline / unknown. Every page that shows connection state reads this. */
  server: Derived;
  /** This phone's own connection: navigator.onLine and whether the status listeners are on cached data. */
  phone: PhoneLink;
  /** The server announced a planned restart or update and hasn't been silent past its grace period: say "back in a minute", not "offline". */
  serverRestarting: RestartMarker | null;
  shows: Show[];
  venues: Venue[];
  comics: Comic[];
  /** The roster snapshot has arrived. Writes that depend on knowing who is already there wait for it. */
  comicsLoaded: boolean;
  comicsById: Map<string, Comic>;
  week: string;
  setWeek: (w: string) => void;
  currentWeek: string;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside provider");
  return v;
}

export function useAuthUser() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    // Localhost only: sign in with a custom token minted by scripts/seed-demo.ts (needs the service account, so not a bypass).
    const devToken = location.hostname === "localhost" ? new URLSearchParams(location.search).get("devToken") : null;
    if (devToken) {
      history.replaceState(null, "", location.pathname);
      void import("firebase/auth").then(({ signInWithCustomToken }) => signInWithCustomToken(auth, devToken));
    }
    return onAuthStateChanged(auth, setUser);
  }, []);
  return user;
}

export function AppProvider({ user, children }: { user: User; children: ReactNode }) {
  const uid = user.uid;
  const userDoc = useDocument<UserDoc>(["users", uid]);
  const session = useDocument<SessionState>(["users", uid, "session", "state"]);
  const shows = useCollection<Show>(uid, "shows");
  const venues = useCollection<Venue>(uid, "venues");
  const comics = useCollection<Comic>(uid, "comics");
  const now = useNow(10_000);
  const phone = usePhoneLink();
  const known = useKnownLinks(uid);
  useForegroundPush();

  // Tell phoneLink whether the session listener is getting server data or only the cache (metadata changes arrive when it flips).
  useEffect(
    () =>
      onSnapshot(
        doc(db, "users", uid, "session", "state"),
        { includeMetadataChanges: true },
        (snap) => reportSnapshot("session", snap.metadata.fromCache),
        () => reportSnapshot("session", true),
      ),
    [uid],
  );
  // On resume after a while the cached status is re-read from the server before it is believed.
  useEffect(() => registerProbe("session", doc(db, "users", uid, "session", "state")), [uid]);

  // First sign-in: create the user doc so the worker starts listening for this curator.
  useEffect(() => {
    const ref = doc(db, "users", uid);
    const clone = () =>
      cloneDemo(uid).catch((e: Error) => {
        console.error("demo clone failed", e);
        toast.error("Couldn't set up the demo", { description: e.message, duration: Infinity, closeButton: true, action: { label: "Retry", onClick: () => void clone() } });
      });
    getDoc(ref).then((s) => {
      // A demo doc with no marker is a clone that never finished: do it again.
      if (s.exists() && !(user.isAnonymous && needsDemoClone(s.data()))) return;
      if (user.isAnonymous) void clone();
      else void setDoc(ref, { settings: DEFAULT_SETTINGS, email: user.email, name: user.displayName, createdAt: Date.now() });
    });
  }, [uid, user.email, user.displayName, user.isAnonymous]);

  const settings = useMemo<Settings>(() => {
    const s = userDoc.data?.settings ?? {};
    return {
      ...DEFAULT_SETTINGS,
      ...s,
      ack: { ...DEFAULT_SETTINGS.ack, ...s.ack },
      confirm: { ...DEFAULT_SETTINGS.confirm, ...s.confirm },
      cancelSpot: { ...DEFAULT_SETTINGS.cancelSpot, ...s.cancelSpot },
      reject: { ...DEFAULT_SETTINGS.reject, ...s.reject },
      rules: { ...DEFAULT_SETTINGS.rules, ...s.rules, window: { ...DEFAULT_SETTINGS.rules.window, ...s.rules?.window } },
      selfService: { ...DEFAULT_SETTINGS.selfService, ...s.selfService },
      onboarding: { ...DEFAULT_SETTINGS.onboarding, ...s.onboarding },
      micCheck: { ...DEFAULT_SETTINGS.micCheck, ...s.micCheck },
      hostPoll: { ...DEFAULT_SETTINGS.hostPoll, ...s.hostPoll },
      offers: { ...DEFAULT_SETTINGS.offers, ...s.offers },
      googleContacts: { ...DEFAULT_SETTINGS.googleContacts, ...s.googleContacts },
      agent: { ...DEFAULT_SETTINGS.agent!, ...s.agent },
      retention: { closedRequestsWeeks: closedRequestsWeeks(s) },
      ai: { ...aiFromLegacy(s), policy: s.ai?.policy ?? DEFAULT_AI_POLICY },
    };
  }, [userDoc.data]);

  // A group on Never read that gets linked (show group, Comedy watched group) comes off the list: linked groups win.
  useNeverReadLinkSync(uid, shows.data, settings, (patch) => setDoc(doc(db, "users", uid), { settings: patch }, { merge: true }));

  // Brand: the saved choice, else NBC (Classic for demo sandboxes so they match the published screenshots).
  const brand = settings.appearance?.brand ?? (user.isAnonymous ? "classic" : "nbc");
  const brandReady = !userDoc.loading;
  useEffect(() => {
    if (brandReady) setBrand(brand, { animate: true });
  }, [brand, brandReady]);

  const currentWeek = weekOf(new Date(now), settings.timezone, 0);
  const [week, setWeek] = useState(currentWeek);

  const sortedShows = useMemo(
    () => [...shows.data].sort((a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7) || a.startTime.localeCompare(b.startTime)),
    [shows.data],
  );
  const comicsById = useMemo(() => new Map(comics.data.map((c) => [c.id, c])), [comics.data]);
  const server = useMemo(() => deriveServer(session.data, now, phone, known), [session.data, now, phone, known]);
  // Remember the live WhatsApp state per account so the next cold open can show it (as the last known status) before Firestore answers.
  useRememberLink(uid, "main", deriveLink(session.data, server), server.checking);
  const workerOnline = server.up;
  const serverRestarting = server.restarting;

  const settingsWithoutPrefs = useMemo(() => {
    const { prefs: _prefs, ...rest } = settings;
    return rest;
  }, [settings]);
  const remotePrefs = useMemo<Record<string, unknown> | undefined>(() => (userDoc.loading ? undefined : { ...userDoc.data?.settings?.prefs }), [userDoc.loading, userDoc.data]);
  const savePrefs = useCallback((patch: Record<string, unknown>) => setDoc(doc(db, "users", uid), { settings: { prefs: patch } }, { merge: true }), [uid]);

  const value = useMemo<AppState>(
    () => ({
      user,
      uid,
      settings,
      session: session.data,
      workerOnline,
      server,
      phone,
      serverRestarting,
      shows: sortedShows,
      venues: venues.data,
      comics: comics.data,
      comicsLoaded: !comics.loading,
      comicsById,
      week,
      setWeek,
      currentWeek,
      // prefs are saved on their own (debounced, see ViewPrefsProvider): a stale copy here must never overwrite a newer choice.
      saveSettings: (patch) => setDoc(doc(db, "users", uid), { settings: { ...settingsWithoutPrefs, ...patch } }, { merge: true }),
    }),
    [user, uid, settings, settingsWithoutPrefs, session.data, workerOnline, server, phone, serverRestarting, sortedShows, venues.data, comics.data, comics.loading, comicsById, week, currentWeek],
  );

  return (
    <Ctx.Provider value={value}>
      <ViewPrefsProvider remote={remotePrefs} save={savePrefs}>
        {children}
      </ViewPrefsProvider>
    </Ctx.Provider>
  );
}
