import { useState, type ReactNode } from "react";
import { useNavigate, type NavigateFunction } from "react-router-dom";
import { Menu } from "./Menu";
import { Avatar, Segmented, sharpPhoto, cx, type Icon } from "./ui";
import { IconLogout, IconMoon, IconSettings, IconSun } from "./icons";
import { STATUS_TEXT, StatusDot, statusPulses, type StatusTone } from "./Shell";
import { savedMode, setMode, type ThemeMode } from "./theme";

export type AccountUser = { displayName?: string | null; email?: string | null; photoURL?: string | null };

/** The WhatsApp link as the account button shows it: a ring around the avatar, and a dot beside your name in the menu. */
export type AccountStatus = {
  tone: StatusTone;
  label: string;
  detail?: string;
  /** Where the row links (e.g. Settings, WhatsApp). */
  to?: string;
  linkLabel?: string;
  /** The app is still fetching the live state (cold open / resume): the ring draws as a progress ring filling up. */
  syncing?: boolean;
  /** 0..1 while syncing, when the app knows how far along it is; omitted, the ring fills on a loop. */
  progress?: number;
};

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
  /** WhatsApp link state, drawn as a coloured ring around the avatar. */
  status?: AccountStatus;
}) {
  const [mode, setModeState] = useState<ThemeMode>(savedMode());
  const name = user.displayName ?? user.email ?? "You";
  const nav = useNavigate();
  return (
    <Menu
      align={align}
      trigger={(toggle, open) => (
        // The WhatsApp status is a ring in its colour around the avatar, with a soft halo breathing out of it while connected or
        // connecting. Everything here is paint-only (box-shadow), no transform/opacity animation and no press scale: iOS would
        // otherwise rasterise the avatar into a low-resolution layer and draw it blurry in the pinned header.
        <button
          onClick={toggle}
          aria-label={status ? `Account · ${status.label}` : "Account"}
          aria-expanded={open}
          className="relative flex rounded-full p-[3px] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {/* While syncing, the ring is a progress ring that fills up (stroke-dashoffset: paint-only, nothing composited); once
              the live state is in it becomes the solid ring and starts breathing. pathLength 100 makes the dash maths plain. */}
          {status?.syncing && (
            <svg aria-hidden viewBox="0 0 46 46" className={cx("pointer-events-none absolute inset-0 size-full", STATUS_TEXT[status.tone])} fill="none">
              <path d="M23 1.5a21.5 21.5 0 1 1-.01 0" pathLength={100} stroke="currentColor" strokeOpacity={0.25} strokeWidth={2} />
              <path
                d="M23 1.5a21.5 21.5 0 1 1-.01 0"
                pathLength={100}
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeDasharray="100"
                className={status.progress == null ? "ring-fill" : "transition-[stroke-dashoffset] duration-500 ease-out"}
                style={status.progress == null ? undefined : { strokeDashoffset: 100 - Math.max(0, Math.min(1, status.progress)) * 100 }}
              />
            </svg>
          )}
          {/* Halo and ring are separate boxes: the pulse animates box-shadow, which would replace the ring's own shadow. */}
          {status && !status.syncing && statusPulses(status.tone) && (
            <span aria-hidden className={cx("status-pulse pointer-events-none absolute inset-0 rounded-full", STATUS_TEXT[status.tone])} style={{ ["--pulse" as string]: "5px" }} />
          )}
          <span
            aria-hidden
            data-status={status?.tone}
            className={cx(
              "pointer-events-none absolute inset-0 rounded-full",
              status ? !status.syncing && cx(STATUS_TEXT[status.tone], "inset-ring-2 inset-ring-current") : open && "inset-ring-2 inset-ring-primary",
            )}
          />
          {user.photoURL ? <img src={sharpPhoto(user.photoURL)} alt="" referrerPolicy="no-referrer" className="size-10 rounded-full object-cover" /> : <Avatar name={name} size={40} />}
        </button>
      )}
    >
      {(close) => (
        <div className="w-72">
          {/* Who you are, with the WhatsApp status as a dot beside your name. The whole row opens the connection settings. */}
          {(() => {
            const to = status?.to ?? settingsTo;
            const inner = (
              <>
                {user.photoURL ? <img src={sharpPhoto(user.photoURL)} alt="" referrerPolicy="no-referrer" className="size-10 flex-none rounded-full object-cover" /> : <Avatar name={name} size={40} />}
                <div className="min-w-0 flex-1">
                  <div className="truncate type-title-s">{name}</div>
                  {user.email && <div className="truncate type-body-s text-on-surface-variant">{user.email}</div>}
                </div>
                {status && <StatusDot tone={status.tone} size={10} />}
              </>
            );
            return to ? (
              <button
                role="menuitem"
                aria-label={status ? `${name} · ${status.label}. Open settings` : `${name}. Open settings`}
                onClick={() => {
                  close();
                  nav(to);
                }}
                className="state-layer flex w-full items-center gap-3 px-4 pt-2 pb-3 text-left"
              >
                {inner}
              </button>
            ) : (
              <div className="flex items-center gap-3 px-4 pt-2 pb-3">{inner}</div>
            );
          })()}
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
