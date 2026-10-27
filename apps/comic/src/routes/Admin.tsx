import { Navigate } from "react-router-dom";
import type { User } from "firebase/auth";
import { toast } from "sonner";
import { AdminGroup, AdminPerson, AdminRows, AdminPage, CandidateList, IconShield, IconTrash, IconButton, Spinner, adminDisplayName, type AccessRecord } from "@spot/ui";
import { useCommunity, addPublisher, removePublisher, usePublishers } from "../lib/rosters";

/** Settings → Admin (admins only): the shared Members and Admins tabs, plus who may publish community rosters. */
export function Admin({ user }: { user: User }) {
  const { membership, admin } = useCommunity();
  if (membership.state === "loading") return <div className="grid min-h-[50dvh] place-items-center text-primary"><Spinner className="size-8" /></div>;
  if (!admin || !user.email) return <Navigate to="/settings" replace />;
  return <AdminPage me={{ uid: user.uid, email: user.email }} extraTabs={[{ id: "publishers", label: "Publishers", node: (ctx) => <Publishers user={user} records={ctx.records} /> }]} />;
}

/** Anyone approved can follow, import and suggest; only these people and the admins can publish a roster. (Was /rosters/publishers.) */
function Publishers({ user, records }: { user: User; records: AccessRecord[] }) {
  const { data: publishers, loading } = usePublishers(true);
  const add = async (r: AccessRecord) => {
    try {
      await addPublisher({ uid: r.uid, email: r.email ?? "", name: adminDisplayName(r) }, user.uid);
      toast.success(`${adminDisplayName(r)} can now publish`);
    } catch {
      toast.error("Couldn't add them. Check your connection and try again.");
    }
  };
  return (
    <div className="flex flex-col gap-6">
      <AdminGroup title="Who can publish" count={publishers.length + 1} hint="Anyone approved can follow, import and suggest changes. Only the people below, and admins, can publish a roster.">
        <AdminRows>
          <li className="flex min-h-14 items-center gap-3 py-3 pr-4 pl-4">
            <span className="grid size-10 flex-none place-items-center rounded-full bg-primary-container text-on-primary-container"><IconShield aria-hidden className="icon size-5" /></span>
            <span className="min-w-0 flex-1 truncate type-body-l">All admins</span>
            <span className="type-label-m text-on-surface-variant">Always</span>
          </li>
          {publishers.map((p) => (
            <li key={p.uid} className="flex min-h-[4.5rem] items-center gap-2 py-3 pr-2 pl-4">
              <AdminPerson name={p.name ?? p.email ?? "Member"} email={p.email} />
              <IconButton icon={IconTrash} label={`Remove ${p.name ?? p.email ?? "this person"} as publisher`} onClick={() => void removePublisher(p.uid).then(() => toast("Removed"), () => toast.error("Couldn't remove them. Try again."))} />
            </li>
          ))}
          {!loading && publishers.length === 0 && <li className="px-4 py-4 type-body-m text-on-surface-variant">No one else yet.</li>}
        </AdminRows>
      </AdminGroup>
      <AdminGroup title="Add a publisher" hint="Pick from approved members.">
        <CandidateList records={records} exclude={[user.uid, ...publishers.map((p) => p.uid)]} actionLabel="Add" onPick={(r) => void add(r)} empty="Every approved member can publish already." />
      </AdminGroup>
    </div>
  );
}
