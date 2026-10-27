// Dev only: the shell and Rooms page with no sign-in, on the Bangalore seed (or empty with ?empty=1). Nothing is saved.
import { useLocation } from "react-router-dom";
import { ComicLogo } from "../components/ComicLogo";
import { AppShell, Spinner, type NavEntry } from "@spot/ui";
import { BLR_ROSTER } from "@spot/shared/fixtures/blrRooms";
import { DevRooms } from "./DevRooms";

export default function DevApp({ nav }: { nav: NavEntry[] }) {
  const empty = new URLSearchParams(useLocation().search).has("empty");
  return (
    <AppShell nav={nav} appName="Nothing BOT Comedy" logo={<ComicLogo className="size-11" />} accountMenu={() => null}>
      {BLR_ROSTER ? <DevRooms initial={empty ? { rooms: [], curators: [] } : structuredClone(BLR_ROSTER)} /> : <Spinner />}
    </AppShell>
  );
}
