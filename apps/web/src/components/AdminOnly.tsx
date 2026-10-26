import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useApp } from "../lib/app";
import { isAdmin, useAccessConfig } from "../lib/access";
import { Spinner } from "@spot/ui";

/** Renders children only for server admins (SPOT_ADMIN_EMAILS); everyone else goes home. */
export function AdminOnly({ children }: { children: ReactNode }) {
  const { user } = useApp();
  const cfg = useAccessConfig();
  if (!cfg) return <div className="grid min-h-[60dvh] place-items-center text-primary"><Spinner className="size-8" /></div>;
  return isAdmin(cfg, user.email) ? <>{children}</> : <Navigate to="/" replace />;
}
