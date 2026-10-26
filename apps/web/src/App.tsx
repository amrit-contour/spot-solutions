import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Toaster } from "sonner";
import { AppProvider, useAuthUser } from "./lib/app";
import { Shell } from "./components/Shell";
import { Spinner } from "./components/ui";
import { Landing } from "./routes/Landing";
import { Requests } from "./routes/Requests";
import { LineupBoard } from "./routes/Lineup";
import { Comics } from "./routes/Comics";
import { Shows } from "./routes/Shows";
import { SettingsPage } from "./routes/Settings";
import { ServerPage } from "./routes/Server";
import { Waiting } from "./routes/Waiting";
import { useAccess } from "./lib/access";
import { HelpPage } from "./routes/Help";
import { AdminOnly } from "./components/AdminOnly";
import { ConnectServer } from "./routes/ConnectServer";
import { InstallPage } from "./routes/InstallPage";

export default function App() {
  const user = useAuthUser();
  const access = useAccess(user);
  // Public or sign-in-first pages that don't need an approved account.
  const { pathname } = useLocation();
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
        <Landing />
      ) : access === undefined ? (
        <div className="grid min-h-dvh place-items-center text-primary">
          <Spinner className="size-8" />
        </div>
      ) : access?.status !== "approved" ? (
        <Waiting user={user} entry={access} />
      ) : (
        <AppProvider user={user}>
          <Shell>
            <Routes>
              <Route path="/" element={<Requests />} />
              <Route path="/lineup" element={<LineupBoard />} />
              <Route path="/comics" element={<Comics />} />
              <Route path="/shows" element={<Shows />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/server" element={<ServerPage />} />
              <Route path="/help" element={<AdminOnly><HelpPage /></AdminOnly>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Shell>
        </AppProvider>
      )}
    </>
  );
}
