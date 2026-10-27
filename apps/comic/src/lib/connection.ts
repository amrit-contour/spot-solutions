// The shared WhatsApp link and server, as Nothing BOT Comedy shows it. Same Firestore docs as Nothing BOT Curate: the signed-in uid
// is the same account, so there is nothing to set up here. All of it is read-only; linking and servers live in Curate.
import { useEffect, useState } from "react";
import { collection, doc, onSnapshot } from "firebase/firestore";
import { db } from "@spot/ui/firebase";
import type { AccountStatus } from "@spot/ui";
import { isServerUp, linkView, maskPhoneTail, serverLastSeen, type FleetServerSummary, type Lease, type LinkView, type SessionState } from "@spot/shared";
import { useClock } from "./alerts";

/** Where linking, relinking, choosing a server and installing one happen. */
export const CURATING_URL = "https://nothingbotcurate.web.app";
export const CURATING_WHATSAPP = `${CURATING_URL}/settings#whatsapp`;
export const CURATING_AGENT = `${CURATING_URL}/settings#agent`;
export const CURATING_SERVER = `${CURATING_URL}/server`;

function useLiveDoc<T>(path: string) {
  const [state, setState] = useState<{ data: T | null; loading: boolean }>({ data: null, loading: true });
  useEffect(
    () =>
      onSnapshot(
        doc(db, path),
        (s) => setState({ data: (s.data() as T | undefined) ?? null, loading: false }),
        () => setState({ data: null, loading: false }),
      ),
    [path],
  );
  return state;
}

export interface Connection {
  loading: boolean;
  whatsapp: LinkView;
  agent: LinkView;
  /** Server holding the account: its hostname when readable, else the id, else null. */
  serverName: string | null;
  serverUp: boolean;
  lastSeen: number | null;
  phone: string | null;
  pushName: string | null;
  agentPhone: string | null;
  /** Something the comic should know about up front: the server is off, WhatsApp isn't linked, or it needs a QR scan. */
  problem: "offline" | "unlinked" | "qr" | "unresponsive" | null;
  /** Why WhatsApp stopped answering (from the server), when it did. */
  healthNote: string | null;
}

/** users/{uid}/session/state, session/agent and fleet/lease, plus fleetServers for the server's name. */
export function useConnection(uid: string): Connection {
  const session = useLiveDoc<SessionState>(`users/${uid}/session/state`);
  const agent = useLiveDoc<SessionState>(`users/${uid}/session/agent`);
  const lease = useLiveDoc<Lease>(`users/${uid}/fleet/lease`);
  const [servers, setServers] = useState<FleetServerSummary[]>([]);
  const now = useClock(15_000);
  // Only the name of the server that holds the account is needed; fleetServers is readable by approved accounts only, so a failure just means "show the id".
  useEffect(() => onSnapshot(collection(db, "fleetServers"), (q) => setServers(q.docs.map((d) => ({ ...(d.data() as FleetServerSummary), id: d.id }))), () => setServers([])), []);

  const serverUp = isServerUp(session.data, now);
  const whatsapp = linkView(session.data, serverUp);
  const id = lease.data?.server ?? null;
  const serverName = id ? servers.find((s) => s.id === id)?.hostname ?? id : null;
  const loading = session.loading || lease.loading;
  const problem = loading ? null : !serverUp ? "offline" : whatsapp === "qr" ? "qr" : whatsapp === "unresponsive" ? "unresponsive" : whatsapp === "unlinked" ? "unlinked" : null;
  return {
    loading,
    whatsapp,
    agent: linkView(agent.data, serverUp),
    serverName,
    serverUp,
    lastSeen: serverLastSeen(session.data),
    phone: session.data?.phone ?? null,
    pushName: session.data?.pushName ?? null,
    agentPhone: agent.data?.phone ?? null,
    problem,
    healthNote: session.data?.health && session.data.health !== "ok" ? session.data.error ?? null : null,
  };
}

/** The account button's dot and menu row: the same states ConnectionCard words out. Not responding and needs-a-scan are amber, server off is red. */
export function connectionStatus(c: Connection): AccountStatus | undefined {
  if (c.loading) return undefined;
  const to = "/settings";
  const linkLabel = "Connection";
  const phone = c.phone ? maskPhoneTail(c.phone) : undefined;
  if (!c.serverUp && c.whatsapp !== "connected") return { tone: "error", label: "Server offline", to, linkLabel };
  if (!c.serverUp) return { tone: "error", label: "Server offline", detail: phone, to, linkLabel };
  switch (c.whatsapp) {
    case "connected": return { tone: "ok", label: "WhatsApp connected", detail: phone, to, linkLabel };
    case "unresponsive": return { tone: "wait", label: "WhatsApp not responding", to, linkLabel };
    case "qr": return { tone: "wait", label: "WhatsApp needs a scan", to, linkLabel };
    case "starting": return { tone: "wait", label: "Starting WhatsApp…", to, linkLabel };
    default: return { tone: "idle", label: "WhatsApp not linked", to, linkLabel };
  }
}
