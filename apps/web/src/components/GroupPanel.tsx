import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { toast } from "sonner";
import { formatTime, groupModeOf, groupPanel, type GroupRow, type GroupTag, type Lineup, type Show } from "@spot/shared";
import { useApp } from "../lib/app";
import { runCommand, timeAgo, useNow } from "../lib/data";
import { setGroupLeaving, tagMember, untagMember, withSelf } from "../lib/lineup";
import { Menu, MenuItem } from "./Menu";
import { ConfirmDialog } from "./ConfirmDialog";
import { Popover, ToolButton } from "./Popover";
import { Pill, PillRow, type PillSpec } from "./Pills";
import { Avatar, Button, IconButton, Select, Spinner, TextInput, cx } from "./ui";
import { IconAdd, IconCrown, IconGroup, IconMenuDots, IconMic, IconRefresh, IconSearch, IconShield, IconStar, IconUserMinus } from "./icons";

/** Who they are to this show, and what the next sync does with them. */
const TAGS: Record<GroupTag, Omit<PillSpec, "key">> = {
  admin: { label: "Admin", tone: "primary", icon: IconShield },
  cohost: { label: "Co-host", tone: "warn", icon: IconCrown },
  regular: { label: "Regular", tone: "secondary", icon: IconStar },
  lineup: { label: "On lineup", tone: "fact", icon: IconMic },
  joining: { label: "Joining", tone: "joining", icon: IconMic },
  leaving: { label: "Leaving", tone: "error", icon: IconUserMinus },
};
export const tagPills = (tags: GroupTag[]): PillSpec[] => tags.map((t) => ({ key: t, ...TAGS[t] }));

const RANK: Record<GroupTag, number> = { joining: 0, lineup: 1, cohost: 2, admin: 3, regular: 4, leaving: 6 };
const rankOf = (r: GroupRow) => (r.tags.includes("leaving") ? 6 : Math.min(...r.tags.map((t) => RANK[t]), 5));

/** The cached WhatsApp members of a show, tagged against its lineup. Shared by the column popover and the Waiting "Group" tab. */
export function useGroupRows(show: Show, ids: string[], lineup?: Lineup) {
  const { comicsById, session } = useApp();
  const raw = show.groupId && show.groupMembers?.groupId === show.groupId ? show.groupMembers : null;
  const cache = useMemo(() => (raw ? { ...raw, members: withSelf(raw.members, session) } : null), [raw, session]);
  const names = useMemo(() => new Map((cache?.members ?? []).map((m) => [m.id, m.name])), [cache]);
  const nameOf = (id: string) => comicsById.get(id)?.name ?? names.get(id) ?? `+${id.split("@")[0]}`;
  const leaving = lineup?.groupLeaving ?? [];
  const panel = useMemo(
    () => groupPanel({ members: cache?.members ?? [], lineup: ids, regulars: show.regulars ?? [], protected: show.protected ?? [], forceRemove: leaving }),
    [cache, ids, show.regulars, show.protected, leaving],
  );
  const rows = useMemo(() => [...panel.rows].sort((a, b) => rankOf(a) - rankOf(b) || nameOf(a.id).localeCompare(nameOf(b.id))), [panel.rows, names, comicsById]); // eslint-disable-line react-hooks/exhaustive-deps
  return { cache, nameOf, leaving, panel, rows };
}

const modeLabel = (show: Show, lineup?: Lineup) => {
  const mode = groupModeOf(show);
  return mode === "manual" ? "Syncs when you press sync" : mode === "confirm" ? "Syncs when you confirm" : `Syncs on show day, ${formatTime(show.showDaySyncTime ?? "12:00")}${lineup?.showDaySyncedOn ? " (done)" : ""}`;
};

/**
 * A show's WhatsApp group, from a toolbar icon: members and their tags, what a sync would do, refresh and sync.
 * Dragging members onto a lineup happens in the Waiting column's Group tab. This stays mounted (closed) so a member
 * dropped on the Leaving zone there can still raise its confirmation here.
 */
export function GroupPopover({ show, lineup, ids, pendingLeave, onLeaveHandled, onRemoveFromLineup, onAddToLineup, onSync, onReview }: { show: Show; lineup?: Lineup; ids: string[]; pendingLeave: string | null; onLeaveHandled: () => void; onRemoveFromLineup: (cid: string) => void; onAddToLineup?: (cid: string, name: string) => void; onSync: () => Promise<void>; onReview: () => void }) {
  const { uid, week } = useApp();
  const now = useNow(30_000);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [warn, setWarn] = useState<GroupRow | null>(null);
  const { cache, nameOf, leaving, panel, rows } = useGroupRows(show, ids, lineup);

  const kept = new Set(panel.kept);
  const stayers = panel.rows.filter((r) => kept.has(r.id));
  const staying = stayers.filter((r) => r.tags.includes("regular") || r.tags.includes("cohost")).length;
  const adminsOnly = stayers.length - staying;
  const preview = `+${panel.toAdd.length} add, −${panel.toRemove.length} remove${cache ? `, ${staying} regular${staying === 1 ? "" : "s"} and co-host${staying === 1 ? "" : "s"} stay${adminsOnly ? `, ${adminsOnly} admin${adminsOnly === 1 ? "" : "s"} stay` : ""}` : ""}`;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await runCommand(uid, "list_group_members", { showId: show.id }, 3 * 60_000);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  const sync = async () => {
    setSyncing(true);
    try {
      await onSync();
    } finally {
      setSyncing(false);
    }
  };

  const toggleTag = (id: string, tag: "regulars" | "protected", on: boolean) => void tagMember(uid, show, id, tag, on).catch((e: Error) => toast.error(e.message));
  const askLeave = (row: GroupRow) => {
    if (row.tags.includes("lineup") || row.tags.includes("joining")) return toast("They're on the lineup. Take them off it first.");
    if (row.tags.includes("leaving")) return toast(`${nameOf(row.id)} is already leaving on the next sync`);
    if (row.tags.some((t) => t === "admin" || t === "cohost" || t === "regular")) return setWarn(row);
    toast("We can't match this number to a comic, so a sync keeps them.");
  };
  const leave = async (row: GroupRow) => {
    if (row.tags.includes("cohost") || row.tags.includes("regular")) await untagMember(uid, show, row.id);
    if (row.isAdmin) await setGroupLeaving(uid, week, show, [...new Set([...leaving, row.id])]);
    toast.success(`${nameOf(row.id)} will leave the group on the next sync`);
  };
  // A member dropped on the Leaving zone in the Waiting column's Group tab.
  useEffect(() => {
    if (!pendingLeave) return;
    const row = rows.find((r) => r.id === pendingLeave);
    onLeaveHandled();
    if (row) askLeave(row);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLeave]);

  const status = lineup?.groupSync?.status;
  const reviewWaiting = status === "pending";
  const busy = syncing || status === "computing" || status === "applying";
  const changes = panel.toAdd.length + panel.toRemove.length;

  return (
    <>
      <Popover
        title={`${show.name} group`}
        trigger={(toggle, open) => <ToolButton icon={IconGroup} label={show.groupId ? "WhatsApp group" : "Link a WhatsApp group"} count={show.groupId ? changes : undefined} tone={reviewWaiting ? "attention" : "plain"} active={open} onClick={toggle} />}
      >
        {() =>
          !show.groupId ? (
            <div className="flex flex-col items-start gap-3 pt-1">
              <p className="type-body-m text-on-surface-variant">No WhatsApp group is linked to this show.</p>
              <Link to={`/shows?edit=${show.id}`}>
                <Button size="sm" variant="tonal">Link a group</Button>
              </Link>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate type-body-s text-on-surface-variant">{cache ? `${cache.members.length} members · synced ${timeAgo(cache.at, now)}` : "Members not read yet"}</span>
                <Button size="sm" variant="text" icon={IconRefresh} loading={refreshing} onClick={refresh}>
                  Refresh
                </Button>
              </div>
              <p className="type-body-s text-on-surface-variant">{modeLabel(show, lineup)}</p>

              {cache && (
                <ul className="mt-2 flex max-h-72 flex-col gap-0.5 overflow-y-auto overscroll-contain">
                  {rows.map((r) => (
                    <li key={r.id} className={cx("flex min-h-12 items-center gap-2.5 rounded-md py-1 pl-1", r.tags.includes("leaving") && "opacity-70")}>
                      <Avatar name={nameOf(r.id)} size={28} tone={r.member ? "secondary" : "primary"} />
                      <div className="min-w-0 flex-1">
                        <div className={cx("truncate type-label-l", r.tags.includes("leaving") && "line-through decoration-error/60")}>{nameOf(r.id)}</div>
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {tagPills(r.tags).map((p) => (
                            <Pill key={p.key} tone={p.tone} icon={p.icon}>{p.label}</Pill>
                          ))}
                          {!r.known && <span className="type-body-s text-on-surface-variant">Number unknown</span>}
                        </div>
                      </div>
                      <Menu align="right" trigger={(t) => <IconButton icon={IconMenuDots} label={`Options for ${nameOf(r.id)}`} onClick={t} className="size-9" />}>
                        {(close) =>
                          r.member ? (
                            <>
                              {r.tags.includes("lineup") ? (
                                <MenuItem onClick={() => (close(), onRemoveFromLineup(r.id))}>
                                  Take off this lineup
                                  <span className="block type-body-s text-on-surface-variant">Stays in the group</span>
                                </MenuItem>
                              ) : (
                                onAddToLineup && (
                                  <MenuItem onClick={() => (close(), onAddToLineup(r.id, nameOf(r.id)))}>
                                    Put on this lineup
                                    <span className="block type-body-s text-on-surface-variant">As already told: you gave them the spot</span>
                                  </MenuItem>
                                )
                              )}
                              <MenuItem disabled={!r.known} hint={r.tags.includes("regular") ? "on" : undefined} onClick={() => (close(), toggleTag(r.id, "regulars", !r.tags.includes("regular")))}>
                                Regular
                                <span className="block type-body-s text-on-surface-variant">Always stays in the group</span>
                              </MenuItem>
                              <MenuItem disabled={!r.known} hint={r.tags.includes("cohost") ? "on" : undefined} onClick={() => (close(), toggleTag(r.id, "protected", !r.tags.includes("cohost")))}>
                                Co-host
                                <span className="block type-body-s text-on-surface-variant">Never removed</span>
                              </MenuItem>
                              {leaving.includes(r.id) ? (
                                <MenuItem onClick={() => (close(), void setGroupLeaving(uid, week, show, leaving.filter((x) => x !== r.id)))}>Keep in group</MenuItem>
                              ) : (
                                <MenuItem onClick={() => (close(), askLeave(r))}>Remove from group…</MenuItem>
                              )}
                            </>
                          ) : (
                            <MenuItem onClick={() => (close(), onRemoveFromLineup(r.id))}>Take off the lineup</MenuItem>
                          )
                        }
                      </Menu>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-3 rounded-md bg-surface-high px-3 py-3">
                <p className="type-body-s text-on-surface-variant">{preview}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {reviewWaiting && (
                    <Button size="sm" variant="tonal" onClick={onReview}>
                      Review waiting changes
                    </Button>
                  )}
                  <Button size="sm" variant={reviewWaiting ? "text" : "tonal"} icon={IconGroup} loading={busy} onClick={sync}>
                    Sync group now
                  </Button>
                  {busy && <Spinner className="size-4 text-primary" />}
                </div>
                <p className="mt-2 type-body-s text-on-surface-variant">You review every change before anything happens in the group.</p>
              </div>
            </div>
          )
        }
      </Popover>

      <ConfirmDialog
        open={Boolean(warn)}
        onClose={() => setWarn(null)}
        title={warn ? `Remove ${nameOf(warn.id)}?` : ""}
        confirmLabel="Mark as leaving"
        ack={warn ? `I know ${nameOf(warn.id)} is ${warn.tags.filter((t) => t === "admin" || t === "cohost" || t === "regular").map((t) => TAGS[t].label).join(" and ")}.` : undefined}
        onConfirm={async () => {
          if (warn) await leave(warn);
        }}
      >
        {warn && (
          <>
            <p>
              {nameOf(warn.id)} is {warn.tags.filter((t) => t === "admin" || t === "cohost" || t === "regular").map((t) => `${t === "admin" ? "a WhatsApp " : "a "}${TAGS[t].label}`).join(" and ")} for {show.name}. Syncs normally keep them.
            </p>
            <p>This marks them as leaving{warn.tags.some((t) => t === "cohost" || t === "regular") ? ` and drops their ${warn.tags.filter((t) => t === "cohost" || t === "regular").map((t) => TAGS[t].label).join(" and ")} tag${warn.tags.filter((t) => t === "cohost" || t === "regular").length > 1 ? "s" : ""}` : ""}. They're only removed when you run Sync group and approve it.</p>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}

/* ---------- Waiting column, "Group" tab ---------- */

/**
 * Members of one show's group as draggable tiles. Drop one on any show to put them on that lineup as already told.
 * The ids are `gm:{showId}:{memberId}`, which the board's drag handler already understands.
 */
export function GroupTab({ shows, idsOf, lineupOf, dragging, openShows, onAddTold }: { shows: Show[]; idsOf: (showId: string) => string[]; lineupOf: (showId: string) => Lineup | undefined; dragging: boolean; openShows: Show[]; onAddTold: (cid: string, show: Show, name: string) => void }) {
  const [pick, setPick] = useState(shows[0]?.id ?? "");
  const show = shows.find((s) => s.id === pick) ?? shows[0];
  if (!show) return null;
  return (
    <div className="flex flex-col gap-2">
      {shows.length > 1 && (
        <Select label="Group" value={show.id} onChange={setPick} options={shows.map((s) => ({ value: s.id, label: s.name }))} />
      )}
      <GroupTabBody key={show.id} show={show} ids={idsOf(show.id)} lineup={lineupOf(show.id)} dragging={dragging} openShows={openShows} onAddTold={onAddTold} />
    </div>
  );
}

function GroupTabBody({ show, ids, lineup, dragging, openShows, onAddTold }: { show: Show; ids: string[]; lineup?: Lineup; dragging: boolean; openShows: Show[]; onAddTold: (cid: string, show: Show, name: string) => void }) {
  const { cache, nameOf, rows } = useGroupRows(show, ids, lineup);
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const list = rows.filter((r) => r.member && (!needle || nameOf(r.id).toLowerCase().includes(needle) || r.id.includes(needle.replace(/\D/g, "") || "\u0000")));
  if (!cache) return <p className="rounded-md border border-dashed border-outline-variant px-4 py-6 text-center type-body-s text-on-surface-variant">Members haven't been read yet. Open the group button on {show.name} and press Refresh.</p>;
  return (
    <>
      <div className="relative">
        <IconSearch className="icon pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-on-surface-variant" />
        <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${cache.members.length} members`} aria-label="Search group members" className="h-10 pl-9" />
      </div>
      <ul className="flex max-h-[min(60dvh,520px)] min-h-24 flex-col gap-2 overflow-y-auto overscroll-contain">
        {list.map((r) => (
          <MemberTile key={r.id} show={show} row={r} name={nameOf(r.id)} openShows={openShows} onAddTold={onAddTold} />
        ))}
        {!list.length && <li className="grid min-h-24 place-items-center rounded-md border border-dashed border-outline-variant px-4 text-center type-body-s text-on-surface-variant">{needle ? "No one matches." : "No members."}</li>}
      </ul>
      <LeaveZone showId={show.id} active={dragging} />
    </>
  );
}

export function MemberTileBody({ name, tags, lifted, action }: { name: string; tags: GroupTag[]; lifted?: boolean; action?: React.ReactNode }) {
  return (
    <div className={cx("flex min-h-14 items-center gap-3 rounded-md py-2 pl-3", action ? "pr-1" : "pr-3", lifted ? "bg-surface-highest" : "bg-surface-container")}>
      <Avatar name={name} size={32} tone="secondary" />
      <div className="min-w-0 flex-1">
        <div className="truncate type-title-s">{name}</div>
        <PillRow pills={tagPills(tags)} className="mt-0.5" />
      </div>
      {action && (
        <span onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          {action}
        </span>
      )}
    </div>
  );
}

function MemberTile({ show, row, name, openShows, onAddTold }: { show: Show; row: GroupRow; name: string; openShows: Show[]; onAddTold: (cid: string, show: Show, name: string) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `gm:${show.id}:${row.id}`, data: { name, tags: row.tags } });
  return (
    <li ref={setNodeRef} className={cx("cursor-grab select-none [-webkit-touch-callout:none] active:cursor-grabbing", isDragging && "opacity-30")} {...attributes} {...listeners}>
      <MemberTileBody
        name={name}
        tags={row.tags}
        action={
          <Menu align="right" trigger={(t) => <IconButton icon={IconAdd} label={`Put ${name} on a show`} onClick={t} className="size-9" />}>
            {(close) =>
              openShows.length ? (
                openShows.map((s) => (
                  <MenuItem key={s.id} onClick={() => (close(), onAddTold(row.id, s, name))}>
                    {s.name}
                    <span className="block type-body-s text-on-surface-variant">As already told</span>
                  </MenuItem>
                ))
              ) : (
                <MenuItem disabled onClick={() => undefined}>No open shows</MenuItem>
              )
            }
          </Menu>
        }
      />
    </li>
  );
}

function LeaveZone({ showId, active }: { showId: string; active: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `leave:${showId}` });
  return (
    <div ref={setNodeRef} className={cx("grid min-h-11 place-items-center rounded-md border border-dashed px-4 py-2.5 text-center type-body-s text-balance transition-colors duration-150", isOver ? "border-error bg-error-container text-on-error-container" : active ? "border-error/60 text-error" : "border-outline-variant text-on-surface-variant/70")}>
      <span className="hidden sm:inline">Drag here to take someone out on the next sync</span>
      <span className="sm:hidden">Remove from group: use the group button</span>
    </div>
  );
}
