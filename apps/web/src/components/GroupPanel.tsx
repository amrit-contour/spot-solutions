import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { groupPanel, type GroupRow, type GroupTag, type Lineup, type Show } from "@spot/shared";
import { useApp } from "../lib/app";
import { runCommand, timeAgo, useNow } from "../lib/data";
import { setGroupLeaving, tagMember, untagMember } from "../lib/lineup";
import { Menu, MenuItem } from "./Menu";
import { ConfirmDialog } from "./ConfirmDialog";
import { Avatar, Button, IconButton, Spinner, cx } from "./ui";
import { IconArrowDown, IconCrown, IconGroup, IconMenuDots, IconMic, IconRefresh, IconShield, IconStar, IconUserMinus } from "./icons";

/** Subtle tags from the M3 container tokens: who they are to this show, and what the next sync does with them. */
const TAGS: Record<GroupTag, { label: string; cls: string; icon: typeof IconStar }> = {
  admin: { label: "Admin", cls: "bg-primary-container text-on-primary-container", icon: IconShield },
  cohost: { label: "Co-host", cls: "bg-tertiary-container text-on-tertiary-container", icon: IconCrown },
  regular: { label: "Regular", cls: "bg-secondary-container text-on-secondary-container", icon: IconStar },
  lineup: { label: "On lineup", cls: "bg-surface-highest text-on-surface", icon: IconMic },
  joining: { label: "Joining", cls: "border border-dashed border-primary text-primary", icon: IconMic },
  leaving: { label: "Leaving", cls: "bg-error-container text-on-error-container", icon: IconUserMinus },
};

function TagPill({ tag }: { tag: GroupTag }) {
  const t = TAGS[tag];
  return (
    <motion.span layout="position" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className={cx("inline-flex h-5 items-center gap-1 rounded-sm px-1.5 type-label-m whitespace-nowrap", t.cls)}>
      <t.icon className="icon -ml-0.5 size-3.5" />
      {t.label}
    </motion.span>
  );
}

const RANK: Record<GroupTag, number> = { joining: 0, lineup: 1, cohost: 2, admin: 3, regular: 4, leaving: 6 };
const rankOf = (r: GroupRow) => (r.tags.includes("leaving") ? 6 : Math.min(...r.tags.map((t) => RANK[t]), 5));

/**
 * A show's WhatsApp group inside its column: who's in it, how they're tagged, and what a sync would do.
 * Drop a Waiting comic anywhere on the panel to put them on the lineup (and so, after a sync, in the group).
 * Drag a member to the Leaving zone, or use their menu, to take them out on the next sync.
 */
export function GroupPanel({ show, lineup, ids, dragging, pendingLeave, onLeaveHandled, onRemoveFromLineup, onSync, onReview }: { show: Show; lineup?: Lineup; ids: string[]; dragging: "member" | "tile" | null; pendingLeave: string | null; onLeaveHandled: () => void; onRemoveFromLineup: (cid: string) => void; onSync: () => Promise<void>; onReview: () => void }) {
  const { uid, week, comicsById } = useApp();
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [warn, setWarn] = useState<GroupRow | null>(null);
  const { setNodeRef, isOver } = useDroppable({ id: `group:${show.id}` });
  const cache = show.groupId && show.groupMembers?.groupId === show.groupId ? show.groupMembers : null;
  const names = useMemo(() => new Map((cache?.members ?? []).map((m) => [m.id, m.name])), [cache]);
  const nameOf = (id: string) => comicsById.get(id)?.name ?? names.get(id) ?? `+${id.split("@")[0]}`;
  const leaving = lineup?.groupLeaving ?? [];

  const panel = useMemo(
    () => groupPanel({ members: cache?.members ?? [], lineup: ids, regulars: show.regulars ?? [], protected: show.protected ?? [], forceRemove: leaving }),
    [cache, ids, show.regulars, show.protected, leaving],
  );
  const rows = useMemo(() => [...panel.rows].sort((a, b) => rankOf(a) - rankOf(b) || nameOf(a.id).localeCompare(nameOf(b.id))), [panel.rows, names, comicsById]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Tag menus are the tap alternative to dragging.
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
  useEffect(() => {
    if (!pendingLeave) return;
    const row = rows.find((r) => r.id === pendingLeave);
    onLeaveHandled();
    if (row) {
      setOpen(true);
      askLeave(row);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLeave]);

  if (!show.groupId) {
    return (
      <div className="mt-3 flex items-center gap-3 rounded-md border border-dashed border-outline-variant px-3 py-3">
        <IconGroup className="icon size-5 flex-none text-on-surface-variant" />
        <p className="min-w-0 flex-1 type-body-s text-on-surface-variant">No WhatsApp group linked to this show.</p>
        <Link to={`/shows?edit=${show.id}`}>
          <Button size="sm" variant="tonal">Link a group</Button>
        </Link>
      </div>
    );
  }

  const status = lineup?.groupSync?.status;
  const reviewWaiting = status === "pending";
  const busy = syncing || status === "computing" || status === "applying";
  const dropTarget = dragging === "tile";

  return (
    <div ref={setNodeRef} className={cx("mt-3 rounded-md bg-surface-container transition-[box-shadow] duration-150", dropTarget && "shadow-[inset_0_0_0_1px_var(--md-sys-color-outline-variant)]", isOver && dropTarget && "shadow-[inset_0_0_0_2px_var(--md-sys-color-primary)]")}>
      <div className="flex items-center gap-1 pr-1">
        <button onClick={() => setOpen(!open)} aria-expanded={open} className="state-layer flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-md px-3 text-left">
          <IconGroup className="icon size-5 flex-none text-primary" />
          <span className="min-w-0 flex-1">
            <span className="block truncate type-title-s">
              Group{cache ? ` · ${cache.members.length} member${cache.members.length === 1 ? "" : "s"}` : ""}
            </span>
            <span className="block truncate type-body-s text-on-surface-variant">{dropTarget ? "Drop to add to the lineup and the group" : cache ? `+${panel.toAdd.length} add · −${panel.toRemove.length} remove` : "Members not read yet"}</span>
          </span>
          <IconArrowDown className={cx("icon size-5 flex-none text-on-surface-variant transition-transform duration-200", open && "rotate-180")} />
        </button>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }} className="overflow-hidden">
            <div className="px-3 pb-3">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate type-body-s text-on-surface-variant">{cache ? `Synced ${timeAgo(cache.at, now)}` : "Read the members to see who's in the group"}</span>
                <Button size="sm" variant="text" icon={IconRefresh} loading={refreshing} onClick={refresh}>
                  Refresh
                </Button>
              </div>

              {cache && (
                <ul className="mt-1 flex max-h-72 flex-col gap-0.5 overflow-y-auto overscroll-contain">
                  <AnimatePresence initial={false}>
                    {rows.map((r) => (
                      <MemberRow
                        key={r.id}
                        show={show}
                        row={r}
                        name={nameOf(r.id)}
                        forced={leaving.includes(r.id)}
                        menu={
                          <Menu align="right" trigger={(t) => <IconButton icon={IconMenuDots} label={`Options for ${nameOf(r.id)}`} onClick={t} className="size-9" />}>
                            {(close) => (
                              <>
                                {r.member ? (
                                  <>
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
                                )}
                              </>
                            )}
                          </Menu>
                        }
                      />
                    ))}
                  </AnimatePresence>
                </ul>
              )}

              {cache && <LeaveZone showId={show.id} active={dragging === "member"} />}

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
          </motion.div>
        )}
      </AnimatePresence>

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
    </div>
  );
}

function MemberRow({ show, row, name, forced, menu }: { show: Show; row: GroupRow; name: string; forced: boolean; menu: React.ReactNode }) {
  // Joining rows are lineup comics who aren't members yet: nothing to drag out of the group.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `gm:${show.id}:${row.id}`, disabled: !row.member });
  const leaving = row.tags.includes("leaving");
  return (
    <motion.li
      ref={setNodeRef}
      layoutId={`gm-${show.id}-${row.id}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: isDragging ? 0.3 : 1 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={{ type: "spring", duration: 0.35, bounce: 0.15 }}
      className={cx("flex min-h-12 select-none items-center gap-2.5 rounded-md py-1 pl-1 [-webkit-touch-callout:none]", row.member && "cursor-grab active:cursor-grabbing", leaving && "opacity-70")}
      {...attributes}
      {...listeners}
    >
      <Avatar name={name} size={28} tone={row.member ? "secondary" : "primary"} />
      <div className="min-w-0 flex-1">
        <div className={cx("truncate type-label-l", leaving && "line-through decoration-error/60")}>{name}</div>
        <div className="mt-0.5 flex flex-wrap gap-1">
          <AnimatePresence initial={false}>
            {row.tags.map((t) => (
              <TagPill key={t} tag={t} />
            ))}
          </AnimatePresence>
          {!row.known && <span className="type-body-s text-on-surface-variant">Number unknown</span>}
          {forced && <span className="sr-only">Marked to leave</span>}
        </div>
      </div>
      <span onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        {menu}
      </span>
    </motion.li>
  );
}

function LeaveZone({ showId, active }: { showId: string; active: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `leave:${showId}` });
  return (
    <div ref={setNodeRef} className={cx("mt-2 grid h-10 place-items-center rounded-md border border-dashed type-body-s transition-colors duration-150", isOver ? "border-error bg-error-container text-on-error-container" : active ? "border-error/60 text-error" : "border-outline-variant text-on-surface-variant/70")}>
      <span className="hidden sm:inline">Drag a member here to take them out on the next sync</span>
      <span className="sm:hidden">Use ⋯ to remove someone</span>
    </div>
  );
}
