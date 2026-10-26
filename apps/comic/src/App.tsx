import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Toaster } from "sonner";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { AccountMenu, AppShell, Spinner, IconAdd, IconCalendarMark, IconMic, IconBuilding, IconSettings, type NavEntry } from "@spot/ui";
import { auth } from "@spot/ui/firebase";
import { SignIn } from "./routes/SignIn";
import { Placeholder } from "./routes/Placeholder";
import { Rooms } from "./routes/Rooms";
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

// Same Firebase project and Google account as Nothing BOT Curating. Undefined while Firebase is still working it out.
function useAuthUser() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => onAuthStateChanged(auth, setUser), []);
  return user;
}

const NAV: NavEntry[] = [
  { to: "/", label: "Today", short: "Home", icon: IconCalendarMark },
  { to: "/rooms", label: "Rooms", icon: IconBuilding },
  { to: "/asks", label: "Asks", icon: IconAdd },
  { to: "/spots", label: "My spots", short: "Spots", icon: IconMic },
  // Settings lives in the account menu on phones.
  { to: "/settings", label: "Settings", icon: IconSettings, phoneHidden: true },
];

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
        <SignIn />
      ) : (
        <AppShell nav={NAV} appName="Nothing BOT Comedy" accountMenu={(align) => <AccountMenu user={user} align={align} onSignOut={() => void signOut(auth)} />}>
          <Routes>
            <Route path="/" element={<Placeholder icon={IconCalendarMark} title="Today" subtitle="Your day at a glance." empty="Today is coming" text="A calendar of the spots you're on and the rooms you're watching will live here." />} />
            <Route path="/rooms/*" element={<RosterRoutes uid={user.uid} />} />
            <Route path="/asks" element={<Placeholder icon={IconAdd} title="Asks" subtitle="Ask a room for a spot." empty="Asks are coming" text="Ask rooms for a spot in one tap, and see their replies here." />} />
            <Route path="/spots" element={<Placeholder icon={IconMic} title="My spots" subtitle="Everything you're booked for." empty="My spots are coming" text="Your confirmed and pending spots across every room will list here." />} />
            <Route path="/settings" element={<Placeholder icon={IconSettings} title="Settings" subtitle="Alerts and account." empty="Settings are coming" text="Group spot alerts and your preferences will be set here." />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AppShell>
      )}
    </>
  );
}
