import { askHints, roomFullToday, roomPaused, showSummary, todayAt, type Curator, type Room } from "@spot/shared";
import { Chip, IconBuilding, IconCalendarMark, IconMic, IconClock } from "@spot/ui";
import { CardButton, Chips, IconTile } from "./ui";

const TAG_LABEL = (t: string) => t.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

/** One room: where, when, who's on today and when to ask. Tapping it opens the editor. */
export function RoomCard({ room, curators, date, onOpen, readOnly }: { room: Room; curators: Curator[]; date: string; onOpen: () => void; /** A published room: no edit pencil. */ readOnly?: boolean }) {
  const paused = roomPaused(room, date);
  const full = roomFullToday(room, date);
  const today = todayAt(room, curators, date);
  const hints = askHints(room);
  const myRole = room.shows.some((s) => s.myRole === "curator") ? "I curate here" : room.shows.some((s) => s.myRole === "regular") ? "Regular" : null;
  return (
    <CardButton onClick={onOpen} dim={paused} label={readOnly ? undefined : `Edit ${room.name}`} className="flex flex-col gap-3">
      <span className="flex min-w-0 items-center gap-3">
        <IconTile icon={IconBuilding} />
        <span className="min-w-0 flex-1">
          <span className="block truncate type-title-m">{room.name}</span>
        </span>
        <span className="flex flex-none flex-wrap justify-end gap-1">
          {paused && <Chip tone="reading">Paused</Chip>}
          {full && <Chip tone="error">Full</Chip>}
        </span>
      </span>

      {room.shows.length > 0 ? (
        <span className="flex min-w-0 flex-col gap-1.5">
          {room.shows.slice(0, 3).map((s) => (
            <span key={s.id} className="flex min-w-0 items-center gap-2 type-body-m">
              <IconMic aria-hidden className="icon size-4 flex-none text-on-surface-variant" />
              <span className="min-w-0 truncate">{showSummary(s)}</span>
            </span>
          ))}
          {room.shows.length > 3 && <span className="type-body-s text-on-surface-variant">+{room.shows.length - 3} more</span>}
        </span>
      ) : (
        <span className="type-body-m text-on-surface-variant">{readOnly ? "No shows listed yet." : "No shows yet. Tap to add one."}</span>
      )}

      {today.length > 0 && (
        <span className="flex min-w-0 items-start gap-2 type-body-m">
          <IconCalendarMark aria-hidden className="icon mt-0.5 size-4 flex-none text-primary" />
          <span className="min-w-0">
            <span className="text-on-surface-variant">Today: </span>
            {today.map((t, i) => (
              <span key={t.show.id}>
                {i > 0 && "; "}
                {t.names.length ? t.names.join(" and ") : t.theyReachOut ? "they'll reach out" : "no curator set"}
              </span>
            ))}
          </span>
        </span>
      )}

      {hints.length > 0 && (
        <span className="flex min-w-0 items-start gap-2 type-body-m">
          <IconClock aria-hidden className="icon mt-0.5 size-4 flex-none text-on-surface-variant" />
          <span className="min-w-0 text-on-surface-variant">{hints.slice(0, 2).join(" · ")}{hints.length > 2 ? ` · +${hints.length - 2}` : ""}</span>
        </span>
      )}

      {(room.tags.length > 0 || myRole) && (
        <Chips>
          {myRole && <Chip tone="primary">{myRole}</Chip>}
          {room.tags.slice(0, 4).map((t) => (
            <Chip key={t}>{TAG_LABEL(t)}</Chip>
          ))}
          {room.tags.length > 4 && <Chip>+{room.tags.length - 4}</Chip>}
        </Chips>
      )}
    </CardButton>
  );
}
