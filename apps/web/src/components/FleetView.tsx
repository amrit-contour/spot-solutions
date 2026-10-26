// Server page → Fleet (admins): every server and which one holds each account; move or pin accounts.
import { useEffect, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { toast } from "sonner";
import type { AccessEntry, ServerStatus } from "@spot/shared";
import { db } from "@spot/ui/firebase";
import { timeAgo, useNow } from "../lib/data";
import { REASON, leaseStale, moveAccount, pinAccount, platformName, serverName, serverOnline, useLease, usePrefs, useVault } from "../lib/fleet";
import { Avatar, Chip, IconButton, cx } from "@spot/ui";
import { Menu, MenuItem } from "@spot/ui";
import { Collapsible, CollapsibleBand } from "@spot/ui";
import { RemoveServerButton } from "./RemoveServerButton";
import { IconCpu, IconMenuDots, IconServer } from "@spot/ui";

function ServerRow({ s, now }: { s: ServerStatus; now: number }) {
  const online = serverOnline(s, now);
  const f = s.fleet;
  const pct = f ? Math.min(1, f.hosting / Math.max(1, f.maxAccounts)) : 0;
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      {/* Name, status and the one action always share the first line; chips wrap underneath. */}
      <div className="flex items-center gap-3">
        <span className={cx("size-2.5 flex-none rounded-full", online ? "bg-ok" : "bg-error")} />
        <span className="min-w-0 flex-1 truncate type-body-l">{s.hostname}</span>
        <span className="flex-none type-body-s text-on-surface-variant">{online ? "Online" : `Offline · ${timeAgo(s.lastSeen, now)}`}</span>
        <RemoveServerButton server={s} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-5.5">
        <Chip>{platformName(s.platform)}</Chip>
        {f?.draining && <Chip tone="tertiary">Draining</Chip>}
        {s.disk && s.disk.free < 2 * 1024 ** 3 && <Chip tone="error">Low disk · {(s.disk.free / 1024 ** 3).toFixed(1)} GB free</Chip>}
        {f && <Chip tone={f.localModel ? "success" : "neutral"} icon={f.localModel ? IconCpu : undefined}>{f.localModel ? "Local model" : "No local model"}</Chip>}
      </div>
      {f ? (
        <div className="flex flex-col gap-1.5 pl-5.5 sm:flex-row sm:items-center sm:gap-3">
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-highest sm:flex-1">
            <div className={cx("h-full rounded-full transition-[width] duration-500", pct >= 1 ? "bg-error" : pct > 0.75 ? "bg-tertiary" : "bg-primary")} style={{ width: `${pct * 100}%` }} />
          </div>
          <span className="type-body-s text-on-surface-variant tabular">
            {f.hosting} of {f.maxAccounts} WhatsApp sessions · installed {new Date(f.installedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
          </span>
        </div>
      ) : (
        <p className="type-body-s text-on-surface-variant">Older version: it doesn't report capacity yet. Update it to join the fleet.</p>
      )}
    </li>
  );
}

function AccountRow({ e, servers, now }: { e: AccessEntry; servers: ServerStatus[]; now: number }) {
  const lease = useLease(e.uid).data;
  const vault = useVault(e.uid).data;
  const pinned = usePrefs(e.uid).data?.pinned ?? null;
  const [busy, setBusy] = useState(false);
  const online = servers.filter((s) => serverOnline(s, now));
  const holder = lease?.server ?? null;
  const stale = lease ? leaseStale(lease, now) : false;

  const move = async (to: ServerStatus) => {
    setBusy(true);
    const t = toast.loading(`Moving ${e.name ?? e.email} to ${to.hostname}…`);
    try {
      await moveAccount(e.uid, to.id);
      toast.success(`${e.name ?? e.email} is now on ${to.hostname}`, { id: t });
    } catch (err) {
      toast.error((err as Error).message, { id: t });
    } finally {
      setBusy(false);
    }
  };
  const pin = (to: string | null) =>
    pinAccount(e.uid, to).then(
      () => toast.success(to ? `Pinned to ${serverName(servers, to)}` : "Unpinned"),
      (err) => toast.error((err as Error).message),
    );

  const where = !lease
    ? "Not started yet"
    : lease.state === "handing_off"
      ? `Moving off ${serverName(servers, holder)}${lease.moveTo ? ` to ${serverName(servers, lease.moveTo)}` : ""}…`
      : !holder || lease.state === "released"
        ? "Waiting for a server"
        : stale
          ? `${serverName(servers, holder)} stopped renewing ${timeAgo(lease.renewedAt, now)}`
          : `On ${serverName(servers, holder)}`;

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      {e.photo ? <img src={e.photo} alt="" referrerPolicy="no-referrer" className="size-9 rounded-full" /> : <Avatar name={e.name ?? e.email ?? "?"} size={36} />}
      <div className="min-w-0 flex-1">
        <div className="truncate type-body-l">{e.name ?? e.email}</div>
        <div className={cx("truncate type-body-s", stale ? "text-error" : "text-on-surface-variant")}>
          {where}
          {lease && lease.state === "running" && !stale && ` · renewed ${timeAgo(lease.renewedAt, now)}`}
          {lease?.reason && lease.state === "running" && ` · ${REASON[lease.reason]}`}
        </div>
        <div className="truncate type-body-s text-on-surface-variant">{vault ? `Login backed up ${timeAgo(vault.savedAt, now)} from ${serverName(servers, vault.server)}` : "No login backup yet"}</div>
      </div>
      {pinned && <Chip tone="primary">Pinned · {serverName(servers, pinned)}</Chip>}
      <Menu align="right" trigger={(t) => <IconButton icon={IconMenuDots} label={`Fleet actions for ${e.name ?? e.email}`} onClick={t} disabled={busy} className="size-9" />}>
        {(close) => (
          <>
            <div className="px-4 pt-1 pb-1 type-label-s text-on-surface-variant">Move to</div>
            {online.filter((s) => s.id !== holder).map((s) => (
              <MenuItem key={s.id} onClick={() => (close(), void move(s))} disabled={!holder || lease?.state !== "running" || s.fleet?.draining}>
                {s.hostname}
              </MenuItem>
            ))}
            {!online.some((s) => s.id !== holder) && <div className="px-4 py-2 type-body-s text-on-surface-variant">No other server is online.</div>}
            <div className="mt-1 border-t border-outline-variant/40 px-4 pt-2 pb-1 type-label-s text-on-surface-variant">Pin to this server</div>
            {online.map((s) => (
              <MenuItem key={s.id} highlighted={pinned === s.id} hint={pinned === s.id ? "Pinned" : undefined} onClick={() => (close(), void pin(s.id))}>
                {s.hostname}
              </MenuItem>
            ))}
            {pinned && <MenuItem onClick={() => (close(), void pin(null))}>Unpin</MenuItem>}
          </>
        )}
      </Menu>
    </li>
  );
}

export function FleetView({ servers }: { servers: ServerStatus[] | null }) {
  const now = useNow(5_000);
  const [accounts, setAccounts] = useState<AccessEntry[]>([]);
  useEffect(() => onSnapshot(collection(db, "access"), (q) => setAccounts(q.docs.map((d) => ({ ...(d.data() as AccessEntry), uid: d.id })).filter((a) => a.status === "approved"))), []);
  if (!servers?.length) return null;
  const sorted = [...servers].sort((a, b) => Number(serverOnline(b, now)) - Number(serverOnline(a, now)) || a.hostname.localeCompare(b.hostname));
  const onlineCount = sorted.filter((s) => serverOnline(s, now)).length;
  return (
    <Collapsible id="fleet" title="Fleet" icon={IconServer} summary={`${onlineCount} online`} summaryTone={onlineCount ? "success" : "error"}>
      <p className="px-4 pb-3 type-body-s text-on-surface-variant">Each WhatsApp account runs on one server and moves to another by itself if that one goes offline.</p>
      <CollapsibleBand id="fleet:servers" label="Servers" count={servers.length}>
        <ul className="divide-y divide-outline-variant/40">
          {sorted.map((s) => (
            <ServerRow key={s.id} s={s} now={now} />
          ))}
        </ul>
      </CollapsibleBand>
      <CollapsibleBand id="fleet:accounts" label="Accounts" count={accounts.length}>
        <ul className="divide-y divide-outline-variant/40">
          {accounts.map((a) => (
            <AccountRow key={a.uid} e={a} servers={servers} now={now} />
          ))}
          {!accounts.length && <li className="px-4 py-4 type-body-s text-on-surface-variant">No approved curators yet.</li>}
        </ul>
      </CollapsibleBand>
    </Collapsible>
  );
}
