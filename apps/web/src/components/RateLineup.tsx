// After a show that happened: who performed and how the review stands (show rating, crowd, notes, how many comics are rated).
// The review itself is edited in the ReviewSheet, opened from the button here.
import { useState } from "react";
import { CROWD_LEVELS, RATING_WORDS, hasReview, reviewProgress, type Lineup, type Show } from "@spot/shared";
import { IconStar } from "@spot/ui";
import { useApp } from "../lib/app";
import { ReviewSheet } from "./ReviewSheet";

const first = (name: string) => name.split(" ")[0];

export function RateLineup({ lineup, show, listNames, performed = true }: { lineup: Lineup; show: Show; listNames: (names: string[]) => string; /** Name who performed (off where the lineup is already listed). */ performed?: boolean }) {
  const { comicsById } = useApp();
  const [open, setOpen] = useState(false);
  const name = (id: string) => comicsById.get(id)?.name ?? "A comic";
  const p = reviewProgress(lineup);
  const crowd = CROWD_LEVELS.find((c) => c.value === lineup.review?.crowd)?.label;
  const touched = hasReview(lineup) || p.rated > 0 || p.noted > 0;
  const bits = [
    p.show ? `Show ${p.show}/5 · ${RATING_WORDS[p.show]}` : null,
    crowd ? `${crowd} crowd` : null,
    p.rated > 0 ? `${p.rated}/${p.total} rated` : null,
    lineup.slots.some((x) => x.attendance === "no_show") ? `${lineup.slots.filter((x) => x.attendance === "no_show").length} no-show` : null,
    lineup.slots.some((x) => x.attendance === "late") ? `${lineup.slots.filter((x) => x.attendance === "late").length} late` : null,
    p.noted > 0 ? `${p.noted} note${p.noted === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return (
    <div className="mt-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {performed ? <p className="type-body-s text-on-surface-variant">Performed: {listNames(lineup.slots.map((s) => first(name(s.comicId))))}</p> : !bits.length && <p className="type-body-s text-on-surface-variant">Not reviewed yet</p>}
          {bits.length > 0 && (
            <p className="mt-0.5 type-label-m text-tertiary">
              {p.show && <IconStar className="icon mr-1 inline size-3.5 align-[-2px]" />}
              {bits.join(" · ")}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="-my-1.5 inline-flex min-h-9 flex-none items-center gap-1 rounded-full px-3 type-label-l text-primary hover:bg-surface-high focus-visible:outline-2 focus-visible:outline-primary"
        >
          <IconStar className="icon size-4" />
          {touched ? "Edit review" : "Review"}
        </button>
      </div>
      {lineup.review?.notes && <p className="mt-1 line-clamp-2 type-body-s text-on-surface-variant">{lineup.review.notes}</p>}
      <ReviewSheet open={open} onClose={() => setOpen(false)} show={show} week={lineup.weekOf} />
    </div>
  );
}
