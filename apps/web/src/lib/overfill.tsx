// The slot count is a soft limit: a full show can still take one more, after an in-page "Add anyway".
// Every add path asks through askOverfill(); one host (mounted once in App) shows the dialog.
import { useEffect, useState } from "react";
import { ConfirmDialog } from "@spot/ui";
import type { Show } from "@spot/shared";

export interface OverfillAsk {
  show: Pick<Show, "name" | "slotCount">;
  filled: number;
  /** Who is being added: a name, or "Rahul and 2 more". */
  who: string;
  /** How many people this add puts on. */
  adding: number;
  resolve: (ok: boolean) => void;
}

type Listener = (ask: OverfillAsk | null) => void;
let listener: Listener | null = null;

/** The sentence under the title, and the count the curator ends up with. */
export function overfillText(ask: Pick<OverfillAsk, "show" | "filled" | "who" | "adding">) {
  const n = ask.show.slotCount;
  return {
    body: `${ask.show.name} has ${n} ${n === 1 ? "spot" : "spots"} and ${ask.filled} ${ask.filled === 1 ? "is" : "are"} filled.`,
    question: `Add ${ask.who} anyway?`,
    count: `${ask.filled + ask.adding} of ${n}`,
  };
}

/** Resolves true straight away while there is room; otherwise opens the dialog and resolves with the answer. */
export function askOverfill(show: Pick<Show, "name" | "slotCount">, filled: number, who: string, adding = 1): Promise<boolean> {
  if (filled + adding <= show.slotCount) return Promise.resolve(true);
  return new Promise((resolve) => {
    if (!listener) return resolve(true); // no host mounted (tests, a page without the app shell): don't block
    listener({ show, filled, who, adding, resolve });
  });
}

/** "Rahul", "Rahul and Priya", "Rahul and 2 more". */
export const whoLabel = (names: string[]) => (names.length <= 2 ? names.join(" and ") : `${names[0]} and ${names.length - 1} more`);

export function OverfillHost() {
  const [ask, setAsk] = useState<OverfillAsk | null>(null);
  useEffect(() => {
    listener = setAsk;
    return () => {
      listener = null;
    };
  }, []);
  const t = ask ? overfillText(ask) : null;
  const done = (ok: boolean) => {
    ask?.resolve(ok);
    setAsk(null);
  };
  return (
    <ConfirmDialog open={Boolean(ask)} onClose={() => done(false)} title="Over the slot count" confirmLabel="Add anyway" tone="primary" onConfirm={async () => done(true)}>
      {t && (
        <>
          <p>
            {t.body} {t.question} <span className="tabular">({t.count})</span>
          </p>
          <p className="text-on-surface-variant">Each further add asks again.</p>
        </>
      )}
    </ConfirmDialog>
  );
}
