import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import type { User } from "firebase/auth";
import { toast } from "sonner";
import { Button, IconArrowLeft, IconButton, IconShield, IconTrash, PageHeader } from "@spot/ui";
import { IconTile, ListGroup, ListRow, Page } from "../components/ui";
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
      <PageHeader width="narrow" title="Who can publish" subtitle="Admin" trailing={<IconButton icon={IconArrowLeft} label="Back to Community" onClick={() => nav("/rosters")} />} />
      <Page>
        <p className="px-1 type-body-m text-on-surface-variant">Anyone approved can follow, import and suggest changes. Only the people below, and admins, can publish a roster.</p>
        <ListGroup>
          <ListRow leading={<IconTile tone="neutral" icon={IconShield} />} title="All admins" trailing={<span className="type-label-m">Always</span>} />
          {list.data.map((p) => (
            <ListRow
              key={p.uid}
              title={p.name ?? p.email ?? "Member"}
              subtitle={p.email && p.name ? p.email : undefined}
              trailing={<IconButton icon={IconTrash} label={`Remove ${p.name ?? p.email ?? "this person"}`} onClick={() => void removePublisher(p.uid).then(() => toast("Removed"))} />}
            />
          ))}
          {!list.loading && list.data.length === 0 && <p className="px-4 py-4 type-body-m text-on-surface-variant">No one else yet.</p>}
        </ListGroup>
        <div className="flex min-w-0 flex-col gap-3">
          <MemberPicker label="Add a publisher" hint="Anyone approved in the app. Type a name or email." value={picked} onChange={setPicked} exclude={[user.uid, ...list.data.map((p) => p.uid)]} />
          {picked && <Button onClick={() => void add()} loading={busy} className="self-start">Add {picked.name}</Button>}
        </div>
        {error && <p role="alert" className="rounded-md bg-error-container p-4 type-body-m text-on-error-container">{error}</p>}
      </Page>
    </div>
  );
}
