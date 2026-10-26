// New faces: someone not in your contacts asked for a spot (reply with the "who are you?" draft),
// or someone answered that question and introduced themselves (open their profile).
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { pollProblem, type ComicAction, type RichMessage } from "@spot/shared";
import { useApp } from "../../lib/app";
import { runCommand, timeAgo } from "../../lib/data";
import { dismissAction, dismissNotice, type Introduction } from "../../lib/updates";
import { Avatar, Bubble, Button, Chip, buttonClass } from "../ui";
import { MessageComposer } from "../rich/MessageComposer";
import { SnippetMenu } from "../SnippetMenu";
import { IconChatCheck, IconSkip, IconUserCheck, IconUserPlus } from "../icons";
import { UpdateItem } from "./shared";

export function OnboardCard({ a }: { a: ComicAction }) {
  const { uid } = useApp();
  const [msg, setMsg] = useState<RichMessage>({ kind: a.rich?.kind ?? "text", body: a.draft, poll: a.rich?.poll });
  const ready = msg.kind === "poll" ? !pollProblem(msg.poll) : msg.kind === "text" && Boolean(msg.body.trim());
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await runCommand(uid, "send_action", { actionId: a.id, body: msg.body, rich: { kind: msg.kind, ...(msg.poll && msg.kind === "poll" && { poll: msg.poll }) } }, 120_000);
      toast.success("Reply sent");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <UpdateItem onDismiss={() => dismissAction(uid, a)}>
      <div className="flex gap-3 px-4 pt-4">
        <Avatar name={a.comicName} size={40} tone="primary" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="min-w-0 flex-1 truncate type-title-m">{a.comicName}</h3>
            <span className="flex-none type-label-m text-on-surface-variant tabular">{timeAgo(a.createdAt)}</span>
          </div>
          <div className="mt-1.5">
            <Chip tone="primary" icon={IconUserPlus}>
              Not in your contacts
            </Chip>
          </div>
          <div className="mt-3">
            <Bubble>{a.message}</Bubble>
          </div>
          <div className="mt-3">
            <div className="-mt-1.5 mb-0.5 flex items-center justify-between gap-2">
              <label htmlFor={`face-${a.id}-body`} className="type-label-m text-on-surface-variant">Ask who they are</label>
              <SnippetMenu name={a.comicName} onPick={setMsg} kinds={["text", "poll"]} />
            </div>
            <MessageComposer value={msg} onChange={setMsg} kinds={["text", "poll"]} compact preview={false} idPrefix={`face-${a.id}`} />
          </div>
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

export function IntroCard({ intro }: { intro: Introduction }) {
  const { uid, comics } = useApp();
  const nav = useNavigate();
  const match = comics.find((c) => c.name.toLowerCase() === intro.name.toLowerCase());
  const to = match ? `/comics?edit=${encodeURIComponent(match.id)}` : `/comics?add=${encodeURIComponent(intro.name)}`;
  return (
    <UpdateItem onDismiss={() => dismissNotice(uid, intro.notice)}>
      <div className="flex gap-3 px-4 pt-4">
        <Avatar name={intro.name} size={40} tone="secondary" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="min-w-0 flex-1 truncate type-title-m">{intro.name}</h3>
            <span className="flex-none type-label-m text-on-surface-variant tabular">{timeAgo(intro.notice.createdAt)}</span>
          </div>
          <p className="mt-0.5 type-body-m text-on-surface-variant">Introduced themselves</p>
          {intro.bits.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {intro.bits.map((b) => (
                <Chip key={b} tone="fact">
                  {b}
                </Chip>
              ))}
            </div>
          )}
          <p className="mt-2 type-body-s text-on-surface-variant">Save them in your phone so their name sticks.</p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2 border-t border-outline-variant/40 px-3 py-2">
        <Button variant="text" icon={IconSkip} onClick={() => dismissNotice(uid, intro.notice)}>
          Dismiss
        </Button>
        <Link
          to={to}
          data-primary
          onClick={(e) => {
            // Opening the profile settles it: mark the notice as read, then go.
            e.preventDefault();
            dismissNotice(uid, intro.notice, true);
            nav(to);
          }}
          className={buttonClass({ icon: true })}
        >
          <IconUserCheck className="icon size-5" />
          {match ? "Edit profile" : "Add to roster"}
        </Link>
      </div>
    </UpdateItem>
  );
}
