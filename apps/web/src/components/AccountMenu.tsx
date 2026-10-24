import { useState } from "react";
import { signOut } from "firebase/auth";
import { useNavigate } from "react-router-dom";
import { useApp } from "../lib/app";
import { useServers } from "../routes/Server";
import { auth } from "../lib/firebase";
import { savedMode, setMode, type ThemeMode } from "../lib/theme";
import { Menu } from "./Menu";
import { Avatar, Segmented, cx } from "./ui";
import { IconLogout, IconMoon, IconServer, IconSun } from "./icons";

export function AccountMenu() {
  const { user } = useApp();
  const [mode, setModeState] = useState<ThemeMode>(savedMode());
  const name = user.displayName ?? user.email ?? "You";
  const servers = useServers();
  const nav = useNavigate();
  const anyDown = servers?.some((s) => Date.now() - s.lastSeen > 90_000);
  return (
    <Menu
      align="right"
      trigger={(toggle, open) => (
        <button onClick={toggle} aria-label="Account" aria-expanded={open} className={cx("state-layer pressable rounded-full p-0.5", open && "ring-2 ring-primary")}>
          {user.photoURL ? <img src={user.photoURL} alt="" referrerPolicy="no-referrer" className="size-10 rounded-full object-cover" /> : <Avatar name={name} size={40} />}
        </button>
      )}
    >
      {(close) => (
        <div className="w-72">
          <div className="flex items-center gap-3 px-4 pt-2 pb-3">
            {user.photoURL ? <img src={user.photoURL} alt="" referrerPolicy="no-referrer" className="size-10 rounded-full object-cover" /> : <Avatar name={name} size={40} />}
            <div className="min-w-0">
              <div className="truncate type-title-s">{name}</div>
              {user.email && <div className="truncate type-body-s text-on-surface-variant">{user.email}</div>}
            </div>
          </div>
          <div className="border-t border-outline-variant/60 px-4 py-3">
            <div className="mb-2 type-label-m text-on-surface-variant">Theme</div>
            <Segmented
              size="sm"
              value={mode}
              onChange={(m) => {
                setMode(m);
                setModeState(m);
              }}
              options={[
                { value: "system", label: "Auto" },
                { value: "light", label: "Light", icon: IconSun },
                { value: "dark", label: "Dark", icon: IconMoon },
              ]}
            />
          </div>
          {servers && servers.length > 0 && (
            <button
              role="menuitem"
              onClick={() => {
                close();
                nav("/server");
              }}
              className="state-layer flex w-full items-center gap-3 border-t border-outline-variant/60 px-4 py-3 text-left type-label-l"
            >
              <IconServer className="icon size-5 text-primary" />
              <span className="flex-1">Server</span>
              <span className={cx("size-2 rounded-full", anyDown ? "bg-error" : "bg-[#3fb950]")} />
            </button>
          )}
          <button
            role="menuitem"
            onClick={() => {
              close();
              void signOut(auth);
            }}
            className="state-layer flex w-full items-center gap-3 border-t border-outline-variant/60 px-4 py-3 text-left type-label-l text-error"
          >
            <IconLogout className="icon size-5" /> Sign out
          </button>
        </div>
      )}
    </Menu>
  );
}
