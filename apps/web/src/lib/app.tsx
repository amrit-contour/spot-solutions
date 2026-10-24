// App-wide state: the signed-in curator, their config, WhatsApp session and the week being curated.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import {
  DEFAULT_SETTINGS,
  rolloverDayFor,
  weekOf,
  type Comic,
  type SessionState,
  type Settings,
  type Show,
  type Venue,
} from "@spot/shared";
import { auth, db } from "./firebase";
import { useCollection, useDocument, useNow } from "./data";

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
  workerOnline: boolean;
  shows: Show[];
  venues: Venue[];
  comics: Comic[];
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

const WORKER_STALE_MS = 90_000;

export function AppProvider({ user, children }: { user: User; children: ReactNode }) {
  const uid = user.uid;
  const userDoc = useDocument<UserDoc>(["users", uid]);
  const session = useDocument<SessionState>(["users", uid, "session", "state"]);
  const shows = useCollection<Show>(uid, "shows");
  const venues = useCollection<Venue>(uid, "venues");
  const comics = useCollection<Comic>(uid, "comics");
  const now = useNow(10_000);

  // First sign-in: create the user doc so the worker starts listening for this curator.
  useEffect(() => {
    const ref = doc(db, "users", uid);
    getDoc(ref).then((s) => {
      if (!s.exists()) void setDoc(ref, { settings: DEFAULT_SETTINGS, email: user.email, name: user.displayName, createdAt: Date.now() });
    });
  }, [uid, user.email, user.displayName]);

  const settings = useMemo<Settings>(() => {
    const s = userDoc.data?.settings ?? {};
    return {
      ...DEFAULT_SETTINGS,
      ...s,
      ack: { ...DEFAULT_SETTINGS.ack, ...s.ack },
      confirm: { ...DEFAULT_SETTINGS.confirm, ...s.confirm },
      reject: { ...DEFAULT_SETTINGS.reject, ...s.reject },
      rules: { ...DEFAULT_SETTINGS.rules, ...s.rules, window: { ...DEFAULT_SETTINGS.rules.window, ...s.rules?.window } },
      selfService: { ...DEFAULT_SETTINGS.selfService, ...s.selfService },
      onboarding: { ...DEFAULT_SETTINGS.onboarding, ...s.onboarding },
      micCheck: { ...DEFAULT_SETTINGS.micCheck, ...s.micCheck },
      hostPoll: { ...DEFAULT_SETTINGS.hostPoll, ...s.hostPoll },
      offers: { ...DEFAULT_SETTINGS.offers, ...s.offers },
      model: { ...DEFAULT_SETTINGS.model, ...s.model },
    };
  }, [userDoc.data]);

  const currentWeek = weekOf(new Date(now), settings.timezone, rolloverDayFor(shows.data));
  const [week, setWeek] = useState(currentWeek);

  const sortedShows = useMemo(
    () => [...shows.data].sort((a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7) || a.startTime.localeCompare(b.startTime)),
    [shows.data],
  );
  const comicsById = useMemo(() => new Map(comics.data.map((c) => [c.id, c])), [comics.data]);
  const workerOnline = Boolean(session.data?.lastSeen && now - session.data.lastSeen < WORKER_STALE_MS);

  const value = useMemo<AppState>(
    () => ({
      user,
      uid,
      settings,
      session: session.data,
      workerOnline,
      shows: sortedShows,
      venues: venues.data,
      comics: comics.data,
      comicsById,
      week,
      setWeek,
      currentWeek,
      saveSettings: (patch) => setDoc(doc(db, "users", uid), { settings: { ...settings, ...patch } }, { merge: true }),
    }),
    [user, uid, settings, session.data, workerOnline, sortedShows, venues.data, comics.data, comicsById, week, currentWeek],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
