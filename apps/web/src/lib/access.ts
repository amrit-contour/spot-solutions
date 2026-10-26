import { useEffect, useState } from "react";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import type { User } from "firebase/auth";
import type { AccessConfig, AccessEntry } from "@spot/shared";
import { db } from "@spot/ui/firebase";

/** This user's access record; asks for access (status "pending") on first sign-in. */
export function useAccess(user: User | null | undefined) {
  const [entry, setEntry] = useState<AccessEntry | null | undefined>(undefined);
  useEffect(() => {
    if (!user) return setEntry(undefined);
    // Demo visitors explore their own sandbox; they never join the approval queue or the server.
    if (user.isAnonymous) return setEntry({ uid: user.uid, email: null, name: "Demo visitor", status: "approved", requestedAt: Date.now() });
    const ref = doc(db, "access", user.uid);
    return onSnapshot(
      ref,
      (s) => {
        if (s.exists()) return setEntry(s.data() as AccessEntry);
        const req: AccessEntry = { uid: user.uid, email: user.email?.toLowerCase() ?? null, name: user.displayName, photo: user.photoURL, status: "pending", requestedAt: Date.now() };
        void setDoc(ref, req);
      },
      () => setEntry(null),
    );
  }, [user]);
  return entry;
}

export function useAccessConfig() {
  const [cfg, setCfg] = useState<AccessConfig | null>(null);
  useEffect(() => onSnapshot(doc(db, "config", "access"), (s) => setCfg((s.data() as AccessConfig) ?? null), () => setCfg(null)), []);
  return cfg;
}

export const isAdmin = (cfg: AccessConfig | null, email?: string | null) => Boolean(cfg && email && cfg.admins.includes(email.toLowerCase()));
