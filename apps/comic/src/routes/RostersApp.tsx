import { Navigate, Route, Routes } from "react-router-dom";
import type { User } from "firebase/auth";
import { IconShield, PageHeader, Spinner } from "@spot/ui";
import { EmptyState, Page } from "../components/ui";
import { RosterProvider, useFirestoreRoster } from "../lib/roster";
import { useCommunity } from "../lib/rosters";
import { Rosters } from "./Rosters";
import { RostersDetail } from "./RostersDetail";

/** /rosters/*: community rosters. Only for approved members, and every merge goes through the same review as an import. */
export function RostersApp({ user }: { user: User }) {
  const store = useFirestoreRoster(user.uid);
  const { membership, canPublish, admin } = useCommunity();
  if (membership.state === "loading") return <div className="grid min-h-[50dvh] place-items-center text-primary"><Spinner className="size-8" /></div>;
  if (membership.state !== "allowed") {
    return (
      <>
        <PageHeader width="narrow" title="Community" />
        <Page>
          <EmptyState icon={IconShield} title={membership.state === "pending" ? "Waiting for approval" : "No access"}>
            {membership.state === "pending"
              ? "Community rosters are for approved members. An admin will let you in soon; this page opens by itself."
              : "Your access was removed. Ask an admin if this is a mistake."}
          </EmptyState>
        </Page>
      </>
    );
  }
  return (
    <RosterProvider store={store}>
      <Routes>
        <Route index element={<Rosters user={user} canPublish={canPublish} admin={admin} />} />
        <Route path="publishers" element={<Navigate to="/admin#publishers" replace />} />
        <Route path=":id" element={<RostersDetail user={user} />} />
      </Routes>
    </RosterProvider>
  );
}
