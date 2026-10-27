import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import type { ServerStatus } from "@spot/shared";
import { db } from "@spot/ui/firebase";
import { useApp } from "./app";

/** Servers that list this user's email as an admin. */
export function useServers() {
  const { user } = useApp();
  const [servers, setServers] = useState<ServerStatus[] | null>(null);
  const email = user.email?.toLowerCase();
  useEffect(() => {
    if (!email) return setServers([]);
    return onSnapshot(
      query(collection(db, "servers"), where("admins", "array-contains", email)),
      (q) => setServers(q.docs.map((d) => d.data() as ServerStatus)),
      () => setServers([]),
    );
  }, [email]);
  return servers;
}
