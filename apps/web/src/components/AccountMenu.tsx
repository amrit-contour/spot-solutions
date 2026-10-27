import { signOut } from "firebase/auth";
import { restartingNow } from "@spot/shared";
import { AccountMenu as BaseAccountMenu, type AccountStatus, AccountMenuItem, IconLightbulb, IconServer, IconShield, cx } from "@spot/ui";
import { auth } from "@spot/ui/firebase";
import { useApp } from "../lib/app";
import { useServers } from "../lib/servers";
import { isAdmin, useAccessConfig } from "../lib/access";
import { clearChatCache } from "../lib/chatCache";

/** The shared account menu plus the curator-only rows: Server and the admin Server guide. */
export function AccountMenu({ align = "right", status }: { align?: "left" | "right"; status?: AccountStatus }) {
  const { user } = useApp();
  const servers = useServers();
  const anyDown = servers?.some((s) => Date.now() - s.lastSeen > 90_000 && !restartingNow(s.restarting, s.lastSeen, Date.now()));
  const admin = isAdmin(useAccessConfig(), user.email);
  return (
    <BaseAccountMenu
      user={user}
      align={align}
      status={status}
      onSignOut={() => void clearChatCache().finally(() => signOut(auth))}
      extra={(close, nav) => (
        <>
          {(admin || (servers && servers.length > 0)) && (
            <AccountMenuItem
              icon={IconServer}
              onClick={() => {
                close();
                nav("/server");
              }}
            >
              <span className="flex-1">Server</span>
              {servers && servers.length > 0 && <span className={cx("size-2 rounded-full", anyDown ? "bg-error" : "bg-ok")} />}
            </AccountMenuItem>
          )}
          {admin && (
            <AccountMenuItem
              icon={IconShield}
              onClick={() => {
                close();
                nav("/admin");
              }}
            >
              Members and admins
            </AccountMenuItem>
          )}
          {admin && (
            <AccountMenuItem
              icon={IconLightbulb}
              onClick={() => {
                close();
                nav("/help");
              }}
            >
              Server guide
            </AccountMenuItem>
          )}
        </>
      )}
    />
  );
}
