// Account → Members and admins (admins only): the shared Members and Admins tabs from @spot/ui, plus what only Curate has:
// how many curators there can be, invites by email, and the demo-sandbox tool.
import { doc, updateDoc } from "firebase/firestore";
import { toast } from "sonner";
import { AdminGroup, AdminPage, Stepper } from "@spot/ui";
import { db } from "@spot/ui/firebase";
import { useApp } from "../lib/app";
import { useAccessConfig } from "../lib/access";
import { WipeDemoCard } from "../components/AdminDataTools";
import { Invites } from "../components/Curators";
import { useServers } from "../lib/servers";

function CuratingTools({ max }: { max: number }) {
  const servers = useServers();
  return (
    <div className="flex flex-col gap-6">
      <AdminGroup title="Curator limit">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
          <p className="min-w-0 flex-1 basis-60 max-w-prose type-body-s text-on-surface-variant">Each approved member gets their own WhatsApp session on the server, about 300–400 MB of memory. New requests can't be approved past this number.</p>
          <Stepper value={max} min={1} max={100} onChange={(v) => void updateDoc(doc(db, "config", "access"), { maxCurators: v }).catch((e: Error) => toast.error(e.message))} />
        </div>
      </AdminGroup>
      <AdminGroup title="Invite by email">
        <div className="pt-4">
          <Invites />
        </div>
      </AdminGroup>
      <WipeDemoCard servers={servers} />
    </div>
  );
}

export function AdminArea() {
  const { user } = useApp();
  const cfg = useAccessConfig();
  const max = cfg?.maxCurators ?? 6;
  if (!user.email) return null;
  return <AdminPage me={{ uid: user.uid, email: user.email }} approveLimit={max} extraTabs={[{ id: "curating", label: "Curate", node: <CuratingTools max={max} /> }]} />;
}
