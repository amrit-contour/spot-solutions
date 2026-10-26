// Dev only (import.meta.env.DEV): the Rooms page with an in-memory roster, no sign-in, nothing saved.
import { Route, Routes } from "react-router-dom";
import type { Roster } from "@spot/shared";
import { RosterProvider, useMemoryRoster } from "../lib/roster";
import { Rooms } from "./Rooms";

function Demo({ initial }: { initial: Roster }) {
  const store = useMemoryRoster(initial);
  return (
    <RosterProvider store={store}>
      <Rooms base="/dev/rooms" />
    </RosterProvider>
  );
}

export function DevRooms({ initial }: { initial: Roster }) {
  return (
    <Routes>
      <Route path="/dev/rooms/*" element={<Demo initial={initial} />} />
    </Routes>
  );
}
