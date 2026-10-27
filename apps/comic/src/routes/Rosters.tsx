import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { User } from "firebase/auth";
import { toast } from "sonner";
import type { Roster } from "@spot/shared";
import { Button, CompactButton, Empty, IconBuilding, IconInbox, IconSearch, IconSend, IconShield, IconUserPlus, PageHeader, Segmented, Spinner, TextInput } from "@spot/ui";
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
      value={active}
      onChange={(t) => nav(t === "rooms" ? "/rooms" : t === "curators" ? "/rooms/curators" : "/rosters")}
      options={[{ value: "rooms", label: "Rooms" }, { value: "curators", label: "Curators" }, { value: "community", label: "Community" }]}
    />
  );
}

function Inbox({ uid, shares, onOpen }: { uid: string; shares: RosterShare[]; onOpen: (s: RosterShare) => void }) {
  if (!shares.length) return null;
  return (
    <section aria-label="Shared with you" className="flex min-w-0 flex-col gap-3">
      <h2 className="flex items-baseline gap-2 type-title-m text-on-surface-variant"><IconInbox aria-hidden className="icon size-5 self-center" />Shared with you <span className="type-label-m tabular">{shares.length}</span></h2>
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
        {shares.map((s) => (
          <li key={s.id} className="flex min-w-0 flex-col gap-2 rounded-lg bg-secondary-container p-4 text-on-secondary-container">
            <p className="break-words type-title-s">{s.title}</p>
            <p className="break-words type-body-s">From {s.fromName ?? "a member"}, {s.rooms.length} room{s.rooms.length === 1 ? "" : "s"}</p>
            {s.note && <p className="break-words type-body-m italic">"{s.note}"</p>}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" onClick={() => onOpen(s)}>Review</Button>
              <Button size="sm" variant="text" onClick={() => void deleteShare(uid, s.id).then(() => toast("Dismissed"))}>Dismiss</Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
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
        title="Community"
        subtitle="Rosters other comics keep up to date."
        actions={
          <>
            <CompactButton icon={IconUserPlus} label="Share" onClick={() => setSharing(true)} />
            {canPublish && <CompactButton icon={IconSend} label="Publish" variant="filled" onClick={() => setPublishing(true)} />}
          </>
        }
      >
        <div className="relative mt-3">
          <IconSearch aria-hidden className="icon pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-on-surface-variant" />
          <TextInput value={q} onChange={(e) => setQ(e.target.value)} className="pl-11" placeholder="Search by city or title" type="search" aria-label="Search rosters" />
        </div>
      </PageHeader>
      <div className="px-4 pt-3 pb-4 sm:px-8"><RoomsTabs active="community" /></div>

      <div className="flex min-w-0 flex-col gap-8 px-4 pb-[calc(var(--nav-h)+2rem)] sm:px-8 sm:pb-12">
        <Inbox uid={user.uid} shares={shares.data} onOpen={(s) => setIncoming({ share: s, incoming: { roster: { rooms: s.rooms, curators: s.curators } as Roster, source: `${s.title} from ${s.fromName ?? "a member"}` } })} />

        {admin && (
          <Link to="/rosters/publishers" className="state-layer pressable flex min-h-12 min-w-0 items-center gap-3 rounded-lg bg-surface-low px-4 py-3">
            <IconShield aria-hidden className="icon size-5 flex-none text-primary" />
            <span className="min-w-0 flex-1 truncate type-title-s">Who can publish</span>
            <span className="type-label-m text-on-surface-variant">Admin</span>
          </Link>
        )}

        {all.loading ? (
          <div className="grid place-items-center py-16 text-primary"><Spinner className="size-8" /></div>
        ) : empty ? (
          <Empty icon={IconBuilding} title="No community rosters yet" action={canPublish ? <Button onClick={() => setPublishing(true)}>Publish your rooms</Button> : undefined}>
            {canPublish ? "Be the first. Publish your rooms and other comics can follow them." : "When someone publishes their rooms for a city, you will find it here. You can also ask an admin if you can publish."}
          </Empty>
        ) : cities.length === 0 ? (
          <Empty icon={IconSearch} title="No rosters match">Try a different city or title.</Empty>
        ) : (
          cities.map((g) => (
            <section key={g.city} aria-label={g.city} className="min-w-0">
              <h2 className="mb-3 flex items-baseline gap-2 type-title-m text-on-surface-variant">
                <span className="min-w-0 truncate">{g.city}</span>
                <span className="type-label-m tabular">{g.rosters.length}</span>
              </h2>
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
                {g.rosters.map((r) => (
                  <li key={r.id} className="min-w-0"><RosterCard roster={r} follow={follows.get(r.id)} followers={counts[r.id]} uid={user.uid} /></li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      <PublishSheet open={publishing} onClose={() => setPublishing(false)} user={user} />
      <ShareSheet open={sharing} onClose={() => setSharing(false)} user={user} />
      <ImportSheet incoming={incoming?.incoming ?? null} onClose={() => setIncoming(null)} onApplied={() => incoming && void deleteShare(user.uid, incoming.share.id)} />
    </div>
  );
}
