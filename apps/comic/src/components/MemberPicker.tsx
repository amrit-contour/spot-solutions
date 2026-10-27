import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { filterMembers } from "@spot/shared";
import { Avatar, Button, IconSearch } from "@spot/ui";
import { loadMembers, type MemberEntry } from "../lib/members";

function Photo({ m, size }: { m: MemberEntry; size: number }) {
  const [bad, setBad] = useState(false);
  if (!m.photoURL || bad) return <Avatar name={m.name} size={size} />;
  return <img src={m.photoURL} alt="" width={size} height={size} referrerPolicy="no-referrer" loading="lazy" onError={() => setBad(true)} className="flex-none rounded-full bg-surface-high object-cover" style={{ width: size, height: size }} />;
}

function Who({ m, size = 40 }: { m: MemberEntry; size?: number }) {
  return (
    <>
      <Photo m={m} size={size} />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate type-body-l text-on-surface">{m.name}</span>
        <span className="block truncate type-body-s text-on-surface-variant">{m.email}</span>
      </span>
    </>
  );
}

/**
 * Pick one approved member by typing their name or email (name word starts, so "sam r" finds Sam Rao). Every option shows photo, name
 * and email so two people with the same name can be told apart. The list comes from the member directory, once per session.
 * `exclude` are uids to leave out (yourself, people already added). The list opens inline, so it works inside a Sheet at 360 px.
 */
export function MemberPicker({ label, hint, value, onChange, exclude = [], placeholder = "Type a name or email" }: {
  label: string;
  hint?: string;
  value: MemberEntry | null;
  onChange: (m: MemberEntry | null) => void;
  exclude?: readonly string[];
  placeholder?: string;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [members, setMembers] = useState<MemberEntry[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const load = () => {
    setError("");
    loadMembers().then(setMembers, (e: Error) => setError(e.message));
  };
  useEffect(load, []);

  // Close when tapping or clicking elsewhere; Escape is handled on the input.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const excludeKey = exclude.join(",");
  const results = useMemo(() => filterMembers(members ?? [], query, exclude), [members, query, excludeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = Math.min(active, Math.max(results.length - 1, 0));
  const optionId = (i: number) => `${id}-o${i}`;

  useEffect(() => {
    if (open) document.getElementById(optionId(shown))?.scrollIntoView({ block: "nearest" });
  }, [shown, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (m: MemberEntry) => {
    onChange(m);
    setQuery("");
    setOpen(false);
  };
  const clear = () => {
    onChange(null);
    requestAnimationFrame(() => input.current?.focus());
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setOpen(true);
      if (results.length) setActive((shown + (e.key === "ArrowDown" ? 1 : results.length - 1)) % results.length);
    } else if (e.key === "Enter") {
      if (open && results[shown]) {
        e.preventDefault();
        choose(results[shown]);
      }
    } else if (e.key === "Escape" && open) {
      // Close the list, not the sheet around it.
      e.preventDefault();
      e.nativeEvent.stopPropagation();
      setOpen(false);
    } else if (e.key === "Home" && open && results.length) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && open && results.length) {
      e.preventDefault();
      setActive(results.length - 1);
    }
  };

  const listId = `${id}-list`;
  return (
    <div ref={root} className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={`${id}-input`} className="type-label-l text-on-surface-variant">{label}</label>
      {value ? (
        <div className="flex min-h-14 min-w-0 items-center gap-3 rounded-sm border border-outline px-3 py-2">
          <Who m={value} />
          <Button variant="text" size="sm" onClick={clear} aria-label={`Change ${value.name}`}>Change</Button>
        </div>
      ) : (
        <>
          <div className="relative min-w-0">
            <IconSearch aria-hidden className="icon pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-on-surface-variant" />
            <input
              ref={input}
              id={`${id}-input`}
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={open && results[shown] ? optionId(shown) : undefined}
              aria-describedby={hint ? `${id}-hint` : undefined}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true); }}
              onFocus={() => setOpen(true)}
              onKeyDown={onKey}
              placeholder={members ? placeholder : "Loading members…"}
              disabled={!members}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
              enterKeyHint="done"
              className="h-12 w-full rounded-sm border border-outline bg-transparent pr-4 pl-12 type-body-l text-on-surface outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-on-surface-variant/60 focus:border-primary focus:shadow-[inset_0_0_0_1px_var(--md-sys-color-primary)] disabled:opacity-60"
            />
          </div>
          {error && (
            <div role="alert" className="flex min-w-0 items-center gap-3 rounded-md bg-error-container p-3 type-body-m text-on-error-container">
              <span className="min-w-0 flex-1">{error}</span>
              <Button variant="text" size="sm" onClick={load}>Retry</Button>
            </div>
          )}
          {open && members && (
            <ul id={listId} role="listbox" aria-label={label} className="max-h-[min(20rem,50dvh)] min-w-0 overflow-y-auto overscroll-contain rounded-md bg-surface-low shadow-[inset_0_0_0_1px_var(--md-sys-color-outline-variant)]">
              {results.map((m, i) => (
                <li
                  key={m.uid}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === shown}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(m)}
                  onMouseMove={() => i !== shown && setActive(i)}
                  className={`flex min-h-14 min-w-0 cursor-pointer items-center gap-3 border-b border-outline-variant/40 px-3 py-2 last:border-b-0 ${i === shown ? "bg-secondary-container text-on-secondary-container" : ""}`}
                >
                  <Who m={m} />
                </li>
              ))}
              {results.length === 0 && <li role="presentation" className="px-3 py-4 type-body-m text-on-surface-variant">No member matches</li>}
            </ul>
          )}
        </>
      )}
      {hint && <span id={`${id}-hint`} className="type-body-s text-on-surface-variant">{hint}</span>}
    </div>
  );
}
