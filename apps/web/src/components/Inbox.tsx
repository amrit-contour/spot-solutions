// "Needs a reply" drafts (comic cancellations and questions) and worker alerts, shown above the request lanes.
import { useState } from "react";
import { orderBy, updateDoc, where } from "firebase/firestore";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { formatDate, localNow, type AppNotice, type ComicAction, type Lineup } from "@spot/shared";
import { markCanned } from "../lib/lineup";
import { useApp } from "../lib/app";
import { runCommand, timeAgo, useCollection, userDoc } from "../lib/data";
import { Avatar, Bubble, Button, IconButton, TextArea, cx } from "./ui";
import { IconMic } from "./icons";
import { IconChatCheck, IconClose, IconHistory, IconSkip, IconWarn } from "./icons";

const KIND_LABEL: Record<ComicAction["kind"], string> = {
  cancel_spot: "Wants to cancel",
  status_query: "Asks if they're on",
  last_spot_query: "Asks about their last spot",
  show_info: "Asks where / when the mic is",
  onboard: "New face: not in your contacts",
};

export function Notices() {
  const { uid } = useApp();
  const notices = useCollection<AppNotice>(uid, "notices", [where("read", "==", false)]);
  const list = [...notices.data].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  if (!list.length) return null;
  return (
    <ul className="mb-4 flex flex-col gap-2">
      <AnimatePresence initial={false}>
        {list.map((n) => (
          <motion.li
            key={n.id}
            layout
            initial={{ opacity: 0, transform: "translateY(-4px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)" }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            className={cx("flex items-start gap-3 rounded-lg px-4 py-3", n.level === "warn" ? "bg-error-container text-on-error-container" : "bg-surface-container")}
          >
            {n.level === "warn" ? <IconWarn className="icon mt-0.5 size-5 flex-none" /> : <IconHistory className="icon mt-0.5 size-5 flex-none text-primary" />}
            <p className="flex-1 type-body-m">{n.text}</p>
            <IconButton icon={IconClose} label="Dismiss" className="-my-1.5 -mr-2 size-9" onClick={() => void updateDoc(userDoc(uid, "notices", n.id), { read: true })} />
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

export function ActionInbox() {
  const { uid, week } = useApp();
  const actions = useCollection<ComicAction>(uid, "actions", [where("weekOf", "==", week), where("status", "==", "pending"), orderBy("createdAt", "desc")], week);
  if (!actions.data.length) return null;
  return (
    <section className="mb-6">
      <h2 className="mb-3 flex items-center gap-2 type-title-m">
        Needs a reply
        <span className="rounded-full bg-primary px-1.5 type-label-s text-on-primary tabular">{actions.data.length}</span>
      </h2>
      <ul className="flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {actions.data.map((a) => (
            <ActionCard key={a.id} a={a} />
          ))}
        </AnimatePresence>
      </ul>
    </section>
  );
}

function ActionCard({ a }: { a: ComicAction }) {
  const { uid } = useApp();
  const [draft, setDraft] = useState(a.draft);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await runCommand(uid, "send_action", { actionId: a.id, body: draft }, 120_000);
      toast.success(a.kind === "cancel_spot" && a.lineupId ? `${a.comicName.split(" ")[0]}'s spot is freed and they've been told` : "Reply sent");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <motion.li
      layout
      initial={{ opacity: 0, transform: "translateY(6px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      exit={{ opacity: 0, transform: "scale(0.98)", transition: { duration: 0.15 } }}
      className="overflow-hidden rounded-lg bg-surface-low"
    >
      <div className="flex gap-3 px-4 pt-4 sm:gap-4 sm:px-5">
        <Avatar name={a.comicName} size={40} tone="tertiary" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="min-w-0 flex-1 truncate type-title-m">{a.comicName}</h3>
            <span className="flex-none type-label-m text-on-surface-variant tabular">{timeAgo(a.createdAt)}</span>
          </div>
          <p className={cx("type-label-l", a.kind === "cancel_spot" ? "text-error" : "text-primary")}>{KIND_LABEL[a.kind]}</p>
          <div className="mt-3">
            <Bubble>{a.message}</Bubble>
          </div>
          <label className="mt-3 block">
            <span className="mb-1.5 block type-label-m text-on-surface-variant">Your reply</span>
            <TextArea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} className="min-h-0" />
          </label>
          {a.kind === "cancel_spot" && a.lineupId && <p className="mt-2 type-body-s text-on-surface-variant">Sending also frees their slot, logs the cancellation and removes them from the group if the show is today.</p>}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2 border-t border-outline-variant/40 px-3 py-2 sm:px-4">
        <Button variant="text" icon={IconSkip} onClick={() => void updateDoc(userDoc(uid, "actions", a.id), { status: "dismissed" })}>
          Ignore
        </Button>
        <Button icon={IconChatCheck} loading={busy} onClick={send} disabled={!draft.trim()}>
          Send
        </Button>
      </div>
    </motion.li>
  );
}


/** Morning-after check for confirmed shows that are now in the past. */
export function MicCheck() {
  const { uid, shows, settings, comicsById } = useApp();
  const confirmed = useCollection<Lineup>(uid, "lineups", [where("status", "==", "confirmed")]);
  const today = localNow(new Date(), settings.timezone).date;
  const due = confirmed.data.filter((l) => !l.outcome && l.date && l.date < today).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
  if (!settings.micCheck.enabled || !due.length) return null;
  return (
    <ul className="mb-4 flex flex-col gap-2">
      {due.map((l) => {
        const show = shows.find((s) => s.id === l.showId);
        return (
          <li key={l.id} className="flex flex-wrap items-center gap-3 rounded-lg bg-secondary-container px-4 py-3 text-on-secondary-container">
            <IconMic className="icon size-5 flex-none" />
            <p className="min-w-40 flex-1 type-body-m">
              Did <span className="type-title-s">{show?.name ?? "the show"}</span> on {formatDate(l.date)} happen?
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="text"
                className="text-on-secondary-container"
                onClick={() => show && void markCanned(uid, l, show, comicsById).then(() => updateDoc(userDoc(uid, "lineups", l.id), { outcome: "canned" }))}
              >
                No
              </Button>
              <Button size="sm" onClick={() => void updateDoc(userDoc(uid, "lineups", l.id), { outcome: "happened" })}>
                Yes, it happened
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
