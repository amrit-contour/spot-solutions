import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { DAY_NAMES, confirmSkipReason, dateInWeek, formatDate, formatTime, greetName, renderTemplate, type Lineup, type Show } from "@spot/shared";
import { useApp } from "../lib/app";
import { runCommand } from "../lib/data";
import { Bubble, Button, Empty, Sheet } from "./ui";
import { IconChatCross, IconMic, IconSend } from "./icons";

/** Preview and send a show's confirmations. Shared by the Lineup board and the Calendar dashboard. */
export function ConfirmSheet({ open, onClose, onSending, show, ids, lineup, regretsAfter }: { open: boolean; onClose: () => void; onSending: () => void; show: Show; ids: string[]; lineup?: Lineup; regretsAfter: number }) {
  const { uid, week, settings, venues, comicsById } = useApp();
  const [sending, setSending] = useState(false);
  const venue = venues.find((v) => v.id === show.venueId);
  const minutesOf = new Map(lineup?.slots.map((s) => [s.comicId, s.minutes]));
  const preview = (cid: string) =>
    renderTemplate(settings.confirm.template, {
      name: greetName(comicsById.get(cid)?.name),
      show: show.name,
      venue: venue?.name,
      mapsLink: venue?.mapsLink,
      day: DAY_NAMES[show.weekday],
      date: formatDate(dateInWeek(week, show.weekday)),
      time: formatTime(show.startTime),
      minutes: show.includeSlotTime ? (minutesOf.get(cid) ?? show.defaultMinutes) : null,
    });

  // Already told, or already in the show's group: they keep their spot but get no message.
  const skipOf = (cid: string) => confirmSkipReason(comicsById.get(cid) ?? { id: cid }, lineup, show);
  const toSend = ids.filter((cid) => !skipOf(cid));
  const skipped = ids.filter((cid) => skipOf(cid));

  const send = async () => {
    setSending(true);
    onSending();
    const t = toast.loading(toSend.length ? `Sending ${toSend.length} confirmation${toSend.length > 1 ? "s" : ""}, a few seconds apart…` : "Locking in the lineup…");
    try {
      await runCommand(uid, "send_confirmations", { lineupId: `${week}_${show.id}` }, 15 * 60_000);
      toast.success(`${show.name} is locked in`, { id: t });
      onClose();
    } catch (e) {
      toast.error((e as Error).message, { id: t });
    } finally {
      setSending(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Confirm ${show.name}`}
      wide
      footer={
        <>
          <Button variant="text" onClick={onClose}>Not yet</Button>
          <Button icon={IconSend} loading={sending} onClick={send}>
            {toSend.length ? `Send ${toSend.length} confirmation${toSend.length > 1 ? "s" : ""}` : "Confirm, nobody to message"}
          </Button>
        </>
      }
    >
      <p className="type-body-m text-on-surface-variant">
        Each comic gets their own WhatsApp message, spaced a few seconds apart.
        {show.groupId ? " Then you'll review who to add to and remove from the show's group." : ""}
      </p>
      {settings.reject.enabled && regretsAfter > 0 && (
        <p className="mt-3 flex items-start gap-2 rounded-md bg-surface-container p-3 type-body-m text-on-surface-variant">
          <IconChatCross className="icon mt-0.5 size-4 flex-none text-primary" />
          This is the last show this week, so the {regretsAfter} comic{regretsAfter > 1 ? "s" : ""} still waiting will also get your regret message.
        </p>
      )}
      {settings.voice?.enabled && settings.voice.profile && <p className="mt-3 type-body-s text-on-surface-variant">Your voice is on: each message is reworded the way you write. The details shown here stay exactly the same; if a rewrite changes any of them, this version goes out.</p>}
      <ul className="mt-5 flex flex-col gap-5">
        <AnimatePresence initial={false}>
          {toSend.map((cid, i) => (
            <motion.li key={cid} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { delay: i * 0.03 } }} className="flex flex-col gap-2">
              <span className="flex items-center gap-2 type-label-l">
                <span className="w-5 text-on-surface-variant tabular">{i + 1}</span>
                {comicsById.get(cid)?.name ?? cid}
              </span>
              <Bubble outgoing>{preview(cid)}</Bubble>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      {skipped.length > 0 && (
        <div className="mt-6 flex flex-col gap-2">
          <span className="type-label-l text-on-surface-variant">Already know, no message ({skipped.length})</span>
          <ul className="flex flex-wrap gap-1.5">
            {skipped.map((cid) => (
              <li key={cid} className="inline-flex h-7 items-center gap-1.5 rounded-sm bg-surface-container px-2.5 type-label-m">
                {comicsById.get(cid)?.name ?? cid}
                <span className="text-on-surface-variant">· {skipOf(cid) === "told" ? "already told" : "in the group"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!ids.length && <Empty icon={IconMic} title="No one placed yet" />}
    </Sheet>
  );
}
