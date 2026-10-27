import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Toaster } from "sonner";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { ComicLogo } from "./components/ComicLogo";
import { AccountMenu, AppShell, ErrorBoundary, Spinner, IconSend, IconBell, IconCalendarMark, IconMic, IconRoom, IconSettings, type NavEntry } from "@spot/ui";
import { auth } from "@spot/ui/firebase";
import { useConnection, connectionStatus } from "./lib/connection";
import { Landing } from "./routes/Landing";
import { SignIn } from "./routes/SignIn";
import { isStandalone } from "./lib/install";
import { Rooms } from "./routes/Rooms";
import { Alerts } from "./routes/Alerts";
import { Groups } from "./routes/Groups";
import { Settings } from "./routes/Settings";
import { Admin } from "./routes/Admin";
import { useForegroundPush } from "./lib/push";
import { ComicStores } from "./routes/Stores";
import { Today } from "./routes/Today";
import { Asks } from "./routes/Asks";
import { MySpots } from "./routes/MySpots";
import { Regulars } from "./routes/Regulars";
import { RostersApp } from "./routes/RostersApp";
import { RosterProvider, useFirestoreRoster } from "./lib/roster";

// Dev only: the Rooms page on the Bangalore seed with no sign-in (/dev/rooms, or /dev/rooms?empty=1). Dropped from production builds.
const DevApp = import.meta.env.DEV ? lazy(() => import("./routes/DevApp")) : null;

/** Everything signed-in that needs the comic's rooms. */
function RosterRoutes({ uid }: { uid: string }) {
  const store = useFirestoreRoster(uid);
  return (
    <RosterProvider store={store}>
      <Rooms />
    </RosterProvider>
  );
}

/** While the app is open, a spot alert push shows as a toast with "Ask for it" (see lib/push.ts). */
function PushBridge() {
  const nav = useNavigate();
  useForegroundPush(useCallback((id: string) => nav(`/alerts?alert=${encodeURIComponent(id)}&ask=1`), [nav]));
  return null;
}

// Same Firebase project and Google account as Nothing BOT Curate. Undefined while Firebase is still working it out.
function useAuthUser() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => onAuthStateChanged(auth, setUser), []);
  return user;
}

const NAV: NavEntry[] = [
  { to: "/", label: "Today", short: "Home", icon: IconCalendarMark },
  { to: "/rooms", label: "Rooms", icon: IconRoom },
  { to: "/alerts", label: "Alerts", icon: IconBell },
  { to: "/asks", label: "Asks", icon: IconSend },
  { to: "/spots", label: "My spots", short: "Spots", icon: IconMic },
  // Settings lives in the account menu on phones.
  { to: "/settings", label: "Settings", icon: IconSettings, phoneHidden: true },
];

/** The shell with the account button's WhatsApp dot: one connection subscription for the whole signed-in app. */
function SignedInShell({ user, children }: { user: User; children: ReactNode }) {
  const c = useConnection(user.uid);
  const status = connectionStatus(c);
  return (
    <AppShell nav={NAV} appName="Nothing BOT Comedy" logo={<ComicLogo className="size-11" />} accountMenu={(align) => <AccountMenu user={user} align={align} status={status} onSignOut={() => void signOut(auth)} />}>
      {children}
    </AppShell>
  );
}

export default function App() {
  const user = useAuthUser();
  const { pathname } = useLocation();
  if (DevApp && pathname.startsWith("/dev/")) {
    return <Suspense fallback={null}><DevApp nav={NAV} /></Suspense>;
  }
  return (
    <>
      <Toaster
        position="bottom-center"
        toastOptions={{ style: { background: "var(--md-sys-color-inverse-surface)", color: "var(--md-sys-color-inverse-on-surface)", border: "none", borderRadius: 8, fontFamily: "var(--font-sans)" } }}
      />
      {user === undefined ? (
        <div className="grid min-h-dvh place-items-center text-primary">
          <Spinner className="size-8" />
        </div>
      ) : user === null ? (
        // The installed app is already "the product": skip the marketing page and go straight to signing in.
        isStandalone() ? <SignIn /> : <Landing />
      ) : (
        <SignedInShell user={user}>
          <PushBridge />
          <ErrorBoundary resetKey={pathname}>
          <Routes>
            <Route path="/rooms/*" element={<RosterRoutes uid={user.uid} />} />
            <Route path="/rosters/*" element={<RostersApp user={user} />} />
            <Route element={<ComicStores uid={user.uid} />}>
              <Route path="/" element={<Today uid={user.uid} />} />
              <Route path="/asks" element={<Asks />} />
              <Route path="/spots" element={<MySpots />} />
              <Route path="/spots/regulars" element={<Regulars />} />
              <Route path="/settings" element={<Settings uid={user.uid} />} />
            </Route>
            <Route path="/alerts" element={<Alerts uid={user.uid} />} />
            <Route path="/groups" element={<Groups uid={user.uid} />} />
            <Route path="/admin" element={<Admin user={user} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </ErrorBoundary>
        </SignedInShell>
      )}
    </>
  );
}
