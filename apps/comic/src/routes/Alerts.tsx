import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { clashNote, localDate, type GroupUpdate, type SpotAlert } from "@spot/shared";
import { Button, Chip, Empty, IconBell, IconCheck, IconClose, IconGroup, IconInbox, IconWarn, PageHeader, SectionTitle, Spinner } from "@spot/ui";
import { TZ, applyUpdate, dismissAlert, dismissUpdate, gotTheSpot, splitAlerts, useClock, useGroupUpdates, useMySpotList, useSpotAlerts, useWatchedGroups } from "../lib/alerts";
import { RosterProvider, useFirestoreRoster, useRoster } from "../lib/roster";
import { ago } from "../lib/time";
import { AlertAskSheet } from "../components/AlertAskSheet";
import { AlertCard } from "../components/AlertCard";
import { PushPrompt } from "../components/PushPrompt";

/** Alerts: spots offered in the groups you watch (act on them now), and closures or curator changes waiting for you to apply. */
export function Alerts({ uid }: { uid: string }) {
  const store = useFirestoreRoster(uid);
  return (
    <RosterProvider store={store}>
      <AlertsPage uid={uid} />
    </RosterProvider>
  );
}

function AlertsPage({ uid }: { uid: string }) {
  const roster = useRoster();
  const alerts = useSpotAlerts(uid);
  const updates = useGroupUpdates(uid);
  const spots = useMySpotList(uid);
  const groups = useWatchedGroups(uid);
  const now = useClock();
  const today = localDate(new Date(now), TZ);
  const [params, setParams] = useSearchParams();
  const focusId = params.get("alert");
  const [asking, setAsking] = useState<string | null>(null);
  const { open, earlier } = useMemo(() => splitAlerts(alerts.data, now), [alerts.data, now]);

  // A tap on the notification's "Ask for it" lands here with ?alert=ID&ask=1: open the ask for that alert, ready to send.
  const wantAsk = params.get("ask") === "1";
  useEffect(() => {
    if (!wantAsk || !focusId || alerts.loading) return;
    if (alerts.data.some((a) => a.id === focusId)) setAsking(focusId);
    else toast("That offer is gone.");
    const next = new URLSearchParams(params);
    next.delete("ask");
    setParams(next, { replace: true });
  }, [wantAsk, focusId, alerts.loading, alerts.data, params, setParams]);
  const scrolled = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId || alerts.loading || scrolled.current === focusId) return;
    const el = document.getElementById(`alert-${focusId}`);
    if (el) {
      scrolled.current = focusId;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [focusId, alerts.loading, alerts.data]);

  const asked = alerts.data.find((a) => a.id === asking) ?? null;
  const pending = updates.data.filter((u) => u.status === "pending").sort((a, b) => b.receivedAt - a.receivedAt);
  const heads = updates.data.filter((u) => u.status === "info").sort((a, b) => b.receivedAt - a.receivedAt);
  const done = updates.data.filter((u) => u.status === "applied").sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 5);
  const loading = alerts.loading || updates.loading;
  const nothing = !loading && !open.length && !earlier.length && !pending.length && !heads.length && !done.length;

  const card = (a: SpotAlert) => (
    <li key={a.id} className="min-w-0">
      <AlertCard
        alert={a}
        now={now}
        today={today}
        clash={clashNote(a, spots.data)}
        highlight={focusId === a.id}
        onAsk={() => setAsking(a.id)}
        onDismiss={() => void dismissAlert(uid, a.id)}
        onGotIt={() => {
          void gotTheSpot(uid, a, a.times[0]).then(() => dismissAlert(uid, a.id));
          toast.success("Added to My spots");
        }}
      />
    </li>
  );

  return (
    <div className="w-full">
      <PageHeader title="Alerts" subtitle="Spots offered in your groups, as they happen." />
      <div className="flex min-w-0 flex-col gap-6 px-4 pt-4 pb-[calc(var(--nav-h)+2rem)] sm:px-8 sm:pb-12">
        <PushPrompt uid={uid} />

        {!groups.loading && groups.data.length === 0 && (
          <div className="flex min-w-0 items-start gap-3 rounded-lg bg-surface-low p-4">
            <span className="grid size-10 flex-none place-items-center rounded-md bg-tertiary-container text-on-tertiary-container">
              <IconGroup className="icon size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="type-title-m">No groups watched yet</p>
              <p className="mt-0.5 type-body-m text-on-surface-variant">Pick the WhatsApp groups where spots get posted. Only those are read.</p>
              <Link to="/groups" className="mt-3 inline-block type-label-l text-primary">
                Choose groups
              </Link>
            </div>
          </div>
        )}

        {loading && (
          <div className="grid place-items-center py-12 text-primary">
            <Spinner className="size-8" />
          </div>
        )}

        {!loading && open.length > 0 && (
          <section aria-label="Open spots">
            <SectionTitle>Open now</SectionTitle>
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">{open.map(card)}</ul>
          </section>
        )}

        {!loading && pending.length > 0 && (
          <section aria-label="To review">
            <SectionTitle>To review</SectionTitle>
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">
              {pending.map((u) => (
                <li key={u.id} className="min-w-0">
                  <UpdateCard u={u} now={now} onApply={() => applyUpdate(uid, u, roster).then(() => toast.success("Applied to your rooms"), (e: Error) => void toast.error(e.message))} onDismiss={() => void dismissUpdate(uid, u.id)} />
                </li>
              ))}
            </ul>
          </section>
        )}

        {!loading && heads.length > 0 && (
          <section aria-label="Heads up">
            <SectionTitle>Heads up</SectionTitle>
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">
              {heads.map((u) => (
                <li key={u.id} className="min-w-0">
                  <UpdateCard u={u} now={now} onDismiss={() => void dismissUpdate(uid, u.id)} />
                </li>
              ))}
            </ul>
          </section>
        )}

        {nothing && (
          <Empty icon={IconBell} title="Nothing on offer right now">
            When someone posts spots in a group you watch, it shows up here and on your phone straight away.
          </Empty>
        )}
        {!loading && !nothing && !open.length && !pending.length && (
          <p className="type-body-m text-on-surface-variant">No spots on offer right now. You'll be notified when one comes up.</p>
        )}

        {!loading && done.length > 0 && (
          <section aria-label="Applied">
            <SectionTitle>Applied by itself</SectionTitle>
            <ul className="flex flex-col gap-2">
              {done.map((u) => (
                <li key={u.id} className="flex min-w-0 items-center gap-3 rounded-lg bg-surface-low p-3 pl-4">
                  <IconCheck aria-hidden className="icon size-5 flex-none text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate type-body-m">{u.summary}</span>
                    <span className="block truncate type-body-s text-on-surface-variant">
                      {u.groupName ? `${u.groupName} · ` : ""}
                      {ago(u.receivedAt, now)}
                    </span>
                  </span>
                  <Button variant="text" size="sm" onClick={() => void dismissUpdate(uid, u.id)}>
                    Clear
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {!loading && earlier.length > 0 && (
          <section aria-label="Earlier">
            <SectionTitle>Earlier</SectionTitle>
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">{earlier.map(card)}</ul>
          </section>
        )}
      </div>

      <AlertAskSheet uid={uid} alert={asked} spots={spots.data} today={today} now={now} onClose={() => setAsking(null)} onSent={() => undefined} />
    </div>
  );
}

const KIND_LABEL: Record<GroupUpdate["kind"], string> = { closure: "Full", schedule: "Curators", opening: "Opening" };

/** A closure, a curator schedule or an opening notice from a group. */
function UpdateCard({ u, now, onApply, onDismiss }: { u: GroupUpdate; now: number; onApply?: () => Promise<unknown> | void; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg bg-surface-low p-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid size-10 flex-none place-items-center rounded-md bg-secondary-container text-on-secondary-container">
          {u.kind === "closure" ? <IconWarn className="icon size-5" /> : <IconInbox className="icon size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="type-title-m">{u.summary}</p>
          <p className="truncate type-body-s text-on-surface-variant">
            {u.groupName ? `${u.groupName} · ` : ""}
            {ago(u.receivedAt, now)}
          </p>
        </div>
        <Chip tone={u.kind === "closure" ? "error" : "neutral"} className="flex-none">
          {KIND_LABEL[u.kind]}
        </Chip>
      </div>
      {u.text && <p className="line-clamp-2 type-body-s text-on-surface-variant">“{u.text}”</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="text" size="sm" icon={IconClose} onClick={onDismiss}>
          {onApply ? "Not now" : "Clear"}
        </Button>
        {onApply && (
          <Button
            size="sm"
            icon={IconCheck}
            loading={busy}
            onClick={() => {
              setBusy(true);
              void Promise.resolve(onApply()).finally(() => setBusy(false));
            }}
          >
            {u.kind === "closure" ? "Mark full" : "Update curators"}
          </Button>
        )}
      </div>
    </div>
  );
}
