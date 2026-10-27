// Settings → WhatsApp: which server runs this account, when its login was last backed up, and (with 2+ servers) pin / move.
import { useState } from "react";
import { toast } from "sonner";
import { useApp } from "../lib/app";
import { timeAgo, useNow } from "../lib/data";
import { isDemoUser } from "../lib/demo";
import { leaseStale, moveAccount, pinAccount, serverName, serverOnline, useAllServers, useLease, usePrefs, useVault } from "../lib/fleet";
import { Button, Chip } from "@spot/ui";
import { Menu, MenuItem } from "@spot/ui";
import { IconArrowDown, IconServer } from "@spot/ui";

export function FleetCard() {
  const { uid } = useApp();
  const now = useNow(10_000);
  const servers = useAllServers();
  const lease = useLease(uid).data;
  const vault = useVault(uid).data;
  const pinned = usePrefs(uid).data?.pinned ?? null;
  const [busy, setBusy] = useState(false);
  if (isDemoUser() || !lease?.server) return null;

  const online = (servers ?? []).filter((s) => serverOnline(s, now) && !s.draining);
  const others = online.filter((s) => s.id !== lease.server);
  const moving = lease.state === "handing_off";
  const stale = leaseStale(lease, now);
  const here = serverName(servers, lease.server);

  const move = async (id: string) => {
    setBusy(true);
    const t = toast.loading(`Moving to ${serverName(servers, id)}. WhatsApp reconnects in about a minute…`);
    try {
      await moveAccount(uid, id);
      toast.success(`Now running on ${serverName(servers, id)}`, { id: t });
    } catch (e) {
      toast.error((e as Error).message, { id: t });
    } finally {
      setBusy(false);
    }
  };
  const pin = (to: string | null) =>
    pinAccount(uid, to).then(
      () => toast.success(to ? `Your account will stay on ${serverName(servers, to)} whenever it's online` : "Unpinned"),
      (e) => toast.error((e as Error).message),
    );

  return (
    <section className="rounded-xl bg-surface-low p-4 sm:p-6">
      <div className="flex items-start gap-3">
        <span className="grid size-10 flex-none place-items-center rounded-md bg-secondary-container text-on-secondary-container">
          <IconServer className="icon size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate type-title-m" title={moving ? `Moving off ${here}` : stale ? `${here} isn't responding` : `Running on ${here}`}>{moving ? `Moving off ${here}…` : stale ? `${here} isn't responding` : `Running on ${here}`}</h2>
          <p className="mt-0.5 type-body-s text-on-surface-variant">
            {stale ? "Another server will take over in a moment. " : ""}
            {vault ? `Login backed up ${timeAgo(vault.savedAt, now)}` : "Login not backed up yet"}
          </p>
          {pinned && (
            <Chip tone="primary" className="mt-2 max-w-full">
              <span className="truncate">{pinned === lease.server ? "Kept on this server" : `Kept on ${serverName(servers, pinned)}`}</span>
            </Chip>
          )}
        </div>
      </div>
      {online.length > 1 && (
        <div className="mt-4 flex flex-col gap-2 min-[400px]:flex-row min-[400px]:flex-wrap">
          {pinned === lease.server ? (
            <Button size="sm" variant="outlined" className="w-full min-[400px]:w-auto" onClick={() => void pin(null)}>
              Stop keeping on this server
            </Button>
          ) : (
            <Button size="sm" variant="tonal" className="w-full min-[400px]:w-auto" onClick={() => void pin(lease.server)}>
              Keep on this server
            </Button>
          )}
          {others.length > 0 && (
            <div className="flex [&>div]:flex-1 min-[400px]:contents">
            <Menu trigger={(t) => (
              <Button size="sm" variant="outlined" className="w-full min-[400px]:w-auto" loading={busy} disabled={moving} onClick={t}>
                Move to…
                <IconArrowDown className="icon size-4" />
              </Button>
            )}>
              {(close) => others.map((s) => (
                <MenuItem key={s.id} onClick={() => (close(), void move(s.id))}>
                  {s.hostname}
                </MenuItem>
              ))}
            </Menu>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
