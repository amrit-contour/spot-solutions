import { useEffect, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { PageHeader } from "../Shell";
import { Spinner, Segmented, cx } from "../ui";
import { AdminsPanel } from "./AdminsPanel";
import { MembersPanel, type AdminCtx } from "./MembersPanel";
import { useAccessList, useActivity, useAdminEmails } from "./api";
import { Note } from "./parts";

export interface AdminTab {
  id: string;
  label: string;
  /** Shown after the label (a count). */
  badge?: ReactNode;
  /** The tab body; a function gets the live members and admins. */
  node: ReactNode | ((ctx: AdminCtx) => ReactNode);
}

/**
 * The admin area both apps mount: Members and Admins, plus the app's own tabs (Comedy: Publishers, Curate: Tools).
 * The tab lives in the URL hash so a link can open it. Render only for admins; the data it reads is admin-only in firestore.rules anyway.
 */
export function AdminPage({ me, extraTabs = [], approveLimit, title = "Members & admins", subtitle = "Who can use the apps and who runs them" }: { me: { uid: string; email: string }; extraTabs?: AdminTab[]; approveLimit?: number; title?: string; subtitle?: string }) {
  const { list, error } = useAccessList();
  const admins = useAdminEmails();
  const activity = useActivity();
  const { hash } = useLocation();
  const nav = useNavigate();

  const pendingCount = list?.filter((r) => r.status === "pending").length ?? 0;
  const tabs: AdminTab[] = [
    { id: "members", label: "Members", badge: pendingCount || undefined, node: null },
    { id: "admins", label: "Admins", badge: admins?.length || undefined, node: null },
    ...extraTabs,
  ];
  const wanted = hash.replace("#", "");
  const current = tabs.some((t) => t.id === wanted) ? wanted : "members";
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [current]);

  const ctx = list && admins ? { me, records: list, admins, activity } : null;
  const own = extraTabs.find((t) => t.id === current);

  return (
    <div className="w-full">
      <PageHeader width="narrow" title={title} subtitle={subtitle} />
      <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-6 px-4 pt-4 pb-[calc(var(--nav-h,0px)+2rem)] sm:px-8 sm:pb-16">
        <Segmented full value={current} onChange={(id) => nav({ hash: id }, { replace: true })} options={tabs.map((t) => ({ value: t.id, label: t.label, badge: t.badge }))} />
        {error ? (
          <Note tone="error">Couldn't load the members. Only admins can see this page; if you are one, check your connection and reload.</Note>
        ) : !ctx ? (
          <div className={cx("grid min-h-40 place-items-center text-primary")}>
            <Spinner className="size-7" />
          </div>
        ) : own ? (
          typeof own.node === "function" ? own.node(ctx) : own.node
        ) : current === "admins" ? (
          <AdminsPanel ctx={ctx} />
        ) : (
          <MembersPanel ctx={ctx} approveLimit={approveLimit} />
        )}
      </div>
    </div>
  );
}
