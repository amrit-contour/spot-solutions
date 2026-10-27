import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button, CompactButton, IconGroup, IconRefresh, PageHeader, SettingRow, Spinner, Switch } from "@spot/ui";
import { EmptyState, IconTile, ListGroup, ListRow, Page, SearchField, Section } from "../components/ui";
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
    // A WhatsApp group can come back with no name at all: it still lists (as "Unnamed group") instead of breaking the page.
    const nameOf = (n: unknown) => (typeof n === "string" && n.trim() ? n : "Unnamed group");
    const known = new Map(all.data.map((g) => [g.id, { id: g.id, name: nameOf(g.name), participants: typeof g.participants === "number" ? g.participants : undefined }]));
    for (const w of watched.data) if (!known.has(w.id)) known.set(w.id, { id: w.id, name: nameOf(w.name), participants: undefined });
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
      <PageHeader width="narrow" title="Groups" actions={<CompactButton icon={IconRefresh} label="Refresh" loading={loading} onClick={() => void refresh()} />} />

      <Page>
        <SearchField value={q} onChange={setQ} placeholder="Search your groups" />
        <p className="px-1 type-body-m text-on-surface-variant">
          Only the groups you switch on are read, and only by your own server. A message that isn't a spot offer, a closure or a curator update is dropped without being saved. Nothing is posted in a group.
        </p>

        <ListGroup>
          <div className="px-4">
            <SettingRow label="Apply group updates automatically" info="When a group says a room is full, or who curates which day, your rooms are updated for you and it is listed under Alerts. Off: each one waits for a tap." className="min-h-14">
              <Switch label="Apply group updates automatically" checked={Boolean(settings.autoApplyGroupUpdates)} onChange={(v) => void set({ autoApplyGroupUpdates: v })} />
            </SettingRow>
          </div>
        </ListGroup>

        <AlertRulesPanel uid={uid} />

        <Section title="Your groups" count={rows.length || undefined}>
          {all.loading || watched.loading ? (
            <div className="grid place-items-center py-12 text-primary">
              <Spinner className="size-8" />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={IconGroup}
              title={q ? "No groups match" : "No groups yet"}
              action={!q && <Button icon={IconRefresh} loading={loading} onClick={() => void refresh()}>Load my groups</Button>}
            >
              {q ? "Try a different name." : "Load the groups on your WhatsApp. This needs your server running with WhatsApp linked."}
            </EmptyState>
          ) : (
            <ListGroup>
              {rows.map((g) => (
                <ListRow
                  key={g.id}
                  leading={<IconTile tone="neutral" icon={IconGroup} />}
                  title={g.name}
                  subtitle={on.has(g.id) ? "Watching" : g.participants ? `${g.participants} members` : "Not watched"}
                  trailing={<Switch label={`Watch ${g.name}`} checked={on.has(g.id)} onChange={(v) => toggle(g, v)} />}
                />
              ))}
            </ListGroup>
          )}
        </Section>
      </Page>
    </div>
  );
}
