// A 1-5 rating for how a comic did on a night. Tap a number to set it, tap it again to clear.
import { RATING_MAX, RATING_MIN, RATING_WORDS, isRating } from "@spot/shared";
import { IconStar, cx } from "@spot/ui";

const SCALE = Array.from({ length: RATING_MAX - RATING_MIN + 1 }, (_, i) => RATING_MIN + i);

export function RatingPicker({ value, onChange, label, disabled, large }: { value: number | null | undefined; onChange: (v: number | null) => void; label: string; disabled?: boolean; large?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className={cx("flex flex-none items-center", large ? "gap-2" : "gap-1")}>
      {SCALE.map((n) => {
        const on = value === n;
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            title={RATING_WORDS[n]}
            onClick={() => onChange(on ? null : n)}
            className={cx(
              "grid place-items-center rounded-full tabular transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50",
              large ? "size-11 type-title-s" : "size-9 type-label-l",
              on ? "bg-primary text-on-primary" : "bg-surface-high text-on-surface-variant hover:bg-surface-highest",
            )}
          >
            {n}
          </button>
        );
      })}
    </div>
  );
}

/** "★ 4" for a spot that has a rating. */
export function RatingBadge({ value, className }: { value: number | null | undefined; className?: string }) {
  if (!isRating(value)) return null;
  return (
    <span className={cx("inline-flex items-center gap-0.5 type-label-m tabular text-tertiary", className)} title={`${RATING_WORDS[value]} (${value} of 5)`}>
      <IconStar className="icon size-3.5" />
      {value}
    </span>
  );
}
