// Server page (admins): remove a server and, when Nothing BOT Curating made its key, revoke it. Lingering old or offline servers go here.
import { useState } from "react";
import { toast } from "sonner";
import type { ServerStatus } from "@spot/shared";
import { useApp } from "../lib/app";
import { isAdmin, useAccessConfig } from "../lib/access";
import { isDemoUser } from "../lib/demo";
import { isPrecondition, joinError, removeServer } from "../lib/joinServer";
import { ConfirmDialog } from "@spot/ui";
import { CompactButton } from "@spot/ui";
import { IconTrash } from "@spot/ui";

export function RemoveServerButton({ server }: { server: Pick<ServerStatus, "id" | "hostname"> }) {
  const { user } = useApp();
  const admin = isAdmin(useAccessConfig(), user.email);
  const [open, setOpen] = useState(false);
  // Set when the server is online and holds accounts: the second dialog explains and asks again.
  const [holds, setHolds] = useState<string | null>(null);
  if (!admin || isDemoUser()) return null;

  const run = async (force: boolean) => {
    try {
      const r = await removeServer(server.id, force);
      toast.success(
        r.keyNotRevoked
          ? `Removed ${server.hostname}. Its key wasn't created by Nothing BOT Curating, so it isn't revoked. Delete it in Google Cloud if the computer is gone.`
          : `Removed ${server.hostname} and revoked its key.`,
      );
    } catch (e) {
      if (!force && isPrecondition(e)) return setHolds(joinError(e));
      throw new Error(joinError(e));
    }
  };

  return (
    <>
      <CompactButton variant="danger" icon={IconTrash} label="Remove server" onClick={() => setOpen(true)} />
      <ConfirmDialog open={open} onClose={() => setOpen(false)} title={`Remove ${server.hostname}?`} confirmLabel="Remove server" onConfirm={() => run(false)}>
        <p>This takes the server off the list. If Nothing BOT Curating made its key (from a join code), the key and its Google Cloud account are deleted, so the computer can no longer reach your data.</p>
        <p>Servers set up with the project's default key (older installs) are only removed from the list. Their key is not revoked.</p>
        <p>The computer itself keeps running until its access runs out, up to an hour. Uninstall Nothing BOT Server there too.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={holds !== null}
        onClose={() => setHolds(null)}
        title="This server is in use"
        confirmLabel="Remove anyway"
        ack="I understand WhatsApp pauses for a few minutes while another server takes over."
        onConfirm={() => run(true)}
      >
        <p>{holds}</p>
        <p>Forcing it cuts the key now. Until its access runs out (up to an hour) it may still answer chats, and another server starts the same accounts after about 150 seconds. For a clean handover, move the accounts first under Fleet, then remove it.</p>
      </ConfirmDialog>
    </>
  );
}
