// The show editor's POC / regular / co-host picker. Type-first: nothing is listed until something is typed. Each result is one
// person (duplicate comic docs are merged into a row by phone / @lid), with a masked number to tell similar names apart, an
// "In group" mark when they are in the show's WhatsApp group, and a pill for any role they already have on this show.
import { useMemo, useState } from "react";
import { PEOPLE_SEARCH_HINT, pickerRows, searchPeople, type Comic, type GroupMember, type PickerRole, type PickerRow } from "@spot/shared";
import { Chip, cx } from "@spot/ui";
import { IconCrown, IconGroup, IconStar, IconUserCheck, type Icon } from "@spot/ui";
import { SearchField } from "./PeopleSearch";
import { Pill, type PillTone } from "./Pills";

const ROLE: Record<PickerRole, { label: string; tone: PillTone; icon: Icon }> = {
  poc: { label: "POC", tone: "warn", icon: IconUserCheck },
  cohost: { label: "Co-host", tone: "warn", icon: IconCrown },
  regular: { label: "Regular", tone: "secondary", icon: IconStar },
};

const LIMIT = 8;

export function ShowPeoplePicker({ label, comics, selected, onToggle, icon, members, roles }: {
  label: string;
  comics: readonly Comic[];
  selected: readonly string[];
  /** Tapped a person: all their doc ids, so duplicates are added and removed together. */
  onToggle: (ids: string[], representative: string) => void;
  icon: Icon;
  /** The show group's members (null: not read yet, so "In group" can't be shown). */
  members: readonly GroupMember[] | null;
  roles: { pocs?: readonly string[]; regulars?: readonly string[]; cohosts?: readonly string[] };
}) {
  const [q, setQ] = useState("");
  const [groupOnly, setGroupOnly] = useState(false);
  const rows = useMemo(() => pickerRows(comics, { members: members ?? [], pocs: roles.pocs, regulars: roles.regulars, cohosts: roles.cohosts }), [comics, members, roles.pocs, roles.regulars, roles.cohosts]);
  const sel = new Set(selected);
  const isChosen = (r: PickerRow) => r.ids.some((i) => sel.has(i));
  const typing = Boolean(q.trim());
  // Type-first: only who's already chosen is shown until something is typed. "In this group" is an explicit way to browse.
  const chosen = rows.filter(isChosen).sort((a, b) => a.name.localeCompare(b.name));
  const pool = rows.filter((r) => !isChosen(r) && (!groupOnly || r.inGroup));
  const all = typing ? searchPeople(pool, q, 40) : groupOnly ? [...pool].sort((a, b) => a.name.localeCompare(b.name)) : [];
  const found = all.slice(0, LIMIT);
  return (
    <div data-keep-visible>
      <div className="mb-2 flex items-center gap-2 type-label-l text-on-surface-variant">
        <span className="min-w-0 flex-1">{label}</span>
        {members && <Chip selected={groupOnly} onClick={() => setGroupOnly(!groupOnly)}>In this group</Chip>}
      </div>
      <SearchField value={q} onChange={setQ} className="h-10" />
      {found.length > 0 && (
        <ul className="mt-2 divide-y divide-outline-variant/50 overflow-hidden rounded-md border border-outline-variant/60">
          {found.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => onToggle(r.ids, r.id)} className="state-layer flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left">
                <span className="min-w-0 flex-1">
                  <span className="block truncate type-title-s">{r.name}</span>
                  <span className={cx("block truncate type-body-s tabular", r.masked ? "text-on-surface-variant" : "text-on-surface-variant/70")}>{r.masked || "Number hidden"}</span>
                </span>
                <span className="flex flex-none flex-wrap items-center justify-end gap-1">
                  {r.roles.map((x) => (
                    <Pill key={x} tone={ROLE[x].tone} icon={ROLE[x].icon}>{ROLE[x].label}</Pill>
                  ))}
                  {r.inGroup && <Pill tone="told" icon={IconGroup} title="In this show's WhatsApp group">In group</Pill>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {all.length > found.length && <p className="mt-1.5 type-body-s text-on-surface-variant">{all.length - found.length} more. Type more of the name or number to narrow it down.</p>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {chosen.map((r) => (
          <Chip key={r.id} selected onClick={() => onToggle(r.ids, r.id)} icon={icon} title={r.masked || undefined}>
            {r.name}
          </Chip>
        ))}
        {(typing || groupOnly) && !all.length && <span className="self-center type-body-s text-on-surface-variant">No one matches.</span>}
        {!typing && !groupOnly && !chosen.length && <span className="self-center type-body-s text-on-surface-variant">{comics.length ? PEOPLE_SEARCH_HINT : "Comics appear here once they message you, or when you add or import them in Comics."}</span>}
      </div>
    </div>
  );
}
