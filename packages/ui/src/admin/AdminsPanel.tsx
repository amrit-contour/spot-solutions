import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button, Chip } from "../ui";
import { ConfirmDialog } from "../ConfirmDialog";
import { IconShield } from "../icons";
import { callError, setAdminRole, type AccessRecord } from "./api";
import { Group, Note, Person, Rows, displayName } from "./parts";
import { CandidateList } from "./CandidateList";
import type { AdminCtx } from "./MembersPanel";

const lower = (e?: string | null) => (e ?? "").toLowerCase();

/** Admins: who they are, add one from the approved members, remove one. The server never lets the last admin go. */
export function AdminsPanel({ ctx }: { ctx: AdminCtx }) {
  const { me, records, admins } = ctx;
  const [adding, setAdding] = useState<AccessRecord | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const byEmail = useMemo(() => new Map(records.filter((r) => r.email).map((r) => [lower(r.email), r])), [records]);
  const onlyOne = admins.length <= 1;
  const meEmail = lower(me.email);

  const removeTarget = removing ? byEmail.get(removing) : undefined;
  const removeName = removing ? (removeTarget ? displayName(removeTarget) : removing) : "";

  return (
    <div className="flex flex-col gap-6">
      <Group title="Admins" count={admins.length} hint="Admins decide who gets in, add other admins and run the data tools. They work the same in Curate and Comedy.">
        <Rows>
          {admins.map((email) => {
            const r = byEmail.get(email);
            const you = email === meEmail;
            return (
              <li key={email} className="flex min-h-[4.5rem] items-center gap-3 py-3 pr-3 pl-4">
                <Person name={r ? displayName(r) : email} email={r ? email : undefined} photo={r?.photo} badges={you ? <span className="flex-none type-label-s text-on-surface-variant">You</span> : undefined} meta={r ? undefined : <span>Hasn't signed in yet</span>} />
                <Button size="sm" variant="text" className="text-error" disabled={onlyOne} title={onlyOne ? "Add another admin first" : undefined} onClick={() => setRemoving(email)}>
                  {you ? "Step down" : "Remove"}
                </Button>
              </li>
            );
          })}
        </Rows>
      </Group>
      {onlyOne && <Note>You're the only admin. Add a second one so the apps are never left without one; the last admin can't be removed.</Note>}

      <Group title="Add an admin" hint="Pick from approved members. Someone who hasn't been approved yet needs approving first, under Members.">
        <CandidateList records={records} excludeEmails={admins} actionLabel="Make admin" icon={IconShield} onPick={setAdding} empty="Every approved member is already an admin." />
      </Group>

      <ConfirmDialog
        open={Boolean(adding)}
        tone="primary"
        onClose={() => setAdding(null)}
        title={`Make ${adding ? displayName(adding) : ""} an admin?`}
        confirmLabel="Make admin"
        onConfirm={async () => {
          if (!adding?.email) return;
          try {
            await setAdminRole(adding.email, true);
          } catch (e) {
            throw new Error(callError(e, "Couldn't make them an admin. Try again."));
          }
          toast.success(`${displayName(adding)} is now an admin`);
        }}
      >
        <p>They will be able to approve and remove members, add other admins and run the data tools, in both apps.</p>
        <Chip tone="neutral" className="self-start">{adding?.email}</Chip>
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title={removing === meEmail ? "Step down as admin?" : `Remove ${removeName} as admin?`}
        confirmLabel={removing === meEmail ? "Step down" : "Remove admin"}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await setAdminRole(removing, false);
          } catch (e) {
            throw new Error(callError(e, "Couldn't change the admins. Try again."));
          }
          toast.success(removing === meEmail ? "You're no longer an admin" : `${removeName} is no longer an admin`);
        }}
      >
        <p>{removing === meEmail ? "You will lose the admin pages straight away." : "They stay a member but lose the admin pages straight away."} You can add them back at any time.</p>
      </ConfirmDialog>
    </div>
  );
}
