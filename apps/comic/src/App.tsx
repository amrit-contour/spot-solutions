import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Toaster } from "sonner";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { ComicLogo } from "./components/ComicLogo";
import { AccountMenu, AppShell, ErrorBoundary, Spinner, UpdatePrompt, lazyRoute, prefetchRoutes, type RouteComponent, IconSend, IconBell, IconCalendarMark, IconMic, IconRoom, IconSettings, type NavEntry } from "@spot/ui";
import { auth } from "@spot/ui/firebase";
import { useConnection, connectionStatus } from "./lib/connection";
import { isStandalone } from "./lib/install";
import { useForegroundPush } from "./lib/push";
import { RosterProvider, useFirestoreRoster } from "./lib/roster";
import { ComicViewPrefs } from "./lib/viewPrefs";
import { RouteSkeleton } from "./components/RouteSkeleton";

// One chunk per page (see @spot/ui lazyRoute): the shell appears at once and a page's code downloads when it is first opened.
const Landing = lazyRoute(() => import("./routes/Landing").then((m) => ({ default: m.Landing })));
const SignIn = lazyRoute(() => import("./routes/SignIn").then((m) => ({ default: m.SignIn })));
const Rooms = lazyRoute(() => import("./routes/Rooms").then((m) => ({ default: m.Rooms })));
const Alerts = lazyRoute(() => import("./routes/Alerts").then((m) => ({ default: m.Alerts })));
const Groups = lazyRoute(() => import("./routes/Groups").then((m) => ({ default: m.Groups })));
const Settings = lazyRoute(() => import("./routes/Settings").then((m) => ({ default: m.Settings })));
const Admin = lazyRoute(() => import("./routes/Admin").then((m) => ({ default: m.Admin })));
const ComicStores = lazyRoute(() => import("./routes/Stores").then((m) => ({ default: m.ComicStores })));
const Today = lazyRoute(() => import("./routes/Today").then((m) => ({ default: m.Today })));
const Asks = lazyRoute(() => import("./routes/Asks").then((m) => ({ default: m.Asks })));
const MySpots = lazyRoute(() => import("./routes/MySpots").then((m) => ({ default: m.MySpots })));
const Regulars = lazyRoute(() => import("./routes/Regulars").then((m) => ({ default: m.Regulars })));
const RostersApp = lazyRoute(() => import("./routes/RostersApp").then((m) => ({ default: m.RostersApp })));

// Dev only: the Rooms page on the Bangalore seed with no sign-in (/dev/rooms, or /dev/rooms?empty=1). Dropped from production builds.
const DevApp = import.meta.env.DEV ? lazy(() => import("./routes/DevApp")) : null;

const PAGES: Record<string, RouteComponent> = { "/": Today, "/rooms": Rooms, "/alerts": Alerts, "/asks": Asks, "/spots": MySpots, "/settings": Settings };

/** Warms the page chunks while idle and when a link is hovered or touched. */
function RoutePrefetch() {
  useEffect(() => prefetchRoutes(PAGES, ["/rooms", "/alerts", "/asks", "/spots", "/settings"]), []);
  return null;
}

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
      <ComicViewPrefs uid={user.uid}>{children}</ComicViewPrefs>
    </AppShell>
  );
}

const PageSpinner = () => (
  <div className="grid min-h-dvh place-items-center text-primary">
    <Spinner className="size-8" />
  </div>
);

export default function App() {
  const user = useAuthUser();
  const { pathname } = useLocation();
  if (DevApp && pathname.startsWith("/dev/")) {
    return <Suspense fallback={null}><DevApp nav={NAV} /></Suspense>;
  }
  return (
    <>
      <UpdatePrompt />
      <Toaster
        position="bottom-center"
        toastOptions={{ style: { background: "var(--md-sys-color-inverse-surface)", color: "var(--md-sys-color-inverse-on-surface)", border: "none", borderRadius: 8, fontFamily: "var(--font-sans)" } }}
      />
      {user === undefined ? (
        <PageSpinner />
      ) : user === null ? (
        // The installed app is already "the product": skip the marketing page and go straight to signing in.
        <Suspense fallback={<PageSpinner />}>{isStandalone() ? <SignIn /> : <Landing />}</Suspense>
      ) : (
        <SignedInShell user={user}>
          <PushBridge />
          <RoutePrefetch />
          <ErrorBoundary resetKey={pathname}>
          <Suspense fallback={<RouteSkeleton />}>
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
          </Suspense>
          </ErrorBoundary>
        </SignedInShell>
      )}
    </>
  );
}
