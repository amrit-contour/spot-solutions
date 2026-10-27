import { useMemo } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Toaster } from "sonner";
import { AppProvider, useAuthUser } from "./lib/app";
import { Shell } from "./components/Shell";
import { ErrorBoundary, Spinner } from "@spot/ui";
import { Landing } from "./routes/Landing";
import { SignIn } from "./routes/SignIn";
import { isStandalone } from "./lib/standalone";
import { Requests } from "./routes/Requests";
import { Messages } from "./routes/Messages";
import { Home } from "./routes/Calendar";
import { LineupBoard } from "./routes/Lineup";
import { Comics } from "./routes/Comics";
import { Shows } from "./routes/Shows";
import { SettingsPage } from "./routes/Settings";
import { ServerPage } from "./routes/Server";
import { Waiting } from "./routes/Waiting";
import { useAccess } from "./lib/access";
import { HelpPage } from "./routes/Help";
import { AdminArea } from "./routes/Admin";
import { AdminOnly } from "./components/AdminOnly";
import { ConnectServer } from "./routes/ConnectServer";
import { InstallPage } from "./routes/InstallPage";

export default function App() {
  const user = useAuthUser();
  const access = useAccess(user);
  // Public or sign-in-first pages that don't need an approved account.
  const { pathname } = useLocation();
  const installed = useMemo(isStandalone, []);
  const standalone = pathname === "/connect-server" ? <ConnectServer user={user} /> : pathname === "/install" ? <InstallPage /> : null;
  return (
    <>
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
        standalone
      ) : user === undefined ? (
        <div className="grid min-h-dvh place-items-center text-primary">
          <Spinner className="size-8" />
        </div>
      ) : user === null ? (
        // The installed app is already "the product": skip the marketing page and go straight to signing in.
        installed ? <SignIn /> : <Landing />
      ) : access === undefined ? (
        <div className="grid min-h-dvh place-items-center text-primary">
          <Spinner className="size-8" />
        </div>
      ) : access?.status !== "approved" ? (
        <Waiting user={user} entry={access} />
      ) : (
        <AppProvider user={user}>
          <Shell>
            <ErrorBoundary resetKey={pathname}>
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
            </ErrorBoundary>
          </Shell>
        </AppProvider>
      )}
    </>
  );
}
