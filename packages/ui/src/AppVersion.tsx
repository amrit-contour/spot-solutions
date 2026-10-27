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
    // One row at every width: the version on the left, the action on its right (shorter label on phones, so it never wraps).
    <div className="flex min-w-0 items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="truncate type-title-s" data-testid="app-version">{versionLabel(u.running)}</p>
        <p className={u.status === "available" ? "type-body-s text-primary" : "type-body-s text-on-surface-variant"} aria-live="polite">{status}</p>
      </div>
      {u.status === "available" ? (
        <Button size="sm" icon={IconRefresh} className="flex-none" onClick={() => void u.updateNow()}>Update<span className="max-sm:hidden">&nbsp;now</span></Button>
      ) : (
        <Button size="sm" variant="tonal" icon={IconRefresh} loading={u.checking} className="flex-none" aria-label="Check for updates" onClick={() => void u.check()}>Check<span className="max-sm:hidden">&nbsp;for updates</span></Button>
      )}
    </div>
  );
}
