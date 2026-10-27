import { Link } from "react-router-dom";
import { canMaintain, type PublishedRosterDoc, type RosterFollow } from "@spot/shared";
import { Chip, IconBuilding, IconGroup } from "@spot/ui";
import { hasUpdate } from "../../lib/rosters";

export function ago(at: number, now = Date.now()) {
  const days = Math.floor((now - at) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: days > 300 ? "numeric" : undefined });
}

/** Everyone who looks after a roster, owner first: "Amrit, Sam and Priya". */
export function maintainerNames(r: Pick<PublishedRosterDoc, "ownerName" | "coMaintainers" | "maintainerNames">) {
  const names = [r.ownerName ?? "Owner", ...r.coMaintainers.map((u) => r.maintainerNames?.[u] ?? "a member")];
  return names.length <= 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** One published roster in the browse list. */
export function RosterCard({ roster, follow, followers, uid }: { roster: PublishedRosterDoc; follow?: RosterFollow; followers?: number; uid: string }) {
  const update = hasUpdate(follow, roster);
  const mine = canMaintain(roster, uid);
  return (
    <Link to={`/rosters/${roster.id}`} className="state-layer pressable flex w-full min-w-0 flex-col gap-3 rounded-lg bg-surface-low p-4 text-left">
      <span className="flex min-w-0 items-start gap-3">
        <span className="grid size-10 flex-none place-items-center rounded-md bg-tertiary-container text-on-tertiary-container"><IconBuilding className="icon size-5" /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate type-title-m">{roster.title}</span>
          <span className="block truncate type-body-s text-on-surface-variant">{roster.city} · by {roster.ownerName ?? "a member"}</span>
        </span>
        <span className="flex flex-none flex-wrap justify-end gap-1">
          {update && <Chip tone="primary">Update available</Chip>}
          {!update && follow && <Chip tone="success">Following</Chip>}
          {mine && <Chip tone="tertiary">{roster.ownerUid === uid ? "Yours" : "You maintain"}</Chip>}
        </span>
      </span>
      <span className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 type-body-m sm:grid-cols-2">
        <span className="min-w-0 truncate">{roster.rooms.length} room{roster.rooms.length === 1 ? "" : "s"}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-on-surface-variant">
          <IconGroup aria-hidden className="icon size-4 flex-none" />
          <span className="min-w-0 truncate tabular">{followers ?? 0} follower{followers === 1 ? "" : "s"}</span>
        </span>
      </span>
      <span className="min-w-0 break-words type-body-s text-on-surface-variant">
        Maintained by {maintainerNames(roster)}. Updated {ago(roster.updatedAt)}, version {roster.version}.
      </span>
    </Link>
  );
}
