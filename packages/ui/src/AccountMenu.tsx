import { useState, type ReactNode } from "react";
import { useNavigate, type NavigateFunction } from "react-router-dom";
import { Menu } from "./Menu";
import { Avatar, Segmented, sharpPhoto, cx, type Icon } from "./ui";
import { IconLogout, IconMoon, IconSettings, IconSun } from "./icons";
import { StatusDot, type StatusTone } from "./Shell";
import { savedMode, setMode, type ThemeMode } from "./theme";

export type AccountUser = { displayName?: string | null; email?: string | null; photoURL?: string | null };

/** The WhatsApp link as the account button shows it: a dot on the avatar, and a row at the top of the menu. */
export type AccountStatus = { tone: StatusTone; label: string; detail?: string; /** Where the row links (e.g. Settings, WhatsApp). */ to?: string; linkLabel?: string };

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
  status,
}: {
  user: AccountUser;
  onSignOut: () => void;
  /** Phone-only Settings row goes here; pass null if the app has no Settings page. */
  settingsTo?: string | null;
  /** App-specific rows, placed between Settings and Sign out. */
  extra?: (close: () => void, nav: NavigateFunction) => ReactNode;
  align?: "left" | "right";
  /** WhatsApp link state, drawn as a dot on the avatar's bottom-right corner. */
  status?: AccountStatus;
}) {
  const [mode, setModeState] = useState<ThemeMode>(savedMode());
  const name = user.displayName ?? user.email ?? "You";
  const nav = useNavigate();
  return (
    <Menu
      align={align}
      trigger={(toggle, open) => (
        <button onClick={toggle} aria-label={status ? `Account · ${status.label}` : "Account"} aria-expanded={open} className={cx("pressable relative rounded-full p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-primary", open && "ring-2 ring-primary")}>
          {user.photoURL ? <img src={sharpPhoto(user.photoURL)} alt="" referrerPolicy="no-referrer" className="size-10 rounded-full object-cover" /> : <Avatar name={name} size={40} />}
          {status && (
            <span data-status={status.tone} className="absolute right-0 bottom-0">
              <StatusDot tone={status.tone} size={12} ring />
            </span>
          )}
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
          {status && (
            <div className="flex items-center gap-3 border-t border-outline-variant/60 px-4 py-3">
              <StatusDot tone={status.tone} size={10} />
              <div className="min-w-0 flex-1 type-body-m">
                {status.label}
                {status.detail && <span className="text-on-surface-variant"> · {status.detail}</span>}
              </div>
              {status.to && (
                <button
                  onClick={() => {
                    close();
                    nav(status.to!);
                  }}
                  className="state-layer -my-1 -mr-2 flex-none rounded-full px-3 py-1.5 type-label-l text-primary"
                >
                  {status.linkLabel ?? "Settings"}
                </button>
              )}
            </div>
          )}
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
