// Server page → Curators: approve, remove and cap who can use this install.
import { useEffect, useState } from "react";
import { collection, deleteDoc, doc, onSnapshot, setDoc, updateDoc } from "firebase/firestore";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { TTL_DAYS, type AccessEntry, type Invite, type ServerStatus } from "@spot/shared";
import { useApp } from "../lib/app";
import { db } from "@spot/ui/firebase";
import { useAccessConfig } from "../lib/access";
import { expireAt, timeAgo } from "../lib/data";
import { Avatar, Button, Chip, CompactButton, IconButton, Stepper, TextInput } from "@spot/ui";
import { Collapsible, CollapsibleBand } from "@spot/ui";
import { Menu, MenuItem } from "@spot/ui";
import { DeleteDataDialog, RemoveUserDialog } from "./AdminDataTools";
import { IconArrowDown, IconCheck, IconClose, IconComics, IconMenuDots, IconUserPlus } from "@spot/ui";

const APP_URL = "https://spot-solutions.web.app";
const EMAIL = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;

/** Ready-to-send message for an invite. */
const inviteMessage = (email: string) =>
  `You're invited to Nothing BOT Curating, the comic lineup assistant.\n\nOpen ${APP_URL} and sign in with ${email}. Use that exact email: access is approved for you automatically, within a minute or two.\n\nThis invite works for ${TTL_DAYS.invites} days.`;

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Message copied");
  } catch {
    toast.error("Couldn't copy. Select the text and copy it by hand.");
  }
}

type InviteRow = Invite & { email: string };

/** Admin: invite an email address and get a message to send. */
function Invites() {
  const { user } = useApp();
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  useEffect(
    () =>
      onSnapshot(
        collection(db, "invites"),
        (q) => setInvites(q.docs.map((d) => ({ ...(d.data() as Invite), email: d.id })).filter((i) => (typeof (i.expireAt as { toMillis?: () => number })?.toMillis === "function" ? (i.expireAt as { toMillis: () => number }).toMillis() : 0) > Date.now())),
        () => setInvites([]),
      ),
    [],
  );

  const create = async () => {
    const addr = email.trim().toLowerCase();
    if (!EMAIL.test(addr)) return toast.error("Enter a full email address");
    setBusy(true);
    try {
      await deleteDoc(doc(db, "invites", addr)).catch(() => undefined); // start the 30 days again if it already exists
      await setDoc(doc(db, "invites", addr), { createdBy: (user.email ?? user.uid).toLowerCase(), createdAt: Date.now(), expireAt: expireAt(TTL_DAYS.invites) });
      setEmail("");
      setLast(addr);
      void copy(inviteMessage(addr));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 px-4 pb-4">
      <div className="flex flex-wrap items-center gap-2">
        <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} placeholder="Invite by email" aria-label="Email to invite" className="h-10 min-w-0 flex-1" />
        <Button size="sm" icon={IconUserPlus} loading={busy} disabled={!email.trim()} onClick={() => void create()}>
          Invite
        </Button>
      </div>
      <p className="type-body-s text-on-surface-variant">
        Creates an invite for {TTL_DAYS.invites} days and copies a message to send. When they sign in with that email, they are approved automatically, as long as there is room under the limit.
      </p>
      {last && (
        <textarea readOnly rows={5} value={inviteMessage(last)} onFocus={(e) => e.currentTarget.select()} className="w-full resize-none rounded-md border border-outline-variant bg-surface-container px-3 py-2 type-body-s outline-none" />
      )}
      {invites.length > 0 && (
        <div>
          <div className="-mx-4 bg-surface-container px-4 py-2 type-label-m text-on-surface-variant">Invited ({invites.length})</div>
          <ul className="-mx-4 divide-y divide-outline-variant/40">
            {invites.map((i) => (
              <li key={i.email} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate type-body-l">{i.email}</div>
                  <div className="truncate type-body-s text-on-surface-variant">
                    Invited {timeAgo(i.createdAt)} by {i.createdBy}
                  </div>
                </div>
                <Button size="sm" variant="text" onClick={() => void copy(inviteMessage(i.email))}>
                  Copy message
                </Button>
                <Button size="sm" variant="text" className="text-error" onClick={() => void deleteDoc(doc(db, "invites", i.email)).then(() => toast.success("Invite revoked"), (e) => toast.error((e as Error).message))}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function Curators({ servers }: { servers: ServerStatus[] | null }) {
  const { user } = useApp();
  const cfg = useAccessConfig();
  const [list, setList] = useState<AccessEntry[]>([]);
  const [deleting, setDeleting] = useState<AccessEntry | null>(null);
  const [removing, setRemoving] = useState<AccessEntry | null>(null);
  useEffect(() => onSnapshot(collection(db, "access"), (q) => setList(q.docs.map((d) => ({ ...(d.data() as AccessEntry), uid: d.id })))), []);

  const pending = list.filter((e) => e.status === "pending").sort((a, b) => a.requestedAt - b.requestedAt);
  const approved = list.filter((e) => e.status === "approved").sort((a, b) => (a.decidedAt ?? 0) - (b.decidedAt ?? 0));
  const removed = list.filter((e) => e.status === "removed");
  const max = cfg?.maxCurators ?? 6;
  const full = approved.length >= max;

  const decide = async (e: AccessEntry, status: AccessEntry["status"]) => {
    if (status === "approved" && full) return toast.error(`You're at the limit of ${max} curators. Raise it or remove someone first.`);
    if (status === "removed" && !confirm(`Remove ${e.name ?? e.email}? Their WhatsApp session on this server stops right away.`)) return;
    await updateDoc(doc(db, "access", e.uid), { status, decidedAt: Date.now(), decidedBy: user.email ?? user.uid });
    toast.success(status === "approved" ? `${e.name ?? e.email} can now use Nothing BOT Curating` : status === "removed" ? "Access removed" : "Moved back to pending");
  };

  const dataMenu = (e: AccessEntry, withRemove: boolean) => (
    <Menu align="right" trigger={(t) => <IconButton icon={IconMenuDots} label={`More for ${e.name ?? e.email}`} onClick={t} className="size-9" />}>
      {(close) => (
        <>
          <MenuItem onClick={() => (close(), setDeleting(e))}>Delete data…</MenuItem>
          {withRemove && <MenuItem onClick={() => (close(), setRemoving(e))}>Remove and delete everything…</MenuItem>}
        </>
      )}
    </Menu>
  );

  const Row = ({ e, children }: { e: AccessEntry; children: React.ReactNode }) => (
    <motion.li layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.12 } }} className="flex flex-wrap items-center gap-3 px-4 py-3">
      {e.photo ? <img src={e.photo} alt="" referrerPolicy="no-referrer" className="size-9 rounded-full" /> : <Avatar name={e.name ?? e.email ?? "?"} size={36} />}
      <div className="min-w-0 flex-1">
        <div className="truncate type-body-l">
          {e.name ?? "No name"}
          {cfg?.admins.includes(e.email ?? "") && <span className="ml-2 type-label-s text-primary">ADMIN</span>}
        </div>
        <div className="truncate type-body-s text-on-surface-variant">
          {e.email} · {e.status === "pending" ? `asked ${timeAgo(e.requestedAt)}` : `since ${timeAgo(e.decidedAt ?? e.requestedAt)}`}
        </div>
        {e.status === "pending" && e.note && <div className="type-body-s text-tertiary">{e.note}</div>}
      </div>
      <div className="flex gap-1.5">{children}</div>
    </motion.li>
  );

  return (
    <>
    <Collapsible id="curators" title="Curators" icon={IconComics} summary={pending.length ? `${pending.length} pending` : `${approved.length}/${max} in use`} summaryTone={pending.length ? "tertiary" : "neutral"}>
      <div className="flex flex-wrap items-center gap-3 px-4 pb-2">
        <p className="min-w-0 flex-1 type-body-s text-on-surface-variant">
          Invite-only: new sign-ins wait here unless you invited them. Each approved curator gets their own WhatsApp session on the server (about 300–400 MB of memory). {approved.length}/{max} in use.
        </p>
        <span className="type-body-s text-on-surface-variant">Limit</span>
        <Stepper value={max} min={1} max={100} onChange={(v) => void updateDoc(doc(db, "config", "access"), { maxCurators: v })} />
      </div>
      <Invites />

      {pending.length > 0 && (
        <>
          <div className="bg-primary-container/40 px-4 py-2 type-label-m text-on-surface">Waiting ({pending.length})</div>
          <ul className="divide-y divide-outline-variant/40">
            <AnimatePresence initial={false}>
              {pending.map((e) => (
                <Row key={e.uid} e={e}>
                  <CompactButton variant="text" icon={IconClose} label="Decline" onClick={() => void decide(e, "removed")} />
                  <CompactButton variant="filled" icon={IconCheck} label="Approve" onClick={() => void decide(e, "approved")} disabled={full} />
                </Row>
              ))}
            </AnimatePresence>
          </ul>
        </>
      )}

      <CollapsibleBand id="curators:approved" label="Approved" count={approved.length}>
        <ul className="divide-y divide-outline-variant/40">
          <AnimatePresence initial={false}>
            {approved.map((e) => (
              <Row key={e.uid} e={e}>
                {e.uid !== user.uid && (
                  <CompactButton variant="text" icon={IconClose} label="Remove" className="text-error" onClick={() => void decide(e, "removed")} />
                )}
                {dataMenu(e, e.uid !== user.uid && !cfg?.admins.includes(e.email ?? ""))}
              </Row>
            ))}
          </AnimatePresence>
        </ul>
      </CollapsibleBand>

      {removed.length > 0 && (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 bg-surface-container px-4 py-2 type-label-m text-on-surface-variant [&::-webkit-details-marker]:hidden">
            <IconArrowDown className="icon size-4 transition-transform duration-200 group-open:rotate-180" />
            Removed or declined ({removed.length})
          </summary>
          <ul className="divide-y divide-outline-variant/40">
            {removed.map((e) => (
              <Row key={e.uid} e={e}>
                <Chip>Removed</Chip>
                <Button size="sm" variant="text" onClick={() => void decide(e, "approved")} disabled={full}>
                  Restore
                </Button>
                {dataMenu(e, false)}
              </Row>
            ))}
          </ul>
        </details>
      )}
    </Collapsible>
    <DeleteDataDialog entry={deleting} servers={servers} onClose={() => setDeleting(null)} />
    <RemoveUserDialog entry={removing} servers={servers} onClose={() => setRemoving(null)} />
    </>
  );
}
