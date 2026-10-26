// A comic cancelled or asked something. The curator reviews the drafted reply and sends it, or ignores it.
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { DAY_NAMES, hasPin, pollProblem, type ComicAction, type Lineup, type RichMessage, type Show } from "@spot/shared";
import { useApp } from "../../lib/app";
import { runCommand, timeAgo } from "../../lib/data";
import { dismissAction } from "../../lib/updates";
import { Avatar, Bubble, Button, Chip } from "@spot/ui";
import { MessageComposer } from "@spot/ui";
import { SnippetMenu } from "../SnippetMenu";
import { IconArrowRight, IconCancel, IconChat, IconChatCheck, IconClock, IconMap, IconMic, IconSkip } from "@spot/ui";
import { UpdateItem } from "./shared";

const KIND: Record<string, { label: string; icon: typeof IconChat }> = {
  cancel_spot: { label: "Wants to cancel", icon: IconCancel },
  status_query: { label: "Asks if they're on", icon: IconMic },
  last_spot_query: { label: "Asks about their last spot", icon: IconClock },
  show_info: { label: "Asks where or when", icon: IconMap },
  held: { label: "Held request: why", icon: IconSkip },
};

/** What sending a cancellation reply will do, in plain words. */
function cancelEffect(a: ComicAction, lineups: Lineup[], shows: Show[]) {
  if (!a.lineupId) return "They're not in a lineup this week, so only your reply goes out.";
  const lineup = lineups.find((l) => l.id === a.lineupId);
  const show = shows.find((s) => s.id === lineup?.showId);
  const slot = lineup ? lineup.slots.findIndex((s) => s.comicId === a.comicId) : -1;
  if (!lineup || !show) return "Frees their slot and logs the cancellation.";
  return `Frees ${DAY_NAMES[show.weekday]} slot ${slot >= 0 ? slot + 1 : ""}`.trim() + ` at ${show.name} and logs the cancellation.`;
}

export function ReplyCard({ a, lineups }: { a: ComicAction; lineups: Lineup[] }) {
  const { uid, shows, venues } = useApp();
  const [msg, setMsg] = useState<RichMessage>({ kind: a.rich?.kind ?? "text", body: a.draft, poll: a.rich?.poll, attachLocation: a.rich?.attachLocation });
  // The venue a pin would point at: the one named on the draft, else the show this comic is on.
  const venueId = a.rich?.venueId ?? shows.find((s) => s.id === lineups.find((l) => l.id === a.lineupId)?.showId)?.venueId ?? null;
  const pinned = hasPin(venues.find((v) => v.id === venueId));
  const ready = msg.kind === "poll" ? !pollProblem(msg.poll) : msg.kind === "location" ? pinned : Boolean(msg.body.trim()) || (Boolean(msg.attachLocation) && pinned);
  const [busy, setBusy] = useState(false);
  const kind = KIND[a.kind] ?? KIND.status_query;
  const cancel = a.kind === "cancel_spot";

  const send = async () => {
    setBusy(true);
    try {
      await runCommand(uid, "send_action", { actionId: a.id, body: msg.body, rich: { kind: msg.kind, ...(msg.poll && msg.kind === "poll" && { poll: msg.poll }), attachLocation: Boolean(msg.attachLocation), venueId } }, 120_000);
      toast.success(cancel && a.lineupId ? `${a.comicName.split(" ")[0]}'s spot is freed and they've been told` : "Reply sent");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <UpdateItem onDismiss={() => dismissAction(uid, a)}>
      <div className="flex gap-3 px-4 pt-4">
        <Avatar name={a.comicName} size={40} tone="tertiary" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="min-w-0 flex-1 truncate type-title-m">{a.comicName}</h3>
            <span className="flex-none type-label-m text-on-surface-variant tabular">{timeAgo(a.createdAt)}</span>
          </div>
          <div className="mt-1.5">
            <Chip tone={cancel ? "error" : "primary"} icon={kind.icon}>
              {kind.label}
            </Chip>
          </div>
          <div className="mt-3">
            <Bubble>{a.message}</Bubble>
          </div>
          <div className="mt-3">
            <div className="-mt-1.5 mb-0.5 flex items-center justify-between gap-2">
              <label htmlFor={`reply-${a.id}-body`} className="type-label-m text-on-surface-variant">Your reply</label>
              <SnippetMenu name={a.comicName} onPick={setMsg} />
            </div>
            <MessageComposer value={msg} onChange={setMsg} compact preview={false} canPin={pinned} idPrefix={`reply-${a.id}`} />
            {msg.kind === "location" && !pinned && <p className="mt-1.5 type-body-s text-error">This venue has no map pin yet, so nothing would be sent. Add one under Shows → Venues.</p>}
          </div>
          {cancel && (
            <p className="mt-2 type-body-s text-on-surface-variant">
              {cancelEffect(a, lineups, shows)}
              {a.lineupId && (
                <>
                  {" "}
                  <Link to="/lineup" className="inline-flex items-center gap-0.5 text-primary underline-offset-4 hover:underline">
                    View lineup <IconArrowRight className="icon size-3.5" />
                  </Link>
                </>
              )}
            </p>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2 border-t border-outline-variant/40 px-3 py-2">
        <Button variant="text" icon={IconSkip} onClick={() => dismissAction(uid, a)}>
          Ignore
        </Button>
        <Button icon={IconChatCheck} loading={busy} onClick={send} disabled={!ready} data-primary>
          Send
        </Button>
      </div>
    </UpdateItem>
  );
}
