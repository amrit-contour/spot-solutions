import { useState, type ReactNode } from "react";
import { useNavigate, type NavigateFunction } from "react-router-dom";
import { Menu } from "./Menu";
import { Avatar, Segmented, sharpPhoto, cx, type Icon } from "./ui";
import { IconLogout, IconMoon, IconSettings, IconSun } from "./icons";
import { savedMode, setMode, type ThemeMode } from "./theme";

export type AccountUser = { displayName?: string | null; email?: string | null; photoURL?: string | null };

/** One row of the account menu, styled to match the built-in ones. */
export function AccountMenuItem({ icon: I, onClick, danger, children }: { icon: Icon; onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button role="menuitem" onClick={onClick} className={cx("state-layer flex w-full items-center gap-3 border-t border-outline-variant/60 px-4 py-3 text-left type-label-l", danger && "text-error")}>
      <I className={cx("icon size-5", !danger && "text-primary")} />
      {children}
    </button>
  );
}

/** The avatar button and its menu: who you are, theme, Settings (phones), app extras, sign out. */
export function AccountMenu({
  user,
  onSignOut,
  settingsTo = "/settings",
  extra,
  align = "right",
}: {
  user: AccountUser;
  onSignOut: () => void;
  /** Phone-only Settings row goes here; pass null if the app has no Settings page. */
  settingsTo?: string | null;
  /** App-specific rows, placed between Settings and Sign out. */
  extra?: (close: () => void, nav: NavigateFunction) => ReactNode;
  align?: "left" | "right";
}) {
  const [mode, setModeState] = useState<ThemeMode>(savedMode());
  const name = user.displayName ?? user.email ?? "You";
  const nav = useNavigate();
  return (
    <Menu
      align={align}
      trigger={(toggle, open) => (
        <button onClick={toggle} aria-label="Account" aria-expanded={open} className={cx("pressable rounded-full p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-primary", open && "ring-2 ring-primary")}>
          {user.photoURL ? <img src={sharpPhoto(user.photoURL)} alt="" referrerPolicy="no-referrer" className="size-10 rounded-full object-cover" /> : <Avatar name={name} size={40} />}
        </button>
      )}
    >
      {(close) => (
        <div className="w-72">
          <div className="flex items-center gap-3 px-4 pt-2 pb-3">
            {user.photoURL ? <img src={sharpPhoto(user.photoURL)} alt="" referrerPolicy="no-referrer" className="size-10 rounded-full object-cover" /> : <Avatar name={name} size={40} />}
            <div className="min-w-0">
              <div className="truncate type-title-s">{name}</div>
              {user.email && <div className="truncate type-body-s text-on-surface-variant">{user.email}</div>}
            </div>
          </div>
          <div className="border-t border-outline-variant/60 px-4 py-3">
            <Segmented
              size="sm"
              full
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
          {settingsTo && (
            <div className="sm:hidden">
              <AccountMenuItem
                icon={IconSettings}
                onClick={() => {
                  close();
                  nav(settingsTo);
                }}
              >
                Settings
              </AccountMenuItem>
            </div>
          )}
          {extra?.(close, nav)}
          <AccountMenuItem
            icon={IconLogout}
            danger
            onClick={() => {
              close();
              onSignOut();
            }}
          >
            Sign out
          </AccountMenuItem>
        </div>
      )}
    </Menu>
  );
}
