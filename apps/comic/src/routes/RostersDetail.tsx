import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { User } from "firebase/auth";
import { toast } from "sonner";
import { DEFAULT_SETTINGS, canMaintain, diffRosters, groupByArea, localDate, roomMatches, toSharedRoster, type Curator, type Room, type RoomShared, type Roster } from "@spot/shared";
import {
  Button, ConfirmDialog, Empty, IconAdd, IconArrowLeft, IconBuilding, IconButton, IconImport, IconMenuDots, IconPen, IconSearch, IconUserCheck, Menu, MenuItem, PageHeader, Spinner, TextInput,
} from "@spot/ui";
import { ImportSheet } from "../components/ImportSheet";
import { RoomCard } from "../components/RoomCard";
import { MaintainersSheet } from "../components/rosters/MaintainersSheet";
import { PublishSheet } from "../components/rosters/PublishSheet";
import { ago, maintainerNames } from "../components/rosters/RosterCard";
import { RoomView } from "../components/rosters/RoomView";
import { SuggestSheet } from "../components/rosters/SuggestSheet";
import { SuggestionsQueue } from "../components/rosters/SuggestionsQueue";
import { useRoster } from "../lib/roster";
import { followRoster, hasUpdate, markSeen, unfollowRoster, unpublishRoster, useFollowerCount, useFollows, usePublishedRoster, useSuggestions } from "../lib/rosters";

const TZ = DEFAULT_SETTINGS.timezone;

/** One published roster: its rooms (read only), follow / import, the update banner, suggestions and, for maintainers, the review queue. */
export function RostersDetail({ user }: { user: User }) {
  const { id } = useParams();
  const nav = useNavigate();
  const { roster, loading } = usePublishedRoster(id);
  const store = useRoster();
  const { follows } = useFollows(user.uid);
  const follow = id ? follows.get(id) : undefined;
  const followers = useFollowerCount(id);
  const maintainer = Boolean(roster && canMaintain(roster, user.uid));
  const owner = roster?.ownerUid === user.uid;
  const sug = useSuggestions(id ?? "", user.uid, maintainer);

  const [q, setQ] = useState("");
  const [viewing, setViewing] = useState<RoomShared | null>(null);
  const [suggesting, setSuggesting] = useState<{ room: RoomShared | null } | null>(null);
  const [importing, setImporting] = useState(false);
  const [people, setPeople] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [busy, setBusy] = useState(false);
  const date = localDate(new Date(), TZ);

  const rooms = useMemo(() => (roster?.rooms ?? []) as unknown as Room[], [roster]);
  const curators = useMemo(() => (roster?.curators ?? []) as Curator[], [roster]);
  const shown = useMemo(() => groupByArea(rooms.filter((r) => roomMatches(r, curators, q))), [rooms, curators, q]);
  const update = roster ? hasUpdate(follow, roster) : false;
  const mineRoster: Roster = { rooms: store.rooms, curators: store.curators };
  const pending = useMemo(() => (update && roster ? diffRosters(mineRoster, toSharedRoster(roster)).length : 0), [update, roster, store.rooms, store.curators]); // eslint-disable-line react-hooks/exhaustive-deps
  const news = roster && follow ? (roster.changelog ?? []).filter((c) => c.version > follow.seenVersion) : [];

  if (loading) return <div className="grid min-h-[50dvh] place-items-center text-primary"><Spinner className="size-8" /></div>;
  if (!roster) {
    return (
      <Empty icon={IconBuilding} title="That roster isn't here" action={<Button onClick={() => nav("/rosters")}>Back to Community</Button>}>
        It may have been unpublished, or the link is wrong.
      </Empty>
    );
  }

  const toggleFollow = async () => {
    setBusy(true);
    try {
      if (follow) {
        await unfollowRoster(user.uid, roster.id);
        toast(`Unfollowed ${roster.title}`);
      } else {
        await followRoster(user, roster);
        toast.success("Following. You'll see when it has an update.");
      }
    } catch {
      toast.error("Couldn't do that. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full">
      <PageHeader
        title={roster.title}
        actions={
          <Menu align="right" trigger={(open) => <IconButton icon={IconMenuDots} label="More" onClick={open} />}>
            {(close) => (
              <>
                <MenuItem onClick={() => { close(); setSuggesting({ room: null }); }}>Suggest a new room</MenuItem>
                {owner && <MenuItem onClick={() => { close(); setPublishing(true); }}>Publish an update</MenuItem>}
                {owner && <MenuItem onClick={() => { close(); setPeople(true); }}>Co-maintainers</MenuItem>}
                {owner && <MenuItem onClick={() => { close(); setConfirmUnpublish(true); }}>Unpublish</MenuItem>}
              </>
            )}
          </Menu>
        }
      >
        <div className="relative mt-3">
          <IconSearch aria-hidden className="icon pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-on-surface-variant" />
          <TextInput value={q} onChange={(e) => setQ(e.target.value)} className="pl-11" placeholder="Search rooms, areas, curators" type="search" aria-label="Search rooms" />
        </div>
      </PageHeader>

      <div className="flex min-w-0 flex-col gap-6 px-4 pt-3 pb-[calc(var(--nav-h)+2rem)] sm:px-8 sm:pb-12">
        <div className="-ml-2"><Button variant="text" icon={IconArrowLeft} onClick={() => nav("/rosters")}>Community</Button></div>
        <div className="flex min-w-0 flex-col gap-4 rounded-lg bg-surface-low p-4">
          <p className="min-w-0 break-words type-body-m">
            <span className="type-title-s">{roster.city}</span> · {roster.rooms.length} room{roster.rooms.length === 1 ? "" : "s"} · {followers} follower{followers === 1 ? "" : "s"}
          </p>
          <p className="min-w-0 break-words type-body-s text-on-surface-variant">
            Maintained by {maintainerNames(roster)}. Version {roster.version}, updated {ago(roster.updatedAt)}.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button icon={IconImport} onClick={() => setImporting(true)}>Import</Button>
            <Button icon={follow ? IconUserCheck : IconAdd} variant={follow ? "tonal" : "outlined"} onClick={() => void toggleFollow()} loading={busy}>{follow ? "Following" : "Follow"}</Button>
          </div>
        </div>

        {update && follow && (
          <section aria-label="Update available" className="flex min-w-0 flex-col gap-3 rounded-lg bg-primary-container p-4 text-on-primary-container">
            <div className="flex min-w-0 items-center gap-2">
              <span className="inline-flex h-7 flex-none items-center rounded-sm bg-primary px-2.5 type-label-m whitespace-nowrap text-on-primary">Update available</span>
              <span className="min-w-0 truncate type-label-l">Version {roster.version} (you saw {follow.seenVersion})</span>
            </div>
            {news.length > 0 && (
              <ul className="list-disc pl-5 type-body-m">
                {news.slice(0, 4).map((c) => <li key={c.version} className="break-words">{c.text}</li>)}
              </ul>
            )}
            <p className="type-body-m">{pending === 0 ? "Your rooms already match it." : `${pending} change${pending === 1 ? "" : "s"} would reach your rooms. You choose which to take.`}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setImporting(true)} disabled={pending === 0}>Review changes</Button>
              <Button size="sm" variant="text" onClick={() => void markSeen(user.uid, roster.id, roster.version).then(() => toast("Skipped this update"))}>{pending === 0 ? "Got it" : "Skip this update"}</Button>
            </div>
          </section>
        )}

        <SuggestionsQueue roster={roster} suggestions={sug.data} maintainer={maintainer} user={user} />

        {(roster.changelog?.length ?? 0) > 0 && (
          <details className="rounded-lg bg-surface-low p-4">
            <summary className="min-h-6 cursor-pointer type-title-s">What changed lately</summary>
            <ul className="mt-3 flex min-w-0 flex-col gap-2">
              {roster.changelog!.slice(0, 8).map((c) => (
                <li key={c.version} className="min-w-0 break-words type-body-m">
                  <span className="text-on-surface-variant tabular">v{c.version}, {ago(c.at)}: </span>{c.text}
                </li>
              ))}
            </ul>
          </details>
        )}

        {shown.length === 0 ? (
          <Empty icon={IconSearch} title={roster.rooms.length ? "No rooms match" : "No rooms yet"}>{roster.rooms.length ? "Try a different name, area or curator." : "This roster has no rooms."}</Empty>
        ) : (
          shown.map((g) => (
            <section key={g.area || "none"} aria-label={g.area || "No area"} className="min-w-0">
              <h2 className="mb-3 flex items-baseline gap-2 type-title-m text-on-surface-variant">
                <span className="min-w-0 truncate">{g.area || "No area"}</span>
                <span className="type-label-m tabular">{g.rooms.length}</span>
              </h2>
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
                {g.rooms.map((r) => (
                  <li key={r.id} className="min-w-0"><RoomCard room={r} curators={curators} date={date} readOnly onOpen={() => setViewing(r as unknown as RoomShared)} /></li>
                ))}
              </ul>
            </section>
          ))
        )}
        <div>
          <Button variant="tonal" icon={IconPen} onClick={() => setSuggesting({ room: null })}>Suggest a room that's missing</Button>
        </div>
      </div>

      <RoomView room={viewing} curators={roster.curators} onClose={() => setViewing(null)} onSuggest={(r) => { setViewing(null); setSuggesting({ room: r }); }} />
      <SuggestSheet roster={roster} room={suggesting?.room ?? null} open={suggesting !== null} onClose={() => setSuggesting(null)} user={user} />
      <ImportSheet
        incoming={importing ? { roster: { rooms: roster.rooms, curators: roster.curators } as Roster, source: `${roster.title} (version ${roster.version})` } : null}
        onClose={() => setImporting(false)}
        onApplied={() => { if (follow) void markSeen(user.uid, roster.id, roster.version); }}
      />
      {owner && <MaintainersSheet roster={roster} open={people} onClose={() => setPeople(false)} />}
      {owner && <PublishSheet initialId={roster.id} open={publishing} onClose={() => setPublishing(false)} user={user} />}
      <ConfirmDialog
        open={confirmUnpublish}
        onClose={() => setConfirmUnpublish(false)}
        title={`Unpublish ${roster.title}?`}
        confirmLabel="Unpublish"
        onConfirm={async () => {
          await unpublishRoster(roster.id);
          toast(`Unpublished ${roster.title}`);
          setConfirmUnpublish(false);
          nav("/rosters");
        }}
      >
        It disappears for everyone who follows it. Rooms people already imported stay in their lists.
      </ConfirmDialog>
    </div>
  );
}
