import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { DAY_NAMES, dateInWeek, diffLineup, formatDate, formatTime, greetName, renderTemplate, resendCandidates, type Lineup, type Show } from "@spot/shared";
import { useApp } from "../lib/app";
import { runCommand } from "../lib/data";
import { Bubble, Button, Sheet, cx } from "@spot/ui";
import { WaText } from "@spot/ui";
import { IconCheck, IconSend, IconUserMinus, IconUserPlus, IconRepeat } from "@spot/ui";

const Tick = ({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) => (
  <input type="checkbox" className="size-5 flex-none accent-[var(--md-sys-color-primary)]" checked={checked} onChange={onChange} aria-label={label} />
);

/**
 * Review of what changed on a confirmed lineup since the comics were last told. Nothing is sent until the curator
 * taps Send, and each person has a checkbox. Unticked adds and removals stay pending ("not told yet") for a later send.
 */
export function SendUpdatesSheet({ open, onClose, show, lineup, baseline, onSent }: { open: boolean; onClose: () => void; show: Show; lineup: Lineup; baseline: NonNullable<Lineup["sent"]>; onSent: () => void }) {
  const { uid, week, settings, venues, comicsById } = useApp();
  const [sending, setSending] = useState(false);
  // Adds and removals are on unless unticked; a resend is off unless ticked.
  const [off, setOff] = useState<Set<string>>(new Set());
  const [resend, setResend] = useState<Set<string>>(new Set());
  const venue = venues.find((v) => v.id === show.venueId);
  const changes = diffLineup(lineup.slots, baseline, show);
  const resendable = resendCandidates(changes);
  const name = (id: string) => comicsById.get(id)?.name ?? `+${id.split("@")[0]}`;
  const flip = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };

  const vars = (cid: string) => ({
    name: greetName(comicsById.get(cid)?.name),
    show: show.name,
    venue: venue?.name,
    mapsLink: venue?.mapsLink,
    day: DAY_NAMES[show.weekday],
    date: formatDate(dateInWeek(week, show.weekday)),
    time: formatTime(show.startTime),
    minutes: show.includeSlotTime ? (lineup.slots.find((s) => s.comicId === cid)?.minutes ?? show.defaultMinutes) : null,
  });
  const confirmText = (cid: string) => renderTemplate(settings.confirm.template, vars(cid));
  const cancelText = (cid: string) => renderTemplate(settings.cancelSpot.template, vars(cid));

  const notify = {
    add: changes.added.filter((id) => !off.has(`add:${id}`)),
    remove: changes.removed.filter((id) => !off.has(`remove:${id}`)),
    resend: resendable.filter((id) => resend.has(id)),
  };
  const count = notify.add.length + notify.remove.length + notify.resend.length;

  const send = async () => {
    setSending(true);
    const t = toast.loading(count ? `Sending ${count} message${count > 1 ? "s" : ""}, a few seconds apart…` : "Updating…");
    try {
      const r = await runCommand<{ sent: number; failed: string[] }>(uid, "send_lineup_updates", { lineupId: lineup.id, notify }, 15 * 60_000);
      if (r?.failed?.length) toast.warning(`Couldn't message ${r.failed.join(", ")}. They're still marked as changed.`, { id: t });
      else toast.success(count ? `${r?.sent ?? count} message${(r?.sent ?? count) > 1 ? "s" : ""} sent` : "Lineup updated", { id: t });
      onSent();
      onClose();
    } catch (e) {
      toast.error((e as Error).message, { id: t });
    } finally {
      setSending(false);
    }
  };

  const moveNote = (id: string) => {
    const m = changes.moved.find((x) => x.comicId === id);
    const t = changes.minutes.find((x) => x.comicId === id);
    return [m && `Spot ${m.from} → ${m.to}`, t && `${t.from ?? "?"} → ${t.to ?? "?"} min`].filter(Boolean).join(" · ");
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Send updates · ${show.name}`}
      wide
      footer={
        <>
          <Button variant="text" onClick={onClose}>Not yet</Button>
          <Button icon={IconSend} loading={sending} disabled={!changes.total} onClick={send}>
            {count ? `Send ${count} message${count > 1 ? "s" : ""}` : "Update without messages"}
          </Button>
        </>
      }
    >
      {!changes.total ? (
        <p className="flex items-center gap-2 py-6 type-body-l text-on-surface-variant">
          <IconCheck className="icon size-5 text-primary" /> Everyone has been told. Nothing has changed.
        </p>
      ) : (
        <>
          <p className="type-body-m text-on-surface-variant">
            This is what changed since you last sent. Each person gets their own WhatsApp message, a few seconds apart. Untick anyone you'd rather tell later; they stay marked as not told yet.
          </p>
          {settings.voice?.enabled && settings.voice.profile && <p className="mt-3 type-body-s text-on-surface-variant">Your voice is on: each message is reworded the way you write. The details shown here stay exactly the same; if a rewrite changes any of them, this version goes out.</p>}

          {changes.added.length > 0 && (
            <section className="mt-6">
              <h3 className="mb-1 flex items-center gap-2 type-title-s text-primary">
                <IconUserPlus className="icon size-5" /> Added · they get the confirmation
              </h3>
              <ul className="flex flex-col gap-4">
                {changes.added.map((id) => (
                  <Person key={id} name={name(id)} checked={!off.has(`add:${id}`)} onChange={() => setOff(flip(off, `add:${id}`))} label={`Message ${name(id)}`}>
                    <Bubble outgoing><WaText text={confirmText(id)} /></Bubble>
                  </Person>
                ))}
              </ul>
            </section>
          )}

          {changes.removed.length > 0 && (
            <section className="mt-8">
              <h3 className="mb-1 flex items-center gap-2 type-title-s text-error">
                <IconUserMinus className="icon size-5" /> Removed · they're told their spot is cancelled
              </h3>
              <ul className="flex flex-col gap-4">
                {changes.removed.map((id) => (
                  <Person key={id} name={name(id)} checked={!off.has(`remove:${id}`)} onChange={() => setOff(flip(off, `remove:${id}`))} label={`Message ${name(id)}`}>
                    <Bubble outgoing><WaText text={cancelText(id)} /></Bubble>
                  </Person>
                ))}
              </ul>
              <p className="mt-3 type-body-s text-on-surface-variant">They go back to Waiting. Edit this message under Settings → Messages.</p>
            </section>
          )}

          {resendable.length > 0 && (
            <section className="mt-8">
              <h3 className="mb-1 flex items-center gap-2 type-title-s text-on-surface">
                <IconRepeat className="icon size-5 text-tertiary" /> Moved or retimed · no message unless you tick
              </h3>
              <ul className="flex flex-col gap-4">
                {resendable.map((id) => (
                  <Person key={id} name={name(id)} note={moveNote(id)} checked={resend.has(id)} onChange={() => setResend(flip(resend, id))} label={`Send ${name(id)} the confirmation again`} hint="Send again">
                    <AnimatePresence initial={false}>
                      {resend.has(id) && (
                        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                          <Bubble outgoing><WaText text={confirmText(id)} /></Bubble>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </Person>
                ))}
              </ul>
            </section>
          )}

          {show.groupId && (
            <p className="mt-8 rounded-md bg-surface-container p-3 type-body-s text-on-surface-variant">
              The WhatsApp group isn't touched here. Use Sync group on the show to review who joins and leaves.
            </p>
          )}
        </>
      )}
    </Sheet>
  );
}

function Person({ name, note, checked, onChange, label, hint, children }: { name: string; note?: string; checked: boolean; onChange: () => void; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <li className="flex flex-col gap-2 pt-3">
      <label className="flex min-h-10 cursor-pointer items-center gap-3">
        <Tick checked={checked} onChange={onChange} label={label} />
        <span className="min-w-0 flex-1">
          <span className="block truncate type-label-l">{name}</span>
          {note && <span className="block type-body-s text-on-surface-variant">{note}</span>}
        </span>
        {hint && <span className={cx("type-label-m", checked ? "text-primary" : "text-on-surface-variant")}>{hint}</span>}
      </label>
      {children}
    </li>
  );
}
