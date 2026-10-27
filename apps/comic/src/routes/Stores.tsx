import { Outlet } from "react-router-dom";
import { AsksProvider, useFirestoreAsks } from "../lib/asks";
import { RosterProvider, useFirestoreRoster } from "../lib/roster";

/** A layout route: the comic's rooms, asks and spots, live from Firestore, for Today, Asks and My spots. */
export function ComicStores({ uid }: { uid: string }) {
  const roster = useFirestoreRoster(uid);
  const asks = useFirestoreAsks(uid);
  return (
    <RosterProvider store={roster}>
      <AsksProvider store={asks}>
        <Outlet />
      </AsksProvider>
    </RosterProvider>
  );
}
