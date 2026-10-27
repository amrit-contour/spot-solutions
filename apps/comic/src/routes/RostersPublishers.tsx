import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import type { User } from "firebase/auth";
import { toast } from "sonner";
import { Button, IconArrowLeft, IconButton, IconShield, IconTrash, PageHeader } from "@spot/ui";
import { MemberPicker } from "../components/MemberPicker";
import type { MemberEntry } from "../lib/members";
import { addPublisher, removePublisher, usePublishers } from "../lib/rosters";

/** Admins only: who may publish community rosters. Admins can always publish, so they aren't listed. */
export function RostersPublishers({ user, admin }: { user: User; admin: boolean }) {
  const nav = useNavigate();
  const list = usePublishers(admin);
  const [picked, setPicked] = useState<MemberEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!admin) return <Navigate to="/rosters" replace />;

  const add = async () => {
    setError("");
    setBusy(true);
    try {
      const m = picked;
      if (!m) return;
      if (list.data.some((p) => p.uid === m.uid)) throw new Error("They can publish already.");
      await addPublisher(m, user.uid);
      toast.success(`${m.name ?? m.email} can now publish`);
      setPicked(null);
    } catch (e) {
      setError(e instanceof Error && !/permission|insufficient/i.test(e.message) ? e.message : "Couldn't add them. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full">
      <PageHeader title="Who can publish" subtitle="Admin" trailing={<IconButton icon={IconArrowLeft} label="Back to Community" onClick={() => nav("/rosters")} />} />
      <div className="mx-auto flex max-w-2xl min-w-0 flex-col gap-6 px-4 pt-4 pb-[calc(var(--nav-h)+2rem)] sm:px-8 sm:pb-12">
        <p className="type-body-l text-on-surface-variant">Anyone approved can follow, import and suggest changes. Only the people below, and admins, can publish a roster.</p>
        <ul className="flex min-w-0 flex-col overflow-hidden rounded-md bg-surface-low">
          <li className="flex min-h-12 min-w-0 items-center gap-3 border-b border-outline-variant/40 px-3 py-2">
            <IconShield aria-hidden className="icon size-5 flex-none text-primary" />
            <span className="min-w-0 flex-1 truncate type-body-l">All admins</span>
            <span className="type-label-m text-on-surface-variant">Always</span>
          </li>
          {list.data.map((p) => (
            <li key={p.uid} className="flex min-h-14 min-w-0 items-center gap-3 border-b border-outline-variant/40 px-3 py-1 last:border-b-0">
              <span className="min-w-0 flex-1">
                <span className="block truncate type-body-l">{p.name ?? p.email ?? "Member"}</span>
                {p.email && p.name && <span className="block truncate type-body-s text-on-surface-variant">{p.email}</span>}
              </span>
              <IconButton icon={IconTrash} label={`Remove ${p.name ?? p.email ?? "this person"}`} onClick={() => void removePublisher(p.uid).then(() => toast("Removed"))} />
            </li>
          ))}
          {!list.loading && list.data.length === 0 && <li className="px-3 py-4 type-body-m text-on-surface-variant">No one else yet.</li>}
        </ul>
        <div className="flex min-w-0 flex-col gap-3">
          <MemberPicker label="Add a publisher" hint="Anyone approved in the app. Type a name or email." value={picked} onChange={setPicked} exclude={[user.uid, ...list.data.map((p) => p.uid)]} />
          {picked && <Button onClick={() => void add()} loading={busy} className="h-12 self-start">Add {picked.name}</Button>}
        </div>
        {error && <p role="alert" className="rounded-md bg-error-container p-4 type-body-m text-on-error-container">{error}</p>}
      </div>
    </div>
  );
}
