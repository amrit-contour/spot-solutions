// The pieces of a type-first people picker: a search field and, until something is typed, a hint (and optionally a short "Recent" row)
// instead of a list. Matching is searchPeople() in @spot/shared.
import { PEOPLE_SEARCH_HINT, type PersonLike } from "@spot/shared";
import { Chip, TextInput, cx } from "@spot/ui";

export function SearchField({ value, onChange, label = "Search comics", className, onEnter }: { value: string; onChange: (v: string) => void; label?: string; className?: string; onEnter?: () => void }) {
  return (
    <TextInput
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && onEnter) {
          e.preventDefault();
          onEnter();
        } else if (e.key === "Escape" && value) {
          e.preventDefault();
          e.stopPropagation();
          onChange("");
        }
      }}
      placeholder="Search comics"
      aria-label={label}
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      enterKeyHint="search"
      className={className}
    />
  );
}

/** Up to 5 people to tap before typing. Hidden once there is a query or nobody to show. */
export function RecentRow({ people, onPick, selected = [], label = "Recent" }: { people: readonly PersonLike[]; onPick: (id: string) => void; selected?: readonly string[]; label?: string }) {
  if (!people.length) return null;
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      <span className="type-label-s text-on-surface-variant">{label}</span>
      {people.slice(0, 5).map((p) => (
        <Chip key={p.id} selected={selected.includes(p.id)} onClick={() => onPick(p.id)}>
          {p.name.split(/\s+/)[0] || p.name}
        </Chip>
      ))}
    </div>
  );
}

/** Under the field while the query is empty. */
export function SearchHint({ className }: { className?: string }) {
  return <p className={cx("rounded-md bg-surface-container px-3 py-3 type-body-s text-on-surface-variant", className)}>{PEOPLE_SEARCH_HINT}</p>;
}
