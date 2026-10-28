// Dev only: the shell, Rooms, Asks, My spots and Today with no sign-in, on the Bangalore seed (or empty with ?empty=1). Nothing is saved.
import { useMemo } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { ComicLogo } from "../components/ComicLogo";
import { AccountMenu, AppShell, Spinner, type AccountStatus, type NavEntry } from "@spot/ui";
import { BLR_ROSTER } from "@spot/shared/fixtures/blrRooms";
import type { Roster } from "@spot/shared";
import { AsksProvider, useMemoryAsks } from "../lib/asks";
import { RosterProvider, useMemoryRoster } from "../lib/roster";
import { demoAsksAndSpots, demoRoster } from "../lib/devSeed";
import { Asks } from "./Asks";
import { MySpots } from "./MySpots";
import { Rooms } from "./Rooms";
import { Today } from "./Today";
import { DevPickers } from "./DevPickers";

function Demo({ initial }: { initial: Roster }) {
  const seed = useMemo(() => demoAsksAndSpots(initial), [initial]);
  const roster = useMemoryRoster(initial);
  const asks = useMemoryAsks(seed);
  return (
    <RosterProvider store={roster}>
      <AsksProvider store={asks}>
        <Routes>
          <Route path="/dev" element={<Today />} />
          <Route path="/dev/rooms/*" element={<Rooms base="/dev/rooms" />} />
          <Route path="/dev/asks" element={<Asks />} />
          <Route path="/dev/spots" element={<MySpots />} />
          <Route path="/dev/pickers" element={<DevPickers />} />
        </Routes>
      </AsksProvider>
    </RosterProvider>
  );
}

export default function DevApp({ nav }: { nav: NavEntry[] }) {
  const empty = new URLSearchParams(useLocation().search).has("empty");
  // ?status=ok|wait|error|idle shows each state of the account dot.
  const st = new URLSearchParams(useLocation().search).get("status") ?? "ok";
  const table: Record<string, AccountStatus> = { ok: { tone: "ok", label: "WhatsApp connected", detail: "+91 ••••• 16962" }, wait: { tone: "wait", label: "WhatsApp needs a scan" }, error: { tone: "error", label: "Server offline" }, idle: { tone: "idle", label: "WhatsApp not linked" } };
  const status: AccountStatus = { ...(table[st] ?? table.ok) };
  status.to = "/dev/settings";
  status.linkLabel = "Connection";
  const devNav = nav.map((e) => ({ ...e, to: `/dev${e.to === "/" ? "" : e.to}` }));
  const initial = useMemo(() => (empty ? { rooms: [], curators: [] } : demoRoster(structuredClone(BLR_ROSTER))), [empty]);
  return (
    <AppShell nav={devNav} appName="Nothing BOT Comedy" logo={<ComicLogo className="size-11" />} accountMenu={(align) => <AccountMenu user={{ displayName: "Dev Comic", email: "dev@example.com" }} align={align} status={status} onSignOut={() => {}} />}>
      {BLR_ROSTER ? <Demo initial={initial} /> : <Spinner />}
    </AppShell>
  );
}
