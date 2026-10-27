import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { filterMembers } from "@spot/shared";
import { Button, Chip, Empty, IconButton, TextInput } from "../ui";
import { ConfirmDialog } from "../ConfirmDialog";
import { Menu, MenuItem } from "../Menu";
import { IconArrowDown, IconCheck, IconClose, IconComics, IconMenuDots, IconSearch, IconShield } from "../icons";
import { decideAccess, setAdminRole, callError, type AccessRecord, type Activity } from "./api";
import { AppChips, Group, Note, Person, Rows, ago, displayName } from "./parts";

export interface AdminCtx {
  me: { uid: string; email: string };
  records: AccessRecord[];
  admins: string[];
  activity: Record<string, Activity> | null;
}

const lower = (e?: string | null) => (e ?? "").toLowerCase();
const row = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0, transition: { duration: 0.12 } } };

/**
 * Members: who asked to join (approve / decline), who is in (search, which app they use, last seen, make admin, remove)
 * and who was removed (restore). `approveLimit` is Curating's cap on approved people: each one gets a WhatsApp session on the server.
 */
export function MembersPanel({ ctx, approveLimit }: { ctx: AdminCtx; approveLimit?: number }) {
  const { me, records, admins, activity } = ctx;
  const [query, setQuery] = useState("");
  const [removing, setRemoving] = useState<AccessRecord | null>(null);
  const [promoting, setPromoting] = useState<AccessRecord | null>(null);

  const pending = records.filter((r) => r.status === "pending").sort((a, b) => a.requestedAt - b.requestedAt);
  const approved = records.filter((r) => r.status === "approved");
  const removed = records.filter((r) => r.status === "removed").sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
  const shown = useMemo(() => filterMembers(approved.map((r) => ({ ...r, name: displayName(r), email: r.email ?? "" })), query), [approved, query]);
  const isAdmin = (r: AccessRecord) => admins.includes(lower(r.email));
  const full = approveLimit != null && approved.length >= approveLimit;

  const decide = async (r: AccessRecord, status: AccessRecord["status"], done: string) => {
    if (status === "approved" && full) return toast.error(`You're at the limit of ${approveLimit} curators. Raise the limit or remove someone first.`);
    try {
      await decideAccess(r.uid, status, me.email);
      toast.success(done);
    } catch (e) {
      toast.error(callError(e, "Couldn't save that. Check your connection and try again."));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {pending.length > 0 && (
        <Group tone="attention" title="Waiting for approval" count={pending.length}>
          <Rows>
            <AnimatePresence initial={false}>
              {pending.map((r) => (
                <motion.li key={r.uid} layout="position" {...row} className="flex flex-col gap-3 px-4 py-3">
                  <Person name={displayName(r)} email={r.email} photo={r.photo} meta={<span>Asked {ago(r.requestedAt)}</span>} />
                  {r.note && <p className="rounded-md bg-tertiary-container px-3 py-2 type-body-s text-on-tertiary-container">{r.note}</p>}
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="text" icon={IconClose} onClick={() => void decide(r, "removed", "Request declined")}>
                      Decline
                    </Button>
                    <Button size="sm" icon={IconCheck} disabled={full} onClick={() => void decide(r, "approved", `${displayName(r)} is in`)}>
                      Approve
                    </Button>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </Rows>
        </Group>
      )}

      <Group title="Members" count={approved.length} hint={approveLimit != null ? `${approved.length} of ${approveLimit} places in use. Each member gets their own WhatsApp session on the server.` : undefined}>
        {approved.length > 4 && (
          <div className="relative border-b border-outline-variant/40 p-3">
            <IconSearch aria-hidden className="icon pointer-events-none absolute top-1/2 left-7 size-5 -translate-y-1/2 text-on-surface-variant" />
            <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or email" aria-label="Search members" autoComplete="off" spellCheck={false} className="h-11 pl-11" />
          </div>
        )}
        {approved.length === 0 ? (
          <Empty icon={IconComics} title="No members yet">People who sign in appear under Waiting for approval first.</Empty>
        ) : shown.length === 0 ? (
          <p className="px-4 py-6 text-center type-body-m text-on-surface-variant">No one matches “{query.trim()}”.</p>
        ) : (
          <Rows>
            <AnimatePresence initial={false}>
              {shown.map((m) => {
                const r = approved.find((x) => x.uid === m.uid)!;
                const admin = isAdmin(r);
                const you = r.uid === me.uid;
                const a = activity?.[r.uid];
                return (
                  <motion.li key={r.uid} layout="position" {...row} className="flex min-h-[4.5rem] items-center gap-2 py-3 pr-2 pl-4">
                    <Person
                      name={displayName(r)}
                      email={r.email}
                      photo={r.photo}
                      badges={
                        <>
                          {admin && <Chip tone="primary" icon={IconShield} className="h-6 px-2">Admin</Chip>}
                          {you && <span className="flex-none type-label-s text-on-surface-variant">You</span>}
                        </>
                      }
                      meta={
                        <>
                          <AppChips activity={a} />
                          {a?.lastSeen != null && <span>Seen {ago(a.lastSeen)}</span>}
                        </>
                      }
                    />
                    <Menu align="right" trigger={(t) => <IconButton icon={IconMenuDots} label={`Actions for ${displayName(r)}`} onClick={t} />}>
                      {(close) => (
                        <>
                          {!admin && (
                            <MenuItem onClick={() => (close(), setPromoting(r))}>Make admin…</MenuItem>
                          )}
                          {admin ? (
                            <p className="max-w-56 px-4 py-3 type-body-s text-on-surface-variant">Admins can't be removed here. Take away their admin role first.</p>
                          ) : (
                            !you && <MenuItem onClick={() => (close(), setRemoving(r))}>Remove access…</MenuItem>
                          )}
                        </>
                      )}
                    </Menu>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </Rows>
        )}
      </Group>

      {removed.length > 0 && (
        <details className="group/removed">
          <summary className="state-layer flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-1 type-title-s text-on-surface [&::-webkit-details-marker]:hidden">
            Removed or declined
            <span className="type-label-m text-on-surface-variant tabular">{removed.length}</span>
            <IconArrowDown aria-hidden className="icon ml-auto mr-1 size-5 text-on-surface-variant transition-transform duration-200 group-open/removed:rotate-180" />
          </summary>
          <div className="mt-2 overflow-hidden rounded-lg bg-surface-low">
            <Rows>
              {removed.map((r) => (
                <li key={r.uid} className="flex min-h-[4.5rem] items-center gap-2 py-3 pr-3 pl-4">
                  <Person name={displayName(r)} email={r.email} photo={r.photo} meta={<span>{r.decidedAt ? `Decided ${ago(r.decidedAt)}` : "Declined"}</span>} />
                  <Button size="sm" variant="tonal" disabled={full} onClick={() => void decide(r, "approved", `${displayName(r)} restored`)}>
                    Restore
                  </Button>
                </li>
              ))}
            </Rows>
          </div>
        </details>
      )}
      {full && <Note>You're at the limit of {approveLimit} members, so new requests can't be approved until you raise it or remove someone.</Note>}

      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing ? displayName(removing) : ""}?`}
        confirmLabel="Remove access"
        onConfirm={async () => {
          if (!removing) return;
          await decideAccess(removing.uid, "removed", me.email);
          toast.success("Access removed");
        }}
      >
        <p>They lose access to Curating and Comedy right away, and any WhatsApp session of theirs on the server stops.</p>
        <p>Their data stays where it is. You can restore them from the Removed list.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(promoting)}
        tone="primary"
        onClose={() => setPromoting(null)}
        title={`Make ${promoting ? displayName(promoting) : ""} an admin?`}
        confirmLabel="Make admin"
        onConfirm={async () => {
          if (!promoting?.email) return;
          try {
            await setAdminRole(promoting.email, true);
          } catch (e) {
            throw new Error(callError(e, "Couldn't make them an admin. Try again."));
          }
          toast.success(`${displayName(promoting)} is now an admin`);
        }}
      >
        <p>Admins approve and remove members, add other admins and run the data tools, in both apps.</p>
      </ConfirmDialog>
    </div>
  );
}
