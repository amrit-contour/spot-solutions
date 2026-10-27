import { Link } from "react-router-dom";
import { IconArrowRight, IconGroup, IconInbox, PageHeader, SectionTitle, SettingRow, Switch } from "@spot/ui";
import { useComicSettings, useWatchedGroups } from "../lib/alerts";
import { PushPrompt } from "../components/PushPrompt";

/** Alerts on this device, the groups being watched, and whether group updates apply themselves. */
export function Settings({ uid }: { uid: string }) {
  const { settings, set } = useComicSettings(uid);
  const groups = useWatchedGroups(uid);
  return (
    <div className="w-full">
      <PageHeader title="Settings" subtitle="Alerts and groups." />
      <div className="flex min-w-0 flex-col gap-6 px-4 pt-4 pb-[calc(var(--nav-h)+2rem)] sm:px-8 sm:pb-12">
        <section aria-label="Notifications">
          <SectionTitle>On this device</SectionTitle>
          <PushPrompt uid={uid} always />
        </section>

        <section aria-label="Groups">
          <SectionTitle>Groups</SectionTitle>
          <div className="rounded-lg bg-surface-low px-4">
            <Link to="/groups" className="state-layer pressable -mx-4 flex min-w-0 items-center gap-3 rounded-lg px-4 py-3">
              <IconGroup aria-hidden className="icon size-5 flex-none text-primary" />
              <span className="min-w-0 flex-1">
                <span className="block type-title-s">Groups to watch</span>
                <span className="block type-body-s text-on-surface-variant">{groups.loading ? "…" : groups.data.length ? `${groups.data.length} watched` : "None yet"}</span>
              </span>
              <IconArrowRight aria-hidden className="icon size-5 flex-none text-on-surface-variant" />
            </Link>
            <SettingRow label="Apply group updates automatically" info="When a group says a room is full, or who curates which day, your rooms are updated for you and it is listed under Alerts. Off: each one waits for a tap.">
              <Switch label="Apply group updates automatically" checked={Boolean(settings.autoApplyGroupUpdates)} onChange={(v) => void set({ autoApplyGroupUpdates: v })} />
            </SettingRow>
          </div>
          <p className="mt-2 flex items-start gap-2 type-body-s text-on-surface-variant">
            <IconInbox aria-hidden className="icon mt-0.5 size-4 flex-none" />
            Only the groups you watch are read. Messages that aren't spot offers, closures or curator updates are dropped, never saved.
          </p>
        </section>
      </div>
    </div>
  );
}
