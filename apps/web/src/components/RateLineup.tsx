// After a show that happened: who performed, and how each did (1-5). Collapsed it's one line; open, a picker per comic.
import { useState } from "react";
import { toast } from "sonner";
import { isRating, type Lineup } from "@spot/shared";
import { IconStar } from "@spot/ui";
import { useApp } from "../lib/app";
import { rateSpot } from "../lib/ratings";
import { RatingPicker } from "./RatingPicker";
import { ComicAvatar } from "../lib/photos";

const first = (name: string) => name.split(" ")[0];

export function RateLineup({ lineup, listNames }: { lineup: Lineup; listNames: (names: string[]) => string }) {
  const { uid, comicsById } = useApp();
  const [open, setOpen] = useState(false);
  const name = (id: string) => comicsById.get(id)?.name ?? "A comic";
  const done = lineup.slots.filter((s) => isRating(s.rating)).length;
  return (
    <div className="mt-3">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 type-body-s text-on-surface-variant">
          Performed: {listNames(lineup.slots.map((s) => first(name(s.comicId))))}
          {done > 0 && <span className="whitespace-nowrap"> · rated {done}/{lineup.slots.length}</span>}
        </p>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="-my-1.5 inline-flex min-h-9 flex-none items-center gap-1 rounded-full px-3 type-label-l text-primary hover:bg-surface-high focus-visible:outline-2 focus-visible:outline-primary"
        >
          <IconStar className="icon size-4" />
          {open ? "Done" : done === lineup.slots.length ? "Ratings" : "Rate"}
        </button>
      </div>
      {open && (
        <ul className="mt-2 flex flex-col gap-1 rounded-md bg-surface-container p-2">
          {lineup.slots.map((s) => (
            <li key={s.comicId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 py-1">
              <span className="flex min-w-0 basis-32 flex-1 items-center gap-2">
                <ComicAvatar id={s.comicId} name={name(s.comicId)} size={28} />
                <span className="min-w-0 truncate type-body-m">{name(s.comicId)}</span>
              </span>
              <RatingPicker
                label={`How ${name(s.comicId)} did`}
                value={s.rating}
                onChange={(v) => void rateSpot(uid, { comicId: s.comicId, showId: lineup.showId, date: lineup.date, lineupId: lineup.id }, v).catch((e: Error) => toast.error(e.message))}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
