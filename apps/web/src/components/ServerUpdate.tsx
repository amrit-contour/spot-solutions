// Server page: this server's version against the latest release, and an Update button. The button sends the
// update_server command; the worker asks its console to run the platform's updater, then marks servers/{id}.update
// so every admin sees "Updating…" until the new version reports in.
import { useState } from "react";
import { addDoc, collection, onSnapshot } from "firebase/firestore";
import { toast } from "sonner";
import { TTL_DAYS, type ServerStatus } from "@spot/shared";
import { useApp } from "../lib/app";
import { db } from "@spot/ui/firebase";
import { expireAt } from "../lib/data";
import { isReleaseVersion, shortVersion, useLatestRelease } from "../lib/release";
import { Chip, CompactButton, Spinner } from "@spot/ui";
import { IconCheck, IconRefresh, IconWarn } from "@spot/ui";

const STALE_MS = 30 * 60_000;

export function ServerUpdate({ server: s, online, now }: { server: ServerStatus; online: boolean; now: number }) {
  const { user } = useApp();
  const latest = useLatestRelease();
  const [busy, setBusy] = useState(false);
  const u = s.update;
  const updating = u?.state === "updating" && s.version === u.from && now - u.startedAt < STALE_MS;
  const failed = u?.state === "error" && s.version === u.from;
  const known = isReleaseVersion(s.version);
  const available = Boolean(latest) && known && s.version !== latest!.version;

  const go = async () => {
    if (!confirm(`Update ${s.hostname} to ${shortVersion(latest?.version ?? "the latest version")}? The worker and console restart, and WhatsApp reconnects within about a minute.`)) return;
    setBusy(true);
    try {
      const ref = await addDoc(collection(db, "servers", s.id, "commands"), { type: "update_server", status: "pending", by: user.email ?? user.uid, createdAt: Date.now(), expireAt: expireAt(TTL_DAYS.commands) });
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => (unsub(), reject(new Error("The server didn't respond"))), 90_000);
        const unsub = onSnapshot(ref, (d) => {
          const st = d.data()?.status;
          if (st === "done") (clearTimeout(t), unsub(), resolve());
          if (st === "error") (clearTimeout(t), unsub(), reject(new Error(d.data()?.error ?? "Failed")));
        });
      });
      toast.success("Update started. This server restarts in a minute or two.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (updating) {
    return (
      <Chip tone="primary" icon={Spinner}>
        Updating…
      </Chip>
    );
  }
  return (
    <>
      {failed && (
        <span title={u?.error}>
          <Chip tone="error" icon={IconWarn}>
            Update didn't finish
          </Chip>
        </span>
      )}
      {!failed && latest && known && !available && (
        <Chip tone="success" icon={IconCheck}>
          Up to date
        </Chip>
      )}
      {(available || failed) && latest && (
        <CompactButton icon={IconRefresh} label={failed ? "Try again" : `Update to ${shortVersion(latest.version)}`} loading={busy} disabled={!online} onClick={() => void go()} title={online ? undefined : "The server is offline"} />
      )}
    </>
  );
}
