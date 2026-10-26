// Server page (admins): make a join code for a new server. The server's console trades it for its own key (docs/multi-server.md).
import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { useApp } from "../lib/app";
import { isAdmin, useAccessConfig } from "../lib/access";
import { useNow } from "../lib/data";
import { isDemoUser } from "../lib/demo";
import { useAllServers } from "../lib/fleet";
import { createJoinCode, joinError, type JoinCode } from "../lib/joinServer";
import { Button, Card, Chip, CompactButton, TextInput } from "./ui";
import { IconAdd, IconCheck, IconServer } from "./icons";

const fmtLeft = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

export function AddServerCard() {
  const { user } = useApp();
  const admin = isAdmin(useAccessConfig(), user.email);
  const servers = useAllServers();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [join, setJoin] = useState<JoinCode | null>(null);
  const now = useNow(1_000);
  // Servers that existed when the code was made: a new id after that means the code was used.
  const before = useRef<Set<string> | null>(null);
  const [joined, setJoined] = useState<string | null>(null);

  useEffect(() => {
    if (!join || !servers || !before.current) return;
    const fresh = servers.find((s) => !before.current!.has(s.id));
    if (fresh) setJoined(fresh.hostname ?? fresh.id);
  }, [join, servers]);

  if (!admin || isDemoUser()) return null;

  const make = async () => {
    setBusy(true);
    try {
      before.current = new Set((servers ?? []).map((s) => s.id));
      setJoined(null);
      setJoin(await createJoinCode(name.trim() || undefined));
    } catch (e) {
      toast.error(joinError(e));
    } finally {
      setBusy(false);
    }
  };
  const copy = () =>
    navigator.clipboard.writeText(join!.code).then(
      () => toast.success("Code copied"),
      () => toast.error("Couldn't copy. Select the code and copy it."),
    );
  const left = join ? join.expiresAt - now : 0;
  const expired = Boolean(join) && left <= 0;
  const close = () => {
    setOpen(false);
    setJoin(null);
    setJoined(null);
  };

  return (
    <Card className="p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-10 flex-none place-items-center rounded-md bg-secondary-container text-on-secondary-container">
          <IconServer className="icon size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="type-title-m">Add a server</h2>
          <p className="type-body-s text-on-surface-variant">Make a code, then enter it in the server console on the new computer. It gets its own key; nothing to copy around.</p>
        </div>
        {!open && (
          <CompactButton variant="filled" size="md" icon={IconAdd} label="Add a server" onClick={() => setOpen(true)} />
        )}
      </div>

      {open && !join && (
        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="type-label-l text-on-surface-variant">Name for this server (optional)</span>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Studio Mac" maxLength={40} />
            <span className="type-body-s text-on-surface-variant">You can change it in the console. It labels the key in Google Cloud.</span>
          </label>
          <div className="flex gap-2">
            <Button loading={busy} onClick={() => void make()}>
              Make a code
            </Button>
            <Button variant="text" onClick={close} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {join && (
        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex flex-col gap-3">
            <div className={expired ? "opacity-40" : ""} aria-live="polite">
              <div className="select-all font-mono text-4xl font-semibold tracking-widest sm:text-5xl">{join.code}</div>
            </div>
            {joined ? (
              <Chip tone="success" icon={IconCheck}>
                {joined} joined
              </Chip>
            ) : expired ? (
              <Chip tone="error">Expired</Chip>
            ) : (
              <Chip tone="primary">Valid for {fmtLeft(left)}, works once</Chip>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="tonal" onClick={() => void copy()} disabled={expired}>
                Copy code
              </Button>
              {(expired || joined) && (
                <Button variant="outlined" loading={busy} onClick={() => void make()}>
                  Make another code
                </Button>
              )}
              <Button variant="text" onClick={close}>
                Done
              </Button>
            </div>
            <ol className="list-decimal pl-5 type-body-s text-on-surface-variant">
              <li>On the new computer, open the server console (Mac: inside Nothing BOT Server. Windows: the Nothing BOT Server Console shortcut. Ubuntu: run sudo spot-console-url).</li>
              <li>Type the code under Enter join code and click Join.</li>
              <li>The server appears here within a minute.</li>
            </ol>
          </div>
          {!expired && !joined && (
            <div className="flex-none self-start rounded-md bg-surface-container p-3" aria-label="QR code of the join code">
              <QRCodeSVG value={join.code} size={132} bgColor="transparent" fgColor="var(--md-sys-color-on-surface)" level="M" />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
