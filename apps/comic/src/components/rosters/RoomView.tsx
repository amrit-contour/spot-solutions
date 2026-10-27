import { DAY_NAMES, WEEK_ORDER, askRuleFor, askRuleLabel, formatValue, showSummary, timesLabel, type CuratorShared, type RoomShared, type ShowShared } from "@spot/shared";
import { Button, Chip, IconPen, Sheet } from "@spot/ui";
import { ListGroup } from "../ui";

const TAG_LABEL = (t: string) => t.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

function ShowBlock({ show, curators }: { show: ShowShared; curators: CuratorShared[] }) {
  const days = [...show.days].sort((a, b) => WEEK_ORDER.indexOf(a.weekday) - WEEK_ORDER.indexOf(b.weekday));
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="type-title-m">{showSummary(show)}</h3>
      {show.note && <p className="type-body-m text-on-surface-variant">{show.note}</p>}
      <ListGroup>
        {days.map((d) => {
          const who = d.curatorIds.map((id) => curators.find((c) => c.id === id)).filter((c): c is CuratorShared => Boolean(c));
          const rule = askRuleFor(show, d.weekday);
          return (
            <div key={d.weekday} className="flex min-w-0 flex-col gap-0.5 px-4 py-3">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="w-24 flex-none type-label-l text-on-surface-variant">{DAY_NAMES[d.weekday]}</span>
                <span className="min-w-0 flex-1 break-words type-body-l">
                  {d.theyReachOut ? "They'll reach out" : who.length ? who.map((c) => c.name).join(" and ") : "No curator listed"}
                </span>
              </span>
              <span className="pl-[6.5rem] break-words type-body-s text-on-surface-variant">
                {[
                  !d.theyReachOut && who[0]?.phone ? `Ask ${who[0].name} on ${who[0].phone}` : "",
                  d.times?.length ? timesLabel(d.times) : "",
                  rule ? askRuleLabel(rule) : "",
                  d.note ?? "",
                ].filter(Boolean).join(" · ")}
              </span>
            </div>
          );
        })}
        {days.length === 0 && <p className="px-4 py-3 type-body-m text-on-surface-variant">No days listed.</p>}
      </ListGroup>
    </section>
  );
}

/** A published room, read only: shows, who is on each day and how to ask. "Suggest a change" goes to the maintainers. */
export function RoomView({ room, curators, onClose, onSuggest }: { room: RoomShared | null; curators: CuratorShared[]; onClose: () => void; onSuggest?: (room: RoomShared) => void }) {
  return (
    <Sheet
      open={room !== null}
      onClose={onClose}
      title={room?.name ?? ""}
      footer={
        <>
          <Button variant="text" onClick={onClose}>Close</Button>
          {room && onSuggest && <Button icon={IconPen} onClick={() => onSuggest(room)}>Suggest a change</Button>}
        </>
      }
    >
      {room && (
        <div className="flex min-w-0 flex-col gap-6">
          <p className="type-body-l text-on-surface-variant">{[room.area, room.city, room.brand ? `Part of ${room.brand}` : ""].filter(Boolean).join(" · ")}</p>
          {room.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {room.tags.map((t) => <Chip key={t}>{TAG_LABEL(t)}</Chip>)}
            </div>
          )}
          {room.aliases.length > 0 && <p className="type-body-m text-on-surface-variant">Also called {room.aliases.join(", ")}.</p>}
          {room.shows.map((s) => <ShowBlock key={s.id} show={s} curators={curators} />)}
          {room.shows.length === 0 && <p className="type-body-m text-on-surface-variant">No shows listed yet.</p>}
          {room.notes.length > 0 && (
            <section className="min-w-0">
              <h3 className="mb-1 type-title-m">Other ways to ask</h3>
              <p className="break-words type-body-m">{formatValue("notes", room.notes)}</p>
            </section>
          )}
          {room.limits.length > 0 && (
            <section className="min-w-0">
              <h3 className="mb-1 type-title-m">Limits</h3>
              <p className="break-words type-body-m">{formatValue("limits", room.limits)}</p>
            </section>
          )}
        </div>
      )}
    </Sheet>
  );
}
