import { useEffect, useState } from "react";
import { collection, doc, limit, onSnapshot, query } from "firebase/firestore";
import { agentScope, type AgentScope, type ScopeFacts } from "@spot/shared";
import { db } from "./firebase";

/** Which apps this account uses (the same rule the agent number applies), live. Both apps' agent help reads it. */
export function useAgentScope(uid: string): AgentScope {
  const [f, setF] = useState<ScopeFacts>({});
  useEffect(() => {
    const set = (patch: ScopeFacts) => setF((p) => ({ ...p, ...patch }));
    const nop = () => undefined;
    const subs = [
      onSnapshot(query(collection(db, "users", uid, "shows"), limit(1)), (s) => set({ shows: !s.empty }), nop),
      onSnapshot(query(collection(db, "users", uid, "venues"), limit(1)), (s) => set({ venues: !s.empty }), nop),
      onSnapshot(query(collection(db, "users", uid, "lineups"), limit(1)), (s) => set({ lineups: !s.empty }), nop),
      onSnapshot(query(collection(db, "users", uid, "rooms"), limit(1)), (s) => set({ rooms: !s.empty }), nop),
      onSnapshot(doc(db, "users", uid), (s) => set({ comicSettings: s.data()?.comicSettings != null }), nop),
    ];
    return () => subs.forEach((u) => u());
  }, [uid]);
  return agentScope(f);
}
