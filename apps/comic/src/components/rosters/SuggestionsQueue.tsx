import { useState } from "react";
import type { User } from "firebase/auth";
import { toast } from "sonner";
import { describeSuggestion, suggestionConflict, toSharedRoster, type PublishedRosterDoc, type RosterSuggestion } from "@spot/shared";
import { Button, Chip, IconCheck, IconClose, IconWarn } from "@spot/ui";
import { approveSuggestion, rejectSuggestion, withdrawSuggestion } from "../../lib/rosters";

const when = (at: number) => new Date(at).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

function Item({ roster, s, maintainer, user }: { roster: PublishedRosterDoc; s: RosterSuggestion; maintainer: boolean; user: User }) {
  const [busy, setBusy] = useState<"" | "yes" | "no">("");
  const shared = toSharedRoster(roster);
  const d = describeSuggestion(s, shared);
  const pending = s.status === "pending";
  const conflict = pending && suggestionConflict(shared, s);

  const run = async (kind: "yes" | "no") => {
    setBusy(kind);
    try {
      if (kind === "yes") {
        const v = await approveSuggestion(roster.id, s.id, user);
        toast.success(`Approved. The roster is now version ${v}.`);
      } else {
        await rejectSuggestion(roster.id, s.id, user);
        toast("Rejected");
      }
    } catch (e) {
      const m = e instanceof Error && !/permission|insufficient|transaction|network/i.test(e.message) ? e.message : "Couldn't do that. Check your connection and try again.";
      toast.error(m);
    } finally {
      setBusy("");
    }
  };

  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-lg bg-surface-low p-4">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="break-words type-title-s">{d.what}</p>
          <p className="break-words type-body-s text-on-surface-variant">{d.where}</p>
        </div>
        {!pending && <Chip tone={s.status === "approved" ? "success" : "error"} className="flex-none">{s.status === "approved" ? "Approved" : "Rejected"}</Chip>}
      </div>
      {(d.from !== undefined || d.to !== undefined) && (
        <p className="break-words type-body-m">
          {d.from !== undefined && <span className="text-on-surface-variant">{d.from}</span>}
          {d.from !== undefined && d.to !== undefined && <span aria-label="becomes"> → </span>}
          {d.to !== undefined && <span>{d.to}</span>}
        </p>
      )}
      {s.note && <p className="break-words type-body-m italic text-on-surface-variant">"{s.note}"</p>}
      <p className="type-label-m text-on-surface-variant">{s.byName ?? "A member"} · {when(s.createdAt)}</p>
      {conflict && (
        <p className="flex items-start gap-2 rounded-md bg-tertiary-container p-3 type-body-s text-on-tertiary-container">
          <IconWarn aria-hidden className="icon mt-0.5 size-4 flex-none" />
          <span className="min-w-0">This has changed in the roster since it was suggested. Check it before you approve.</span>
        </p>
      )}
      {pending && maintainer && (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button size="sm" icon={IconCheck} onClick={() => void run("yes")} loading={busy === "yes"} disabled={busy !== ""}>Approve</Button>
          <Button size="sm" variant="outlined" icon={IconClose} onClick={() => void run("no")} loading={busy === "no"} disabled={busy !== ""}>Reject</Button>
        </div>
      )}
      {pending && !maintainer && s.byUid === user.uid && (
        <div><Button size="sm" variant="text" onClick={() => void withdrawSuggestion(roster.id, s.id)}>Withdraw</Button></div>
      )}
    </li>
  );
}

/** Maintainers: what is waiting. Everyone else: their own suggestions and how they went. */
export function SuggestionsQueue({ roster, suggestions, maintainer, user }: { roster: PublishedRosterDoc; suggestions: RosterSuggestion[]; maintainer: boolean; user: User }) {
  const pending = suggestions.filter((s) => s.status === "pending");
  const decided = suggestions.filter((s) => s.status !== "pending").slice(0, 5);
  if (!pending.length && !decided.length) return null;
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label={maintainer ? "Suggestions to review" : "Your suggestions"}>
      <h2 className="type-title-m">
        {maintainer ? "Suggestions to review" : "Your suggestions"}
        {pending.length > 0 && <span className="ml-2 type-label-m tabular text-on-surface-variant">{pending.length} waiting</span>}
      </h2>
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">
        {pending.map((s) => <Item key={s.id} roster={roster} s={s} maintainer={maintainer} user={user} />)}
        {decided.map((s) => <Item key={s.id} roster={roster} s={s} maintainer={maintainer} user={user} />)}
      </ul>
    </section>
  );
}
