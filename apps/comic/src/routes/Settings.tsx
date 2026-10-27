import { useState } from "react";
import { signInWithPopup, signOut } from "firebase/auth";
import { toast } from "sonner";
import { Avatar, sharpPhoto, Button, IconArrowRight, IconBell, IconCalendarMark, IconChat, IconGroup, IconInbox, IconMoon, IconShield, IconSun, IconTemplate, PageHeader, Segmented, SettingRow, Switch, savedBrand, savedMode, setBrand, setMode, useBrand, type Brand, type ThemeMode } from "@spot/ui";
import { auth, google } from "@spot/ui/firebase";
import { IconTile, ListGroup, ListRow, Page, Section } from "../components/ui";
import { useComicSettings, useWatchedGroups } from "../lib/alerts";
import { useCommunity } from "../lib/rosters";
import { PushPrompt } from "../components/PushPrompt";
import { ConnectionCard } from "../components/ConnectionCard";
import { AgentHelp } from "../components/AgentHelp";
import { RoomModesSheet, TemplateSheet } from "../components/AskSheets";

const chevron = <IconArrowRight aria-hidden className="icon size-5" />;
const row = (children: React.ReactNode) => <div className="px-4">{children}</div>;

/** Settings, grouped: who you are, the connection, notifications, asks, group alerts, calendar, the agent, appearance. */
export function Settings({ uid }: { uid: string }) {
  const { settings, set } = useComicSettings(uid);
  const groups = useWatchedGroups(uid);
  const { admin } = useCommunity();
  const user = auth.currentUser;
  const name = user?.displayName ?? user?.email ?? "You";
  const [template, setTemplate] = useState(false);
  const [modes, setModes] = useState(false);
  const [mode, setModeState] = useState<ThemeMode>(savedMode());
  const brand = useBrand();
  const switchAccount = () => {
    google.setCustomParameters({ prompt: "select_account" });
    void signOut(auth)
      .then(() => signInWithPopup(auth, google))
      .catch((e: { code?: string }) => {
        if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") toast.error("Couldn't switch account. Allow popups and try again.");
      });
  };

  return (
    <div className="w-full">
      <PageHeader width="narrow" title="Settings" />
      <Page>
        <Section title="Account">
          <div className="flex min-w-0 flex-col gap-4 rounded-lg bg-surface-low p-4">
            <div className="flex min-w-0 items-center gap-3">
              {user?.photoURL ? <img src={sharpPhoto(user.photoURL)} alt="" referrerPolicy="no-referrer" className="size-12 flex-none rounded-full object-cover" /> : <Avatar name={name} size={48} />}
              <div className="min-w-0 flex-1">
                <p className="truncate type-title-m">{name}</p>
                {user?.email && user.displayName && <p className="truncate type-body-s text-on-surface-variant">{user.email}</p>}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="tonal" onClick={switchAccount}>Switch account</Button>
              <Button variant="outlined" onClick={() => void signOut(auth)}>Sign out</Button>
            </div>
          </div>
        </Section>

        <Section title="Connection">
          <ConnectionCard uid={uid} />
        </Section>

        <Section title="Notifications">
          <PushPrompt uid={uid} always />
        </Section>

        <Section title="Asks">
          <ListGroup>
            <ListRow onClick={() => setTemplate(true)} leading={<IconTile tone="neutral" icon={IconTemplate} />} title="Ask message" subtitle="The words every ask starts from" trailing={chevron} />
            <ListRow onClick={() => setModes(true)} leading={<IconTile tone="neutral" icon={IconChat} />} title="Send or review, per room" subtitle="Which rooms send by themselves" trailing={chevron} />
            {row(
              <SettingRow label="Show asks I missed" info="The ping day passed but the show hasn't: it is listed under “Missed: still time to ask” on Asks. Off: only asks due today are listed." className="min-h-14">
                <Switch label="Show asks I missed" checked={settings.showMissedAsks !== false} onChange={(v) => void set({ showMissedAsks: v })} />
              </SettingRow>,
            )}
          </ListGroup>
        </Section>

        <Section title="Group alerts">
          <ListGroup>
            <ListRow to="/groups" leading={<IconTile tone="neutral" icon={IconGroup} />} title="Groups to watch" subtitle={groups.loading ? "…" : groups.data.length ? `${groups.data.length} watched` : "None yet"} trailing={chevron} />
            <ListRow to="/groups" leading={<IconTile tone="neutral" icon={IconBell} />} title="Alert rules" subtitle="How sure a post must look to push at once" trailing={chevron} />
            {row(
              <SettingRow label="Apply group updates automatically" info="When a group says a room is full, or who curates which day, your rooms are updated for you and it is listed under Alerts. Off: each one waits for a tap." className="min-h-14">
                <Switch label="Apply group updates automatically" checked={Boolean(settings.autoApplyGroupUpdates)} onChange={(v) => void set({ autoApplyGroupUpdates: v })} />
              </SettingRow>,
            )}
          </ListGroup>
          <p className="flex items-start gap-2 px-1 pt-1 type-body-s text-on-surface-variant">
            <IconInbox aria-hidden className="icon mt-0.5 size-4 flex-none" />
            Only the groups you watch are read. Messages that aren't spot offers, closures or curator updates are dropped, never saved.
          </p>
        </Section>

        <Section title="Calendar and regular spots">
          <ListGroup>
            <ListRow to="/spots/regulars" leading={<IconTile tone="neutral" icon={IconCalendarMark} />} title="Regular spots" subtitle="Weekly mics that go on your calendar by themselves" trailing={chevron} />
          </ListGroup>
        </Section>

        <Section title="Agent number">
          <AgentHelp uid={uid} />
        </Section>

        <Section title="Appearance">
          <div className="flex min-w-0 flex-col gap-4 rounded-lg bg-surface-low p-4">
            <div className="flex min-w-0 flex-col gap-2">
              <span className="type-label-l text-on-surface-variant">Theme</span>
              <Segmented
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
            <div className="flex min-w-0 flex-col gap-2">
              <span className="type-label-l text-on-surface-variant">Look</span>
              <Segmented full value={brand === "nbc" || brand === "classic" ? brand : savedBrand()} onChange={(b: Brand) => setBrand(b, { animate: true })} options={[{ value: "nbc", label: "Nothing BOT" }, { value: "classic", label: "Classic" }]} />
            </div>
          </div>
        </Section>

        {admin && (
          <Section title="Admin">
            <ListGroup>
              <ListRow to="/admin" leading={<IconTile tone="neutral" icon={IconShield} />} title="Admin" subtitle="Members and publishers" trailing={chevron} />
            </ListGroup>
          </Section>
        )}

        <p className="px-1 type-body-s text-on-surface-variant"><a className="underline underline-offset-4" href="/privacy">Privacy</a> · <a className="underline underline-offset-4" href="/terms">Terms</a></p>
      </Page>

      <TemplateSheet open={template} onClose={() => setTemplate(false)} />
      <RoomModesSheet open={modes} onClose={() => setModes(false)} />
    </div>
  );
}
