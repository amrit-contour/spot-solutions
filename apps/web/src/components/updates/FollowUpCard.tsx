// You already answered someone by hand in WhatsApp: apply what you said (place them, or close their request).
import { useState } from "react";
import { toast } from "sonner";
import type { ComicAction } from "@spot/shared";
import { useApp } from "../../lib/app";
import { runCommand, timeAgo } from "../../lib/data";
import { dismissAction } from "../../lib/updates";
import { Avatar, Bubble, Button, Chip } from "../ui";
import { IconCheck, IconGroup, IconSkip, IconUserCheck, IconUserMinus } from "../icons";
import { UpdateItem } from "./shared";

export function FollowUpCard({ a }: { a: ComicAction }) {
  const { uid } = useApp();
  const [busy, setBusy] = useState(false);
  const f = a.followUp!;
  const place = f.action === "place";
  const first = a.comicName.split(" ")[0];

  const apply = async () => {
    setBusy(true);
    try {
      await runCommand(uid, "apply_follow_up", { actionId: a.id }, 120_000);
      toast.success(place ? `${first} is on ${f.showName ?? "the lineup"}${f.addToGroup ? " and added to the group" : ""}` : `${first}'s request is closed`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <UpdateItem>
      <div className="flex gap-3 px-4 pt-4">
        <Avatar name={a.comicName} size={40} tone="secondary" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="min-w-0 flex-1 truncate type-title-m">{a.comicName}</h3>
            <span className="flex-none type-label-m text-on-surface-variant tabular">{timeAgo(a.createdAt)}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Chip tone={place ? "primary" : "neutral"} icon={place ? IconUserCheck : IconUserMinus}>
              {place ? `You gave them ${f.showName ?? "a spot"}` : "You said no"}
            </Chip>
            {f.addToGroup && <Chip icon={IconGroup}>Not in the group yet</Chip>}
          </div>
          <div className="mt-3 flex flex-col gap-1">
            <span className="type-label-m text-on-surface-variant">You wrote</span>
            <Bubble outgoing>{f.evidence || a.message}</Bubble>
          </div>
          <p className="mt-2 type-body-s text-on-surface-variant">
            {place
              ? `Apply puts them on ${f.showName ?? "the lineup"} as already told${f.addToGroup ? ", and adds them to the show's group" : ""}. No message is sent.`
              : "Apply closes their request. No message is sent."}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2 border-t border-outline-variant/40 px-3 py-2">
        <Button variant="text" icon={IconSkip} onClick={() => dismissAction(uid, a)}>
          Ignore
        </Button>
        <Button icon={IconCheck} loading={busy} onClick={apply} data-primary>
          Apply
        </Button>
      </div>
    </UpdateItem>
  );
}
