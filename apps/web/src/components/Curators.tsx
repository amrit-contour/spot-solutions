// Server page → Curators: approve, remove and cap who can use this install.
import { useEffect, useState } from "react";
import { collection, doc, onSnapshot, updateDoc } from "firebase/firestore";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import type { AccessEntry } from "@spot/shared";
import { useApp } from "../lib/app";
import { db } from "../lib/firebase";
import { useAccessConfig } from "../lib/access";
import { timeAgo } from "../lib/data";
import { Avatar, Button, Card, Chip, Stepper } from "./ui";
import { IconArrowDown, IconCheck, IconClose, IconComics } from "./icons";

export function Curators() {
  const { user } = useApp();
  const cfg = useAccessConfig();
  const [list, setList] = useState<AccessEntry[]>([]);
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
    toast.success(status === "approved" ? `${e.name ?? e.email} can now use Spot Solutions` : status === "removed" ? "Access removed" : "Moved back to pending");
  };

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
      </div>
      <div className="flex gap-1.5">{children}</div>
    </motion.li>
  );

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-4 pt-4 pb-2">
        <IconComics className="icon size-5 text-primary" />
        <h3 className="flex-1 type-title-s">Curators</h3>
        <span className="type-body-s text-on-surface-variant">Limit</span>
        <Stepper value={max} min={1} max={100} onChange={(v) => void updateDoc(doc(db, "config", "access"), { maxCurators: v })} />
      </div>
      <p className="px-4 pb-3 type-body-s text-on-surface-variant">
        Invite-only: new sign-ins wait here. Each approved curator gets their own WhatsApp session on the server (about 300–400 MB of memory). {approved.length}/{max} in use.
      </p>

      {pending.length > 0 && (
        <>
          <div className="bg-primary-container/40 px-4 py-2 type-label-m text-on-surface">Waiting ({pending.length})</div>
          <ul className="divide-y divide-outline-variant/40">
            <AnimatePresence initial={false}>
              {pending.map((e) => (
                <Row key={e.uid} e={e}>
                  <Button size="sm" variant="text" onClick={() => void decide(e, "removed")}>
                    Decline
                  </Button>
                  <Button size="sm" icon={IconCheck} onClick={() => void decide(e, "approved")} disabled={full}>
                    Approve
                  </Button>
                </Row>
              ))}
            </AnimatePresence>
          </ul>
        </>
      )}

      <div className="bg-surface-container px-4 py-2 type-label-m text-on-surface-variant">Approved ({approved.length})</div>
      <ul className="divide-y divide-outline-variant/40">
        <AnimatePresence initial={false}>
          {approved.map((e) => (
            <Row key={e.uid} e={e}>
              {e.uid !== user.uid && (
                <Button size="sm" variant="text" icon={IconClose} className="text-error" onClick={() => void decide(e, "removed")}>
                  Remove
                </Button>
              )}
            </Row>
          ))}
        </AnimatePresence>
      </ul>

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
              </Row>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
