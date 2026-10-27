import { useMemo, useState } from "react";
import { filterMembers } from "@spot/shared";
import { Button, TextInput, type Icon } from "../ui";
import { IconSearch } from "../icons";
import type { AccessRecord } from "./api";
import { Rows, Photo, displayName } from "./parts";

const lower = (e?: string | null) => (e ?? "").toLowerCase();

/** Search the approved members and act on one ("Make admin", "Add"). Shows the first few matches; type to narrow. */
export function CandidateList({ records, exclude = [], excludeEmails = [], actionLabel, icon, onPick, empty = "Every approved member is already on the list." }: { records: AccessRecord[]; exclude?: readonly string[]; excludeEmails?: readonly string[]; actionLabel: string; icon?: Icon; onPick: (r: AccessRecord) => void; empty?: string }) {
  const [query, setQuery] = useState("");
  const out = useMemo(() => new Set(excludeEmails.map(lower)), [excludeEmails]);
  const pool = useMemo(() => records.filter((r) => r.status === "approved" && r.email && !out.has(lower(r.email))).map((r) => ({ ...r, name: displayName(r), email: r.email ?? "" })), [records, out]);
  const found = useMemo(() => filterMembers(pool, query, exclude).slice(0, 6), [pool, query, exclude]);
  return (
    <>
      <div className="relative border-b border-outline-variant/40 p-3">
        <IconSearch aria-hidden className="icon pointer-events-none absolute top-1/2 left-7 size-5 -translate-y-1/2 text-on-surface-variant" />
        <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or email" aria-label="Search approved members" autoComplete="off" spellCheck={false} className="h-11 pl-11" />
      </div>
      {found.length === 0 ? (
        <p className="px-4 py-6 text-center type-body-m text-on-surface-variant">{query.trim() ? `No approved member matches “${query.trim()}”.` : empty}</p>
      ) : (
        <Rows>
          {found.map((m) => (
            <li key={m.uid} className="flex min-h-[4.5rem] items-center gap-3 py-3 pr-3 pl-4">
              <Photo name={m.name} photo={m.photo} />
              <div className="min-w-0 flex-1">
                <div className="truncate type-body-l">{m.name}</div>
                <div className="truncate type-body-s text-on-surface-variant">{m.email}</div>
              </div>
              <Button size="sm" variant="tonal" icon={icon} onClick={() => onPick(m)}>
                {actionLabel}
              </Button>
            </li>
          ))}
        </Rows>
      )}
    </>
  );
}
