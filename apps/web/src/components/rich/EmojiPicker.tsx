// Curated emoji grid: category tabs, search by name, tap to insert. Lives inside a Popover (a sheet on phones).
import { useId, useState } from "react";
import { cx, TextInput } from "../ui";
import { EMOJI_GROUPS, searchEmoji } from "./emojiData";

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [q, setQ] = useState("");
  const [group, setGroup] = useState(EMOJI_GROUPS[0].id);
  const id = useId();
  const found = q.trim() ? searchEmoji(q) : null;
  const items = found ?? EMOJI_GROUPS.find((g) => g.id === group)!.items;
  return (
    <div className="flex flex-col gap-3">
      <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, like mic or clap" aria-label="Search emoji" className="h-10" />
      {!found && (
        <div className="flex flex-wrap gap-0.5" role="tablist" aria-label="Emoji categories">
          {EMOJI_GROUPS.map((g) => (
            <button
              key={g.id}
              role="tab"
              aria-selected={g.id === group}
              aria-controls={id}
              title={g.label}
              aria-label={g.label}
              onClick={() => setGroup(g.id)}
              className={cx("state-layer pressable grid size-9 place-items-center rounded-sm text-lg", g.id === group && "bg-secondary-container")}
            >
              {g.icon}
            </button>
          ))}
        </div>
      )}
      <div id={id} role="tabpanel" className="grid grid-cols-7 gap-0.5 sm:grid-cols-8">
        {items.map((x) => (
          <button key={x.e + x.name} type="button" onClick={() => onPick(x.e)} title={x.name} aria-label={x.name} className="state-layer pressable grid aspect-square place-items-center rounded-sm text-2xl">
            {x.e}
          </button>
        ))}
      </div>
      {found && !found.length && <p className="type-body-s text-on-surface-variant">No emoji called “{q.trim()}”. Try a simpler word.</p>}
      {!found && <p className="type-label-s text-on-surface-variant">{EMOJI_GROUPS.find((g) => g.id === group)!.label}</p>}
    </div>
  );
}
