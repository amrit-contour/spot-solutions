// Settings → Watch show groups: read the groups linked to your shows for "running late", "can't make it", "reached" from comics on the
// lineup, and show a pill on their row. Notify only by default; a clear cancellation can use the automatic flow from "Replies to comics".
import { LIVE_KINDS, showWatchOf, type LiveKind } from "@spot/shared";
import { Info, SettingRow, Switch, cx } from "@spot/ui";
import { IconGroup } from "@spot/ui";
import { useApp } from "../lib/app";

const KINDS: Record<LiveKind, { label: string; info: string }> = {
  late: { label: "Running late", info: "“Stuck in traffic”, “10 mins late”, “thoda late”. The pill shows their ETA when they give one." },
  cancel: { label: "Wants to cancel", info: "“Can't make it”, “nahi aa paunga”, “cancel my spot”. You choose what happens, unless you turned on sending without asking under Replies to comics." },
  swap: { label: "Asks to swap", info: "“Can someone take my spot?”, “can I go earlier?”." },
  here: { label: "Arrived", info: "“Reached”, “I'm here”. Shows a Here tick on their row." },
  question: { label: "Asks you something", info: "A question about their own slot or order." },
};

export function ShowWatchCard() {
  const { settings, saveSettings } = useApp();
  const w = showWatchOf(settings);
  const auto = settings.selfService.enabled && settings.selfService.autoSend;
  return (
    <section className="rounded-xl bg-surface-low p-4 sm:p-6">
      <header className="mb-5 flex items-center gap-3">
        <span className="grid size-10 flex-none place-items-center rounded-md bg-secondary-container text-on-secondary-container">
          <IconGroup className="icon size-5" />
        </span>
        <h2 className="min-w-0 type-title-l">Watch show groups</h2>
        <Info label="About Watch show groups">
          Reads messages in the WhatsApp groups linked to your shows, but only from comics on that show's current or next lineup, and only the ones that sound like running late, cancelling, swapping or arriving. Everything else is ignored and never stored. A matching message keeps just who, what, when and a short quote, shown as a pill on their row until the show is over.
        </Info>
        <div className="flex-1" />
        <Switch checked={w.enabled} onChange={(v) => saveSettings({ showWatch: { ...w, enabled: v } })} label="Watch show groups" />
      </header>
      <div className={cx(!w.enabled && "pointer-events-none opacity-50")}>
        {LIVE_KINDS.map((k) => (
          <SettingRow key={k} label={KINDS[k].label} info={<>{KINDS[k].info}</>}>
            <Switch checked={w.kinds[k]} onChange={(v) => saveSettings({ showWatch: { ...w, kinds: { ...w.kinds, [k]: v } } })} label={KINDS[k].label} />
          </SettingRow>
        ))}
        <p className="mt-3 type-body-s text-on-surface-variant">
          {auto
            ? "Automatic cancellation is on (Replies to comics): a clear “can't make it” takes the comic off the lineup and out of the group on the show day, and you are told. Unclear ones only notify you."
            : "Notify only: you get an update (and a push) and a pill with Remove or Ignore. Turn on “Send without asking me” under Replies to comics to let clear cancellations run by themselves."}
        </p>
      </div>
    </section>
  );
}
