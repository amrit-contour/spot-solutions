import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { askDayLabel, openNow, upcomingGroups, type Ask, type PlannedAsk } from "@spot/shared";
import { Button, IconPlus, IconRoom, IconChat, IconClock, IconMenuDots, IconButton, Menu, MenuItem, PageHeader, Segmented, Spinner } from "@spot/ui";
import { EmptyState, Page, Section } from "../components/ui";
import { useAskPrefs, useShowMissedAsks } from "../lib/alerts";
import { draftFor, useAsks, useAskPlan, useNowMs } from "../lib/asks";
import { useRoster } from "../lib/roster";
import { shortDate } from "../lib/time";
import { AskOpenCard, AskSentCard, AskUpcomingRow } from "../components/AskCards";
import { AskEditSheet, RoomModesSheet, TemplateSheet } from "../components/AskSheets";
import { messageFor } from "../components/askMessage";

type Tab = "open" | "coming" | "sent";

/** Replies the comic has to look at: a reply nobody could read, or a thumbs-up counted as a yes. */
export const needsYou = (a: Ask) => !a.skipped && ((a.status === "sent" && a.lastReply?.decision === "unclear") || (a.status === "got_it" && Boolean(a.lastReply?.unsure)));

/** Asks: what to ask for now, what is coming, and what has gone out. */
export function Asks() {
  const store = useAsks();
  const roster = useRoster();
  const now = useNowMs();
  const { plan, today } = useAskPlan(now);
  const [tab, setTab] = useState<Tab>("open");
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<PlannedAsk | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [modesOpen, setModesOpen] = useState(false);

  const showMissed = useShowMissedAsks();
  const { voice: voiceDefault } = useAskPrefs();
  const openAll = useMemo(() => openNow(plan), [plan]);
  // A ping day that came and went, with the show still ahead: kept apart so it never reads like a rule that fired today.
  const dueToday = useMemo(() => openAll.filter((a) => a.due !== "overdue"), [openAll]);
  const missed = useMemo(() => (showMissed ? openAll.filter((a) => a.due === "overdue") : []), [openAll, showMissed]);
  const open = useMemo(() => [...dueToday, ...missed], [dueToday, missed]);
  const groups = useMemo(() => upcomingGroups(plan, today, 7), [plan, today]);
  const comingCount = groups.reduce((n, g) => n + g.asks.length, 0);
  const sent = useMemo(
    () =>
      store.asks
        .filter((a) => !a.skipped && ["sent", "got_it", "declined", "no_reply"].includes(a.status) && a.sentAt)
        .sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)) || (b.sentAt ?? 0) - (a.sentAt ?? 0)),
    [store.asks],
  );
  const attention = sent.filter(needsYou).length;
  const waiting = sent.filter((a) => a.status === "sent").length;

  const mark = (id: string, on: boolean) => setBusy((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const send = async (a: PlannedAsk, text?: string, voice?: boolean) => {
    mark(a.id, true);
    try {
      const draft = draftFor(a, text ?? messageFor(a, store.template), voiceDefault);
      await store.sendAsk(voice === undefined ? draft : { ...draft, voice });
      toast.success(`Sent to ${a.curatorName?.split(/\s+/)[0] ?? "the curator"}.`);
      setEditing(null);
    } catch (e) {
      toast.error((e as Error).message || "Couldn't send that.");
    } finally {
      mark(a.id, false);
    }
  };
  const skip = async (a: PlannedAsk) => {
    try {
      await store.skipAsk(a, draftFor(a, messageFor(a, store.template), voiceDefault));
      toast(`Skipped ${a.label}, ${shortDate(a.showDate)}.`);
    } catch {
      toast.error("Couldn't skip that. Try again.");
    }
  };
  const answer = (ask: Ask, d: "got_it" | "declined" | "waiting") => {
    const room = roster.rooms.find((r) => r.id === ask.roomId);
    store.answerAsk(ask, d, room).then(
      () => toast.success(d === "got_it" ? "Added to My spots." : d === "declined" ? "Marked as a no." : "Back to waiting."),
      () => toast.error("Couldn't save that. Try again."),
    );
  };

  const card = (a: PlannedAsk) => (
    <li key={a.id} className="min-w-0">
      <AskOpenCard a={a} template={store.template} now={now} today={today} busy={busy.has(a.id)} onSend={() => void send(a)} onSkip={() => void skip(a)} onEdit={() => setEditing(a)} />
    </li>
  );
  const noRooms = !roster.loading && roster.rooms.length === 0;
  return (
    <div className="w-full">
      <PageHeader
        width="narrow"
        title="Asks"
        actions={
          <Menu align="right" trigger={(openMenu) => <IconButton icon={IconMenuDots} label="Ask settings" onClick={openMenu} />}>
            {(close) => (
              <>
                <MenuItem onClick={() => { close(); setTemplateOpen(true); }}>Ask message</MenuItem>
                <MenuItem onClick={() => { close(); setModesOpen(true); }}>Send or review, per room</MenuItem>
              </>
            )}
          </Menu>
        }
        bar={
          <Segmented
            full
            compact
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: "open", label: "Open", badge: open.length || undefined },
              { value: "coming", label: "Coming", badge: comingCount || undefined },
              { value: "sent", label: "Sent", badge: attention ? "!" : waiting || undefined },
            ]}
          />
        }
      />

      <Page gap={4}>
        {store.loading || roster.loading ? (
          <div className="grid place-items-center py-16 text-primary"><Spinner className="size-8" /></div>
        ) : noRooms ? (
          <EmptyState icon={IconRoom} title="Add your rooms first" action={<Link to="/rooms"><Button icon={IconPlus}>Go to Rooms</Button></Link>}>
            Asks come from your rooms: which shows, who curates them and when to ask. Add them, or load the Bangalore starter.
          </EmptyState>
        ) : tab === "open" ? (
          <>
            {attention > 0 && (
              <button onClick={() => setTab("sent")} className="state-layer pressable flex min-h-14 min-w-0 items-center gap-3 rounded-lg bg-secondary-container px-4 py-3 text-left text-on-secondary-container">
                <IconChat aria-hidden className="icon size-6 flex-none" />
                <span className="min-w-0 flex-1 type-title-s">{attention === 1 ? "A reply needs a look" : `${attention} replies need a look`}</span>
                <span className="type-label-l">See</span>
              </button>
            )}
            {open.length === 0 ? (
              <EmptyState icon={IconClock} title="Nothing to ask right now">
                {groups[0] ? `The next ask opens ${askDayLabel(groups[0].date, today).toLowerCase()}: ${groups[0].asks[0]!.label}.` : "When a room's ask window opens, it shows up here."}
              </EmptyState>
            ) : (
              <>
                {dueToday.length > 0 && (
                  <Section title="Due today" count={dueToday.length}>
                    <ul className="grid grid-cols-[minmax(0,1fr)] gap-3">{dueToday.slice(0, showAll ? undefined : 12).map(card)}</ul>
                  </Section>
                )}
                {missed.length > 0 && (
                  <Section title="Missed: still time to ask" count={missed.length}>
                    <ul className="grid grid-cols-[minmax(0,1fr)] gap-3">{missed.slice(0, showAll ? undefined : 12).map(card)}</ul>
                  </Section>
                )}
              </>
            )}
            {open.length > 12 && !showAll && (
              <Button variant="tonal" onClick={() => setShowAll(true)} className="self-center">
                Show {open.length - 12} more
              </Button>
            )}
          </>
        ) : tab === "coming" ? (
          groups.length === 0 ? (
            <EmptyState icon={IconClock} title="Nothing coming up this week">Asks that open in the next 7 days will be listed here, by the day they open.</EmptyState>
          ) : (
            groups.map((g) => (
              <Section key={g.date} title={`Opens ${askDayLabel(g.date, today).toLowerCase()}`} count={g.asks.length}>
                <ul className="grid grid-cols-[minmax(0,1fr)] gap-2">
                  {g.asks.map((a) => (
                    <li key={a.id} className="min-w-0">
                      <AskUpcomingRow a={a} today={today} onSkip={() => void skip(a)} />
                    </li>
                  ))}
                </ul>
              </Section>
            ))
          )
        ) : sent.length === 0 ? (
          <EmptyState icon={IconChat} title="No asks sent yet">When you send an ask, it waits here for the curator's reply. Replies are read for you.</EmptyState>
        ) : (
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-3">
            {sent.map((a) => (
              <li key={a.id} className="min-w-0">
                <AskSentCard ask={a} now={now} onAnswer={(d) => answer(a, d)} />
              </li>
            ))}
          </ul>
        )}
      </Page>

      <AskEditSheet ask={editing} message={editing ? messageFor(editing, store.template) : ""} onClose={() => setEditing(null)} onSend={(text, voice) => editing && void send(editing, text, voice)} />
      <TemplateSheet open={templateOpen} onClose={() => setTemplateOpen(false)} />
      <RoomModesSheet open={modesOpen} onClose={() => setModesOpen(false)} />
    </div>
  );
}

