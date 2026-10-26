// Admin data tools: write a command to servers/{id}/commands and wait for the worker's result.
import { addDoc, collection, onSnapshot } from "firebase/firestore";
import { TTL_DAYS, type AdminDataPayload, type AdminDataResult, type ServerCommand, type ServerStatus } from "@spot/shared";
import { db } from "@spot/ui/firebase";
import { expireAt } from "./data";

const ONLINE_MS = 90_000;

/** The server hosting this curator's session, else any online one. Null when none is online. */
export function pickServer(servers: ServerStatus[] | null, uid?: string) {
  const online = (servers ?? []).filter((s) => Date.now() - s.lastSeen < ONLINE_MS);
  return (uid && online.find((s) => s.sessions.some((x) => x.uid === uid))) || online[0] || null;
}

export async function runAdminData(serverId: string, type: "delete_user_data" | "remove_user" | "wipe_demo", payload: AdminDataPayload, by: string, timeoutMs = 10 * 60_000) {
  const ref = await addDoc(collection(db, "servers", serverId, "commands"), { type, payload: { ...payload }, status: "pending", by, createdAt: Date.now(), expireAt: expireAt(TTL_DAYS.commands) } satisfies ServerCommand);
  return new Promise<AdminDataResult>((resolve, reject) => {
    const t = setTimeout(() => (unsub(), reject(new Error("The server didn't respond"))), timeoutMs);
    const unsub = onSnapshot(ref, (d) => {
      const c = d.data() as ServerCommand | undefined;
      if (c?.status === "done") (clearTimeout(t), unsub(), resolve(c.result as AdminDataResult));
      if (c?.status === "error") (clearTimeout(t), unsub(), reject(new Error(c.error ?? "Failed")));
    });
  });
}
