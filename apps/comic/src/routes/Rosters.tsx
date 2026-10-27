import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { User } from "firebase/auth";
import { toast } from "sonner";
import type { Roster } from "@spot/shared";
import { Button, CompactButton, IconBuilding, IconSearch, IconSend, IconShield, IconUserPlus, PageHeader, Segmented, Spinner } from "@spot/ui";
import { EmptyState, ListGroup, ListRow, IconTile, Page, SearchField, Section } from "../components/ui";
import { ImportSheet, type Incoming } from "../components/ImportSheet";
import { PublishSheet } from "../components/rosters/PublishSheet";
import { RosterCard } from "../components/rosters/RosterCard";
import { ShareSheet } from "../components/rosters/ShareSheet";
import { deleteShare, useFollowerCounts, useFollows, usePublishedRosters, useShares, type RosterShare } from "../lib/rosters";

const hasText = (hay: string, q: string) => hay.toLowerCase().includes(q.trim().toLowerCase());

/** The mini tab bar shared by Rooms and Community. */
export function RoomsTabs({ active }: { active: "rooms" | "curators" | "community" }) {
  const nav = useNavigate();
  return (
    <Segmented
      full
      size="sm"
      value={active}
      onChange={(t) => nav(t === "rooms" ? "/rooms" : t === "curators" ? "/rooms/curators" : "/rosters")}
      options={[{ value: "rooms", label: "Rooms" }, { value: "curators", label: "Curators" }, { value: "community", label: "Community" }]}
    />
  );
}

function Inbox({ uid, shares, onOpen }: { uid: string; shares: RosterShare[]; onOpen: (s: RosterShare) => void }) {
  if (!shares.length) return null;
  return (
    <Section title="Shared with you" count={shares.length}>
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-3">
        {shares.map((s) => (
          <li key={s.id} className="flex min-w-0 flex-col gap-3 rounded-lg bg-secondary-container p-4 text-on-secondary-container">
            <div className="min-w-0">
              <p className="break-words type-title-s">{s.title}</p>
              <p className="break-words type-body-s">From {s.fromName ?? "a member"}, {s.rooms.length} room{s.rooms.length === 1 ? "" : "s"}</p>
            </div>
            {s.note && <p className="break-words type-body-m italic">"{s.note}"</p>}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button size="sm" variant="text" className="-ml-2" onClick={() => void deleteShare(uid, s.id).then(() => toast("Dismissed"))}>Dismiss</Button>
              <Button size="sm" onClick={() => onOpen(s)}>Review</Button>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Community rosters: browse by city, with what was shared with me on top. */
export function Rosters({ user, canPublish, admin }: { user: User; canPublish: boolean; admin: boolean }) {
  const all = usePublishedRosters();
  const { follows } = useFollows(user.uid);
  const shares = useShares(user.uid);
  const counts = useFollowerCounts(all.data.map((r) => r.id), [...follows.keys()].join("|"));
  const [q, setQ] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [incoming, setIncoming] = useState<{ incoming: Incoming; share: RosterShare } | null>(null);

  const cities = useMemo(() => {
    const shown = all.data.filter((r) => !q.trim() || hasText(`${r.title} ${r.city} ${r.ownerName ?? ""}`, q));
    const by = new Map<string, typeof shown>();
    for (const r of shown) by.set(r.city, [...(by.get(r.city) ?? []), r]);
    return [...by.entries()]
      .map(([city, rosters]) => ({ city, rosters: rosters.sort((a, b) => b.updatedAt - a.updatedAt) }))
      .sort((a, b) => b.rosters.length - a.rosters.length || a.city.localeCompare(b.city));
  }, [all.data, q]);

  const empty = !all.loading && all.data.length === 0;
  return (
    <div className="w-full">
      <PageHeader
        width="narrow"
        title="Community"
        actions={
          <>
            <CompactButton icon={IconUserPlus} label="Share" onClick={() => setSharing(true)} />
            {canPublish && <CompactButton icon={IconSend} label="Publish" variant="filled" onClick={() => setPublishing(true)} />}
          </>
        }
        bar={<RoomsTabs active="community" />}
      />

      <Page>
        <SearchField value={q} onChange={setQ} placeholder="Search by city or title" label="Search rosters" />
        <Inbox uid={user.uid} shares={shares.data} onOpen={(s) => setIncoming({ share: s, incoming: { roster: { rooms: s.rooms, curators: s.curators } as Roster, source: `${s.title} from ${s.fromName ?? "a member"}` } })} />

        {admin && (
          <ListGroup>
            <ListRow to="/rosters/publishers" leading={<IconTile tone="neutral" icon={IconShield} />} title="Who can publish" trailing={<span className="type-label-m">Admin</span>} />
          </ListGroup>
        )}

        {all.loading ? (
          <div className="grid place-items-center py-16 text-primary"><Spinner className="size-8" /></div>
        ) : empty ? (
          <EmptyState icon={IconBuilding} title="No community rosters yet" action={canPublish ? <Button onClick={() => setPublishing(true)}>Publish your rooms</Button> : undefined}>
            {canPublish ? "Be the first. Publish your rooms and other comics can follow them." : "When someone publishes their rooms for a city, you will find it here. You can also ask an admin if you can publish."}
          </EmptyState>
        ) : cities.length === 0 ? (
          <EmptyState icon={IconSearch} title="No rosters match">Try a different city or title.</EmptyState>
        ) : (
          cities.map((g) => (
            <Section key={g.city} title={g.city} count={g.rosters.length}>
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
                {g.rosters.map((r) => (
                  <li key={r.id} className="min-w-0"><RosterCard roster={r} follow={follows.get(r.id)} followers={counts[r.id]} uid={user.uid} /></li>
                ))}
              </ul>
            </Section>
          ))
        )}
      </Page>

      <PublishSheet open={publishing} onClose={() => setPublishing(false)} user={user} />
      <ShareSheet open={sharing} onClose={() => setSharing(false)} user={user} />
      <ImportSheet incoming={incoming?.incoming ?? null} onClose={() => setIncoming(null)} onApplied={() => incoming && void deleteShare(user.uid, incoming.share.id)} />
    </div>
  );
}
