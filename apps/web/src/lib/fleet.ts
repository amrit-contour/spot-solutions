// The server fleet as the app sees it (docs/fleet.md): which server holds an account, the login backup, pins, moves.
import { useEffect, useState } from "react";
import { collection, doc, onSnapshot, setDoc } from "firebase/firestore";
import { LEASE_EXPIRE_MS, SERVER_ONLINE_MS, type FleetPrefs, type Lease, type FleetServerSummary, type VaultMeta } from "@spot/shared";
import { db } from "@spot/ui/firebase";
import { runCommand, useDocument } from "./data";
import { isDemoUser } from "./demo";

const fleetPath = (uid: string, name: string) => ["users", uid, "fleet", name];

export const useLease = (uid: string) => useDocument<Lease>(fleetPath(uid, "lease"));
export const useVault = (uid: string) => useDocument<VaultMeta>(fleetPath(uid, "vault"));
export const usePrefs = (uid: string) => useDocument<FleetPrefs>(fleetPath(uid, "prefs"));

/** Public per-server summary (no logs, no admin emails) that any approved curator may read: fleetServers/{id}. */
export function useAllServers() {
  const [servers, setServers] = useState<FleetServerSummary[] | null>(null);
  useEffect(
    () =>
      onSnapshot(
        collection(db, "fleetServers"),
        (q) => setServers(q.docs.map((d) => ({ ...(d.data() as FleetServerSummary), id: d.id }))),
        () => setServers([]),
      ),
    [],
  );
  return servers;
}

export const serverOnline = (s: { lastSeen: number }, now: number) => now - s.lastSeen < SERVER_ONLINE_MS;

export const platformName = (p: string) => ({ darwin: "macOS", win32: "Windows", linux: "Linux" })[p] ?? p;

/** "Mac mini" reads better than an id, but the hostname is what the owner knows the machine as. */
export const serverName = (servers: { id: string; hostname: string }[] | null, id: string | null | undefined) => (id ? servers?.find((s) => s.id === id)?.hostname ?? id : "no server");

/** A lease nobody has renewed for a while: the holder is gone and another server is about to take over. */
export const leaseStale = (l: Lease, now: number) => l.state === "running" && now - l.renewedAt > LEASE_EXPIRE_MS;

export const REASON: Record<NonNullable<Lease["reason"]>, string> = {
  failover: "took over after a server went offline",
  move: "moved on request",
  rebalance: "moved to even out the load",
  first_start: "first start",
};

/** Ask the server holding this account to hand it to another one. Resolves when the new server has it. */
export async function moveAccount(uid: string, to: string) {
  await runCommand(uid, "move_account", { to }, 5 * 60_000);
}

/** Keep an account on one server whenever it is online; null clears it. */
export async function pinAccount(uid: string, pinned: string | null) {
  if (isDemoUser()) throw new Error("Servers aren't part of the demo.");
  await setDoc(doc(db, "users", uid, "fleet", "prefs"), { pinned } satisfies FleetPrefs);
}
