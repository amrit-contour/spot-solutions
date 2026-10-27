import { versionLabel } from "@spot/shared";
import { Button } from "./ui";
import { IconRefresh } from "./icons";
import { useAppUpdate } from "./useAppUpdate";

/** Settings → About: the running version and build time, whether it is the latest, and a button to check or update. */
export function AppVersionRow() {
  const u = useAppUpdate();
  const status =
    u.status === "available" ? <>Update available</>
    : u.running.version === "dev" ? <>Development build</>
    : u.checking || (!u.served && !u.failed) ? <>Checking…</>
    : u.status === "current" ? <>Up to date</>
    : <>Couldn't check. Offline?</>;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3">
      <div className="min-w-0 flex-1 basis-48">
        <p className="type-title-s" data-testid="app-version">{versionLabel(u.running)}</p>
        <p className={u.status === "available" ? "type-body-s text-primary" : "type-body-s text-on-surface-variant"} aria-live="polite">{status}</p>
      </div>
      {u.status === "available" ? (
        <Button size="sm" icon={IconRefresh} onClick={() => void u.updateNow()}>Update now</Button>
      ) : (
        <Button size="sm" variant="tonal" icon={IconRefresh} loading={u.checking} onClick={() => void u.check()}>Check for updates</Button>
      )}
    </div>
  );
}
