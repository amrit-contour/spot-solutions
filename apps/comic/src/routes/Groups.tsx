import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button, Empty, IconGroup, IconRefresh, IconSearch, PageHeader, SettingRow, Spinner, Switch, TextInput } from "@spot/ui";
import { setWatched, useAllGroups, useComicSettings, useWatchedGroups } from "../lib/alerts";
import { runCommand } from "../lib/commands";
import { AlertRulesPanel } from "../components/AlertRulesPanel";

/** Pick which WhatsApp groups to watch. Only those are read by your server; nothing else, and switching one off stops it at once. */
export function Groups({ uid }: { uid: string }) {
  const all = useAllGroups(uid);
  const watched = useWatchedGroups(uid);
  const { settings, set } = useComicSettings(uid);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const on = useMemo(() => new Set(watched.data.map((g) => g.id)), [watched.data]);
  // A watched group that has since vanished from the list still shows, so it can be switched off.
  const rows = useMemo(() => {
    const known = new Map(all.data.map((g) => [g.id, { id: g.id, name: g.name, participants: g.participants as number | undefined }]));
    for (const w of watched.data) if (!known.has(w.id)) known.set(w.id, { id: w.id, name: w.name, participants: undefined });
    return [...known.values()].filter((g) => g.name.toLowerCase().includes(q.trim().toLowerCase())).sort((a, b) => Number(on.has(b.id)) - Number(on.has(a.id)) || a.name.localeCompare(b.name));
  }, [all.data, watched.data, q, on]);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await runCommand<{ count: number }>(uid, "list_groups", {}, 120_000);
      toast(`Found ${r.count} group${r.count === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const toggle = (g: { id: string; name: string }, next: boolean) => {
    void setWatched(uid, g, next).catch((e: Error) => toast.error(e.message));
  };

  return (
    <div className="w-full">
      <PageHeader title="Groups" subtitle="Which WhatsApp groups to watch for spots." actions={<Button variant="tonal" size="sm" icon={IconRefresh} loading={loading} onClick={() => void refresh()}>Refresh</Button>}>
        <div className="relative mt-3">
          <IconSearch aria-hidden className="icon pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-on-surface-variant" />
          <TextInput value={q} onChange={(e) => setQ(e.target.value)} className="pl-11" placeholder="Search your groups" type="search" aria-label="Search groups" />
        </div>
      </PageHeader>

      <div className="flex min-w-0 flex-col gap-4 px-4 pt-4 pb-[calc(var(--nav-h)+2rem)] sm:px-8 sm:pb-12">
        <p className="type-body-m text-on-surface-variant">
          Only the groups you switch on are read, and only by your own server. A message that isn't a spot offer, a closure or a curator update is dropped without being saved. Nothing is posted in a group.
        </p>

        <div className="rounded-lg bg-surface-low px-4">
          <SettingRow label="Apply group updates automatically" info="When a group says a room is full, or who curates which day, your rooms are updated for you and it is listed under Alerts. Off: each one waits for a tap.">
            <Switch label="Apply group updates automatically" checked={Boolean(settings.autoApplyGroupUpdates)} onChange={(v) => void set({ autoApplyGroupUpdates: v })} />
          </SettingRow>
        </div>

        <AlertRulesPanel uid={uid} />

        {all.loading || watched.loading ? (
          <div className="grid place-items-center py-12 text-primary">
            <Spinner className="size-8" />
          </div>
        ) : rows.length === 0 ? (
          <Empty
            icon={IconGroup}
            title={q ? "No groups match" : "No groups yet"}
            action={!q && <Button icon={IconRefresh} loading={loading} onClick={() => void refresh()}>Load my groups</Button>}
          >
            {q ? "Try a different name." : "Load the groups on your WhatsApp. This needs your server running with WhatsApp linked."}
          </Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((g) => (
              <li key={g.id} className="flex min-w-0 items-center gap-3 rounded-lg bg-surface-low p-3 pl-4">
                <span className="grid size-10 flex-none place-items-center rounded-full bg-surface-high text-primary">
                  <IconGroup className="icon size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate type-title-s">{g.name}</span>
                  <span className="block truncate type-body-s text-on-surface-variant">{on.has(g.id) ? "Watching" : g.participants ? `${g.participants} members` : "Not watched"}</span>
                </span>
                <Switch label={`Watch ${g.name}`} checked={on.has(g.id)} onChange={(v) => toggle(g, v)} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
