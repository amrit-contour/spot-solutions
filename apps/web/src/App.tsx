import { Suspense, useEffect, useMemo } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Toaster } from "sonner";
import { AppProvider, useAuthUser } from "./lib/app";
import { Shell } from "./components/Shell";
import { ErrorBoundary, Spinner, UpdatePrompt, lazyRoute } from "@spot/ui";
import { isStandalone } from "./lib/standalone";
import { useAccess } from "./lib/access";
import { AdminOnly } from "./components/AdminOnly";
import { OverfillHost } from "./lib/overfill";
import { AdminArea, Comics, HelpPage, Home, LineupBoard, Messages, Requests, ServerPage, SettingsPage, Shows, prefetchRoutes } from "./lib/lazyRoutes";
import { RouteSkeleton } from "./components/RouteSkeleton";

// Pages outside the signed-in app load only when someone lands on them.
const Landing = lazyRoute(() => import("./routes/Landing").then((m) => ({ default: m.Landing })));
const SignIn = lazyRoute(() => import("./routes/SignIn").then((m) => ({ default: m.SignIn })));
const Waiting = lazyRoute(() => import("./routes/Waiting").then((m) => ({ default: m.Waiting })));
const ConnectServer = lazyRoute(() => import("./routes/ConnectServer").then((m) => ({ default: m.ConnectServer })));
const InstallPage = lazyRoute(() => import("./routes/InstallPage").then((m) => ({ default: m.InstallPage })));

const PageSpinner = () => (
  <div className="grid min-h-dvh place-items-center text-primary">
    <Spinner className="size-8" />
  </div>
);

/** Once signed in: warm the page chunks while idle, and when a link is hovered or touched. */
function RoutePrefetch() {
  useEffect(() => {
    return prefetchRoutes();
  }, []);
  return null;
}

export default function App() {
  const user = useAuthUser();
  const access = useAccess(user);
  // Public or sign-in-first pages that don't need an approved account.
  const { pathname } = useLocation();
  const installed = useMemo(isStandalone, []);
  const standalone = pathname === "/connect-server" ? <ConnectServer user={user} /> : pathname === "/install" ? <InstallPage /> : null;
  return (
    <>
      <OverfillHost />
      <UpdatePrompt />
      <Toaster
        position="bottom-center"
        toastOptions={{
          style: {
            background: "var(--md-sys-color-inverse-surface)",
            color: "var(--md-sys-color-inverse-on-surface)",
            border: "none",
            borderRadius: 8,
            fontFamily: "var(--font-sans)",
          },
        }}
      />
      {standalone ? (
        <Suspense fallback={<PageSpinner />}>{standalone}</Suspense>
      ) : user === undefined ? (
        <PageSpinner />
      ) : user === null ? (
        // The installed app is already "the product": skip the marketing page and go straight to signing in.
        <Suspense fallback={<PageSpinner />}>{installed ? <SignIn /> : <Landing />}</Suspense>
      ) : access === undefined ? (
        <PageSpinner />
      ) : access?.status !== "approved" ? (
        <Suspense fallback={<PageSpinner />}>
          <Waiting user={user} entry={access} />
        </Suspense>
      ) : (
        <AppProvider user={user}>
          <Shell>
            <RoutePrefetch />
            <ErrorBoundary resetKey={pathname}>
            <Suspense fallback={<RouteSkeleton />}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/requests" element={<Requests />} />
              <Route path="/messages" element={<Messages />} />
              <Route path="/lineup" element={<LineupBoard />} />
              <Route path="/comics" element={<Comics />} />
              <Route path="/shows" element={<Shows />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/server" element={<ServerPage />} />
              <Route path="/admin" element={<AdminOnly><AdminArea /></AdminOnly>} />
              <Route path="/help" element={<AdminOnly><HelpPage /></AdminOnly>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
            </Suspense>
            </ErrorBoundary>
          </Shell>
        </AppProvider>
      )}
    </>
  );
}
