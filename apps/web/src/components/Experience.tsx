import { useMemo } from "react";
import { EXPERIENCE_TAGS, experienceLabel, experienceOf, spotsByYear, type Comic, type ExperienceResult, type ExperienceThresholds } from "@spot/shared";
import { Chip, Field, TextInput, cx } from "@spot/ui";
import { IconArrowDown, IconCrown, IconStar } from "@spot/ui";

type Exp = Pick<Comic, "comedySince" | "history" | "tagsPinned" | "tagsHidden">;

/** The tag worth showing in a tight spot (a roster row, a request card): Killer, then Senior, Beginner, New. */
export function topTag(e: Pick<ExperienceResult, "tags">): string | null {
  for (const t of ["Killer", "Senior", "Beginner", "New"]) if (e.tags.includes(t)) return t;
  return e.tags[0] ?? null;
}

const TAG_TONE: Record<string, "tertiary" | "primary" | "success" | "neutral"> = { Killer: "tertiary", Senior: "primary", Beginner: "success", New: "neutral" };

/** A small experience chip (Killer with a crown). Nothing when there's no tag. */
export function ExperienceChip({ tag }: { tag: string | null }) {
  if (!tag) return null;
  return (
    <Chip tone={TAG_TONE[tag] ?? "neutral"} icon={tag === "Killer" ? IconCrown : undefined}>
      {tag}
    </Chip>
  );
}

/**
 * The experience card in the comic editor: "doing comedy since" (a month picker), years on the mic (ticks up by itself),
 * spots done, average rating with its trend, the tags (tap to pin or hide), and spots per year.
 */
export function ExperienceCard({ comic, onChange, thresholds, now }: { comic: Exp; onChange: (patch: Partial<Exp>) => void; thresholds?: ExperienceThresholds; now: Date }) {
  const e = useMemo(() => experienceOf(comic, now, thresholds), [comic, now, thresholds]);
  const years = useMemo(() => spotsByYear(comic.history, now), [comic.history, now]);
  const label = experienceLabel(e);
  const pinned = new Set(comic.tagsPinned ?? []);
  const hidden = new Set(comic.tagsHidden ?? []);

  // A shown tag (computed or pinned) is turned off: unpin it, and hide it if the data would add it back. A hidden one is turned on.
  const toggle = (t: string) => {
    const shown = e.tags.includes(t);
    const p = new Set(pinned);
    const h = new Set(hidden);
    if (shown) {
      p.delete(t);
      if (e.computed.includes(t)) h.add(t);
    } else {
      h.delete(t);
      if (!e.computed.includes(t)) p.add(t);
    }
    onChange({ tagsPinned: [...p], tagsHidden: [...h] });
  };
  const max = Math.max(1, ...years.map((y) => y.spots));

  return (
    <section className="rounded-lg bg-surface-container p-4">
      <h3 className="mb-3 type-title-s">Experience</h3>
      <dl className="grid grid-cols-3 gap-2 text-center">
        <Stat label="On the mic" value={e.inactiveSince ? "Inactive" : (label ?? "—")} />
        <Stat label="Spots" value={String(e.spots)} />
        <Stat
          label={e.rated ? `Avg of ${e.rated}` : "Rating"}
          value={
            e.averageRating === null ? (
              "—"
            ) : (
              <span className="inline-flex items-center gap-1">
                <IconStar className="icon size-4 text-tertiary" />
                {e.averageRating.toFixed(1)}
                {e.trend && e.trend !== "steady" && <IconArrowDown aria-label={e.trend === "up" ? "Trending up" : "Trending down"} className={cx("icon size-4", e.trend === "up" ? "rotate-180 text-primary" : "text-error")} />}
              </span>
            )
          }
        />
      </dl>
      {e.inactiveSince && <p className="mt-2 type-body-s text-on-surface-variant">No spot since {e.inactiveSince}.</p>}

      <div className="mt-4">
        <Field label="Doing comedy since" hint={label ? `${label} so far. This counts up by itself.` : "Month they started. Years on the mic then count up by themselves."}>
          <TextInput type="month" value={(comic.comedySince ?? "").length === 4 ? `${comic.comedySince}-01` : (comic.comedySince ?? "")} max={now.toISOString().slice(0, 7)} onChange={(ev) => onChange({ comedySince: ev.target.value || undefined })} />
        </Field>
      </div>

      <div className="mt-4">
        <div className="mb-1.5 type-label-l text-on-surface-variant">Tags</div>
        <div className="flex flex-wrap gap-1.5">
          {EXPERIENCE_TAGS.map((t) => (
            <Chip key={t} selected={e.tags.includes(t)} onClick={() => toggle(t)} icon={pinned.has(t) ? IconStar : t === "Killer" ? IconCrown : undefined} title={pinned.has(t) ? "Pinned by you" : hidden.has(t) ? "Hidden by you" : e.computed.includes(t) ? "From their spots and ratings" : "Tap to pin"}>
              {t}
            </Chip>
          ))}
        </div>
        <p className="mt-1.5 type-body-s text-on-surface-variant">Worked out from their spots and ratings. Tap a tag to pin it or hide it.</p>
      </div>

      {years.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 type-label-l text-on-surface-variant">Spots per year</div>
          <ul className="flex flex-col gap-1">
            {years.map((y) => (
              <li key={y.year} className="flex items-center gap-2">
                <span className="w-10 type-label-m tabular text-on-surface-variant">{y.year}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-highest">
                  <span className="block h-full rounded-full bg-primary" style={{ width: `${(y.spots / max) * 100}%` }} />
                </span>
                <span className="w-6 text-right type-label-m tabular">{y.spots}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md bg-surface-low px-2 py-2.5">
      <dt className="type-label-s text-on-surface-variant">{label}</dt>
      <dd className="mt-0.5 type-title-m tabular">{value}</dd>
    </div>
  );
}
