import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  DAY_NAMES,
  DEFAULT_ACK_TEMPLATE,
  DEFAULT_CANCEL_SPOT_TEMPLATE,
  DEFAULT_CONFIRM_TEMPLATE,
  DEFAULT_REJECT_TEMPLATE,
  TEMPLATE_VARIABLES,
  closedRequestsWeeks,
  clampScanDays,
  SCAN_DAYS_MAX,
  SCAN_DAYS_MIN,
  COOLDOWN_MAX_WEEKS,
  GROUP_POST_KEYS,
  cooldownWeeks,
  MESSAGE_GROUPS,
  MESSAGE_TYPES,
  messageRich,
  OFFER_POLL_OPTIONS,
  snippetRich,
  storeMessage,
  pollProblem,
  voiceSourcesSummary,
  type GroupInfo,
  type RichMessage,
  type MessageKind,
  type MessageKey,
  type Snippet,
  type VoiceKind,
} from "@spot/shared";
import { useApp } from "../lib/app";
import { runCommand } from "../lib/data";
import { useCollection } from "../lib/data";
import { useInstall } from "../lib/install";
import { PageHeader } from "@spot/ui";
import { StickyBar } from "@spot/ui";
import { ConnectCard } from "../components/ConnectCard";
import { AgentCard } from "../components/AgentCard";
import { AiModels } from "../components/AiModels";
import { AiPolicyPicker } from "../components/AiPolicy";
import { FleetCard } from "../components/FleetCard";
import { NotifyCard } from "../components/NotifyCard";
import { GoogleContactsCard } from "../components/GoogleContactsCard";
import { AppearanceCard } from "../components/AppearanceCard";
import { VoiceSourcesSheet } from "../components/VoiceSourcesSheet";
import { isDemoUser } from "../lib/demo";
import { MessageComposer } from "@spot/ui";
import { Bubble, Button, Field, Info, Segmented, Select, SettingRow, Stepper, Switch, TextArea, TextInput, TimePicker, cx } from "@spot/ui";
import { IconChat, IconChatCheck, IconChatCross, IconCheck, IconCpu, IconMic, IconPhone, IconShield, IconTemplate, IconTrash, IconAdd, IconSparkle, IconClose } from "@spot/ui";

const TABS = [
  { id: "whatsapp", label: "WhatsApp", icon: IconChat },
  { id: "app", label: "App", icon: IconPhone },
  { id: "messages", label: "Messages", icon: IconChat },
  { id: "rules", label: "Rules & replies", icon: IconShield },
  { id: "show", label: "Around the show", icon: IconMic },
  { id: "ai", label: "AI models", icon: IconCpu },
] as const;
type TabId = (typeof TABS)[number]["id"];

function useSettingsTab(): TabId {
  const { hash } = useLocation();
  const id = hash.replace("#", "");
  return (TABS.some((t) => t.id === id) ? id : "whatsapp") as TabId;
}

/** Side menu on desktop, scrolling tabs on phones. One topic on screen at a time. Both stay put while the page scrolls. */
function SettingsLinks({ current, vertical }: { current: TabId; vertical?: boolean }) {
  return (
    <nav aria-label="Settings sections" className={cx("flex gap-1", vertical ? "flex-col" : "-mx-4 overflow-x-auto px-4 py-2 [scrollbar-width:none] sm:-mx-8 sm:px-8")}>
      {TABS.map((t) => {
        const active = t.id === current;
        return (
          <Link
            key={t.id}
            to={`#${t.id}`}
            replace
            aria-current={active ? "page" : undefined}
            className={cx(
              "state-layer relative flex flex-none items-center gap-2.5 rounded-full px-4 type-label-l whitespace-nowrap",
              vertical ? "h-12" : "h-10",
              active ? "text-on-secondary-container" : "text-on-surface-variant",
            )}
          >
            {active && <motion.span layoutId={vertical ? "settings-tab-side" : "settings-tab"} className="absolute inset-0 rounded-full bg-secondary-container" transition={{ type: "spring", duration: 0.4, bounce: 0.15 }} />}
            <t.icon className="icon relative size-5" />
            <span className="relative">{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function Section({ title, icon: I, description, children, aside }: { title: string; icon: typeof IconChat; description?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-xl bg-surface-low p-4 sm:p-6">
      {/* Header: icon beside a title+description block, so the text shares one left edge.
          The body below spans the card, lining up with the icon. */}
      <header className="mb-5 flex items-center gap-3">
        <span className="grid size-10 flex-none place-items-center rounded-md bg-secondary-container text-on-secondary-container">
          <I className="icon size-5" />
        </span>
        <h2 className="min-w-0 type-title-l">{title}</h2>
        {description && <Info label={`About ${title}`}>{description}</Info>}
        <div className="flex-1" />
        {aside && <div className="flex flex-none items-center gap-2">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

/** Variables only some messages have, on top of TEMPLATE_VARIABLES. */
const EXTRA_VARIABLES = [
  { key: "shows", label: "Every active show" },
  { key: "lastShow", label: "Last show they did" },
  { key: "lastDate", label: "Date of their last show" },
  { key: "opens", label: "When requests open" },
  { key: "lastWhen", label: "When they were last up" },
  { key: "askAgain", label: "When they can ask again" },
  { key: "pocs", label: "POCs (tagged)" },
  { key: "lineup", label: "Running order" },
  { key: "count", label: "Number of comics" },
];
const ALL_VARIABLES: { key: string; label: string }[] = [...TEMPLATE_VARIABLES, ...EXTRA_VARIABLES];

const asText = (body: string): RichMessage => ({ kind: "text", body });

/** Edits one message: text with formatting, or (where allowed) a poll or a venue pin, with a live WhatsApp preview. */
function TemplateEditor({ value, onSave, fallback, extraVars, disabled, keys, kinds = ["text"], attach, offer, savedLabel = "Template saved" }: { value: RichMessage; onSave: (v: RichMessage) => Promise<void>; fallback: RichMessage; extraVars?: Record<string, string | number | null | undefined>; disabled?: boolean; keys?: readonly string[]; kinds?: MessageKind[]; attach?: boolean; offer?: boolean; savedLabel?: string }) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const stamp = JSON.stringify(value);
  useEffect(() => setDraft(value), [stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(draft) !== stamp;
  const problem = draft.kind === "poll" ? pollProblem(draft.poll) : null;

  return (
    <div className={cx("flex flex-col gap-3", disabled && "pointer-events-none opacity-50")}>
      <MessageComposer
        value={draft}
        onChange={(m) => setDraft(offer && m.kind === "poll" ? { ...m, poll: { question: m.poll?.question ?? "", options: [...OFFER_POLL_OPTIONS], multi: false } } : m)}
        kinds={kinds}
        attach={attach}
        offer={offer}
        variables={keys ? ALL_VARIABLES.filter((v) => keys.includes(v.key)) : TEMPLATE_VARIABLES}
        extraVars={extraVars}
        idPrefix={`tpl-${stamp.length}`}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="text" className="-ml-3" onClick={() => setDraft(fallback)} disabled={JSON.stringify(draft) === JSON.stringify(fallback)}>
          Reset to default
        </Button>
        <div className="flex-1" />
        {dirty && (
          <Button size="sm" variant="text" onClick={() => setDraft(value)}>
            Discard
          </Button>
        )}
        <Button
          size="sm"
          disabled={!dirty}
          loading={saving}
          onClick={async () => {
            if (problem) return void toast.error(problem);
            setSaving(true);
            try {
              await onSave(draft);
              toast.success(savedLabel);
            } finally {
              setSaving(false);
            }
          }}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const { settings, saveSettings } = useApp();
  const [withMinutes, setWithMinutes] = useState(true);

  const tab = useSettingsTab();
  const { search } = useLocation();
  const [msg, setMsg] = useState<MessageChoice>(() => (new URLSearchParams(search).get("msg") as MessageChoice | null) ?? "ack");
  const extra = MESSAGE_TYPES.find((m) => m.key === msg);

  return (
    <div className="w-full">
      <PageHeader title="Settings" subtitle="How Nothing BOT Curating talks on your behalf" />
      <div className="flex flex-col gap-6 px-4 pb-12 sm:px-8 lg:flex-row lg:items-start lg:gap-8">
        {/* Phones and tablets: a bar pinned under the top edge. `contents` keeps it a direct child of the page column, so it sticks for the whole page. */}
        <div className="contents lg:hidden">
          <StickyBar title="Settings" className="-mt-2">
            <SettingsLinks current={tab} />
          </StickyBar>
        </div>
        <div className="hidden w-60 flex-none lg:sticky lg:top-[calc(1.5rem+env(safe-area-inset-top)+var(--page-header-h,0px))] lg:block">
          <SettingsLinks current={tab} vertical />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-4">
        {tab === "whatsapp" && (
          <>
            <ConnectCard />
            <AgentCard />
            <FleetCard />
          </>
        )}
        {tab === "app" && (
          <>
            <AppearanceCard />
            <NotifyCard />
            <GoogleContactsCard />
            <InstallCard />
          </>
        )}
        {tab === "messages" && (
          <>
            <VoiceSection kind={voiceKindOf(msg)} />
            <MessagePicker value={msg} onChange={setMsg} />

        {msg === "ack" && (
<Section
          title="Auto-acknowledge"
          icon={IconChat}
          description={
            <>
              Off by default. When on, it replies only when Gemma quotes a clear ask at 85%+ confidence, in a message that arrived in the last 10 minutes. It never replies to businesses or to old messages (including ones read by Scan past messages), and sends at most once per comic per week.
            </>
          }
          aside={<Switch checked={settings.ack.enabled} onChange={(v) => saveSettings({ ack: { ...settings.ack, enabled: v } })} label="Auto-acknowledge" />}
        >
          <TemplateEditor value={asText(settings.ack.template)} fallback={asText(DEFAULT_ACK_TEMPLATE)} disabled={!settings.ack.enabled} onSave={(m) => saveSettings({ ack: { ...settings.ack, template: m.body } })} />
        </Section>
        )}

        {msg === "confirm" && (
<Section
          title="Confirmation message"
          icon={IconChatCheck}
          description={
            <>
              Sent when you confirm a lineup. Wrap optional bits in <code className="font-mono text-[0.85em]">{"{{#minutes}}…{{/minutes}}"}</code> and they disappear for shows without a set length.
            </>
          }
          aside={
            <label className="hidden items-center gap-2 type-label-m text-on-surface-variant sm:flex">
              Preview with set length
              <Switch checked={withMinutes} onChange={setWithMinutes} label="Preview with set length" />
            </label>
          }
        >
          <TemplateEditor value={{ kind: "text", body: settings.confirm.template, attachLocation: settings.confirm.attachLocation }} fallback={asText(DEFAULT_CONFIRM_TEMPLATE)} attach extraVars={{ minutes: withMinutes ? 5 : null }} onSave={(m) => saveSettings({ confirm: { template: m.body, attachLocation: Boolean(m.attachLocation) } })} />
        </Section>
        )}

        {msg === "cancel" && (
<Section
          title="Cancelled spot message"
          icon={IconChatCross}
          description="Sent when you take someone off a lineup you already confirmed, and you tick them in Send updates. Nothing goes out without that review."
        >
          <TemplateEditor value={asText(settings.cancelSpot.template)} fallback={asText(DEFAULT_CANCEL_SPOT_TEMPLATE)} onSave={(m) => saveSettings({ cancelSpot: { template: m.body } })} />
        </Section>
        )}

        {extra && <MessageSection key={extra.key} type={extra.key} />}
        {msg === "snippets" && <SnippetsSection />}

        {msg === "reject" && (
<Section
          title="Regret message"
          icon={IconChatCross}
          description="When every show for the week is confirmed or cancelled, anyone who asked but wasn't placed gets this. Dismissed requests are skipped."
          aside={<Switch checked={settings.reject.enabled} onChange={(v) => saveSettings({ reject: { ...settings.reject, enabled: v } })} label="Send regret messages" />}
        >
          <TemplateEditor value={asText(settings.reject.template)} fallback={asText(DEFAULT_REJECT_TEMPLATE)} disabled={!settings.reject.enabled} onSave={(m) => saveSettings({ reject: { ...settings.reject, template: m.body } })} />
        </Section>
        )}

          </>
        )}
        {tab === "rules" && (
          <>
        <RulesSection />

        <Section
          title="Replies to comics"
          icon={IconChat}
          description="When a booked comic writes “can't make it Monday”, “am I up this week?” or “when was my last spot?”, Gemma drafts a reply under Requests → Needs a reply."
          aside={<Switch checked={settings.selfService.enabled} onChange={(v) => saveSettings({ selfService: { ...settings.selfService, enabled: v } })} label="Draft replies to comics" />}
        >
          <SettingRow label="Send without asking me" info={<>Off: nothing goes out until you tap Send. On: replies go out straight away (fresh messages from people only), and a cancellation frees the slot automatically.</>} className={cx(!settings.selfService.enabled && "pointer-events-none opacity-50")}>
            <Switch checked={settings.selfService.autoSend} onChange={(v) => saveSettings({ selfService: { ...settings.selfService, autoSend: v } })} label="Send replies automatically" />
          </SettingRow>
          <SettingRow label="Ask new faces who they are" info={<>When someone you haven't saved asks for a spot, draft “What's your name, which scene are you from, how long have you been doing comedy?”. Their answer fills in their profile.</>}>
            <Switch checked={settings.onboarding.enabled} onChange={(v) => saveSettings({ onboarding: { enabled: v } })} label="Ask new faces who they are" />
          </SettingRow>
        </Section>

        <Section
          title="Follow-ups from your replies"
          icon={IconChatCheck}
          description="Answered someone yourself in WhatsApp (“haan bhai, Monday done” or “sorry, full this week”)? Every 20 minutes Nothing BOT Curating reads your own replies to people still Waiting this week. When your words are clear, it suggests placing them (and adding them to the show's group if they aren't in it) or closing their request. Nothing is sent to anyone. Group removals stay with each show's group update."
          aside={<Switch checked={settings.followUp?.enabled ?? true} onChange={(v) => saveSettings({ followUp: { enabled: v, auto: settings.followUp?.auto ?? false } })} label="Check my replies" />}
        >
          <SettingRow label="Apply them without asking me" info={<>Off: each one lands in Updates → You already replied, for you to Apply or Ignore. On: clear ones are applied straight away and you get a note in Updates.</>} className={cx(!(settings.followUp?.enabled ?? true) && "pointer-events-none opacity-50")}>
            <Switch checked={Boolean(settings.followUp?.auto)} onChange={(v) => saveSettings({ followUp: { enabled: settings.followUp?.enabled ?? true, auto: v } })} label="Apply follow-ups automatically" />
          </SettingRow>
        </Section>

        <DataSection />

          </>
        )}
        {tab === "show" && <AfterShowSection />}
        {tab === "ai" && (

        <Section title="AI models" icon={IconCpu} description="Pick which model reads your DMs, and a backup. Local Ollama keeps chats on your server and costs nothing; Gemini is smarter but sends message text to Google.">
          <div className="mb-4">
            <AiPolicyPicker />
          </div>
          <AiModels />
        </Section>
        )}
        </div>

      </div>
    </div>
  );
}

function InstallCard() {
  const { installed, canPrompt, ios, install } = useInstall();
  if (installed) return null;
  return (
    <Section title="Install the app" icon={IconPhone} description="Add Nothing BOT Curating to your home screen. It opens full screen like a native app, and you can triage requests on the go.">
      {canPrompt ? (
        <Button icon={IconCheck} onClick={() => void install().then((ok) => ok && toast.success("Installed. Find it on your home screen."))}>
          Install app
        </Button>
      ) : ios ? (
        <ol className="flex flex-col gap-2 type-body-m text-on-surface-variant">
          <li>1. Open this page in <span className="text-on-surface">Safari</span>.</li>
          <li>2. Tap the <span className="text-on-surface">Share</span> button.</li>
          <li>3. Choose <span className="text-on-surface">Add to Home Screen</span>.</li>
        </ol>
      ) : (
        <p className="type-body-m text-on-surface-variant">
          Open this site in Chrome or Edge, then use the browser menu → <span className="text-on-surface">Install app</span> (or <span className="text-on-surface">Add to Home screen</span> on Android).
        </p>
      )}
    </Section>
  );
}

const DAYS = [1, 2, 3, 4, 5, 6, 0] as const;

function RulesSection() {
  const { settings, saveSettings } = useApp();
  const r = settings.rules;
  const setWindow = (patch: Partial<typeof r.window>) => saveSettings({ rules: { ...r, window: { ...r.window, ...patch } } });
  const daySelect = (value: number, onChange: (d: number) => void) => (
    <Select value={String(value)} onChange={(v) => onChange(Number(v))} options={DAYS.map((d) => ({ value: String(d), label: DAY_NAMES[d] }))} wrapperClassName="w-40 shrink-0" />
  );
  return (
    <Section title="Request rules" icon={IconShield} description="Requests that break a rule go to the Held tab instead of Asked. Nothing is sent to them, and you can still allow any of them. Hosts, ignored and banned comics are set per person in Comics.">
      <div className="flex flex-col gap-6">
        <div>
          <SettingRow label="Request window" info={<>Only take requests during this time each week. Anything else is held as a mid-week ask.</>}>
            <Switch checked={r.window.enabled} onChange={(v) => setWindow({ enabled: v })} label="Request window" />
          </SettingRow>
          {r.window.enabled && (
            <div className="mt-2 mb-2 grid gap-4 rounded-lg bg-surface-container p-4 sm:grid-cols-2">
              <Field label="Opens">
                <div className="flex gap-2">
                  {daySelect(r.window.startDay, (d) => setWindow({ startDay: d as never }))}
                  <TimePicker value={r.window.startTime} onChange={(v) => setWindow({ startTime: v })} wrapperClassName="min-w-0 flex-1" label="Opens at" />
                </div>
              </Field>
              <Field label="Closes">
                <div className="flex gap-2">
                  {daySelect(r.window.endDay, (d) => setWindow({ endDay: d as never }))}
                  <TimePicker value={r.window.endTime} onChange={(v) => setWindow({ endTime: v })} wrapperClassName="min-w-0 flex-1" label="Closes at" />
                </div>
              </Field>
            </div>
          )}
        </div>
        <SettingRow label="Hold recent comics" info={<>Hold requests from anyone who did a spot in the last few weeks, so newer faces get a shot. Ad hoc spots (offers you sent, or spots added after confirming) never count.</>}>
            <Switch checked={r.skipLastWeek} onChange={(v) => saveSettings({ rules: { ...r, skipLastWeek: v } })} label="Hold recent comics" />
          </SettingRow>
        {r.skipLastWeek && (
          <SettingRow label="Recent means within" info={<>1 week is last week only.</>}>
            <Stepper value={cooldownWeeks(r)} onChange={(v) => saveSettings({ rules: { ...r, cooldownWeeks: v } })} min={1} max={COOLDOWN_MAX_WEEKS} suffix={cooldownWeeks(r) === 1 ? "week" : "weeks"} />
          </SettingRow>
        )}
        <SettingRow label="Tell held comics why" info={<>Off by default. When on, someone held by the request window or last week's rule gets one short reply saying why (edit the words in Messages → Held requests). Same safety as auto-acknowledge: clear asks only, fresh messages only, never businesses. Banned, ignored and hosts never get a reply.</>}>
          <Switch checked={Boolean(settings.heldReplies?.enabled)} onChange={(v) => saveSettings({ heldReplies: { ...settings.heldReplies, enabled: v } })} label="Tell held comics why" />
        </SettingRow>
        {settings.heldReplies?.enabled && (
          <SettingRow label="The reply" info={<>Draft for review: it waits in Updates → Needs a reply until you send it.</>}>
            <Segmented
              size="sm"
              value={settings.heldReplies.mode ?? "send"}
              onChange={(v) => saveSettings({ heldReplies: { enabled: true, mode: v } })}
              options={[
                { value: "send", label: "Send it" },
                { value: "review", label: "Draft for review" },
              ]}
            />
          </SettingRow>
        )}
        <SettingRow label="Scan past messages: days to look back" info={<>The starting choice when you run Requests → Scan past messages. Nothing BOT Curating only reads older DMs when you run that scan yourself.</>}>
          <Stepper value={clampScanDays(settings.scanDays)} onChange={(v) => saveSettings({ scanDays: v })} min={SCAN_DAYS_MIN} max={SCAN_DAYS_MAX} suffix="days" />
        </SettingRow>
      </div>
    </Section>
  );
}

function DataSection() {
  const { settings, saveSettings } = useApp();
  const weeks = closedRequestsWeeks(settings);
  return (
    <Section
      title="Data"
      icon={IconShield}
      description="Nothing BOT Curating tidies up old requests once a day, on your server. Lineups, comics and their history are never deleted."
    >
      <SettingRow
        label="Delete closed requests after"
        info={<>Requests you dismissed, requests that got a regret message, and confirmed requests are deleted once their week is this many weeks old. Open and placed requests are kept. Set 0 to keep everything forever.</>}
      >
        <Stepper value={weeks} onChange={(v) => saveSettings({ retention: { closedRequestsWeeks: v } })} min={0} max={104} suffix="wks" />
      </SettingRow>
      <p className="mt-2 type-body-s text-on-surface-variant">
        {weeks === 0 ? "Closed requests are kept forever." : `Closed requests from more than ${weeks} week${weeks === 1 ? "" : "s"} ago are deleted automatically. Lineups, comics and history stay.`}
      </p>
    </Section>
  );
}

function AfterShowSection() {
  const { uid, settings, saveSettings } = useApp();
  const groups = useCollection<GroupInfo>(uid, "groups");
  const m = settings.micCheck;
  return (
    <Section title="Around the show" icon={IconMic} description="Hosts' availability, last-minute spot offers, and checking the mic actually happened.">
      <div className="flex flex-col gap-4">
        <Field label="Hosts group" info="“Ask hosts” on the Lineup page sends this group a poll of the week's shows. Votes show up on each show as “Hosts free”.">
          <Select value={settings.hostPoll.groupId ?? ""} onChange={(v) => saveSettings({ hostPoll: { groupId: v || null } })} placeholder="None" options={groups.data.map((g) => ({ value: g.id, label: g.name }))} />
        </Field>
        <div className="grid gap-x-8 gap-y-2 rounded-lg bg-surface-container px-4 py-2 md:grid-cols-2">
          <SettingRow label="Spot offers expire after" info="Offer a spot from a show's menu on the Lineup page. No reply in time and the offer lapses.">
            <Stepper value={settings.offers.expiryHours} onChange={(v) => saveSettings({ offers: { ...settings.offers, expiryHours: v } })} min={1} max={48} suffix="h" />
          </SettingRow>
          <SettingRow label="Offers to several: add the first yeses" info="When you offer a spot to several comics at once, the first yeses fill it on their own. Off: everyone who says yes comes to Updates and you pick; the rest are told it's filled. An offer to one comic always books on yes.">
            <Switch checked={settings.offers.autoAdd !== false} onChange={(v) => saveSettings({ offers: { ...settings.offers, autoAdd: v } })} label="In an offer to several comics, add the first yeses automatically" />
          </SettingRow>
          <SettingRow label="Did the mic happen?" info="The morning after each show, Requests asks you. “No” stops it counting as anyone's spot.">
            <Switch checked={m.enabled} onChange={(v) => saveSettings({ micCheck: { ...m, enabled: v } })} label="Mic check" />
          </SettingRow>
          {m.enabled && (
            <>
              <SettingRow label="Ask from">
                <TimePicker value={m.time} onChange={(v) => saveSettings({ micCheck: { ...m, time: v } })} className="h-10" wrapperClassName="w-36" label="Ask from" />
              </SettingRow>
              <SettingRow label="Also ask on WhatsApp" info="In your “Message yourself” chat, or from the agent number when it's linked (see Agent number). Reply yes or no there.">
                <Switch checked={m.whatsapp} onChange={(v) => saveSettings({ micCheck: { ...m, whatsapp: v } })} label="Ask on WhatsApp" />
              </SettingRow>
            </>
          )}
        </div>
      </div>
    </Section>
  );
}

type MessageChoice = "ack" | "confirm" | "cancel" | "reject" | MessageKey | "snippets";

const LINEUP_MESSAGES: { value: MessageChoice; label: string }[] = [
  { value: "ack", label: "Acknowledge" },
  { value: "confirm", label: "Confirmation" },
  { value: "cancel", label: "Cancelled spot" },
  { value: "reject", label: "Regret" },
];

/** Every message, grouped, as chips that wrap on phones. */
function MessagePicker({ value, onChange }: { value: MessageChoice; onChange: (v: MessageChoice) => void }) {
  const groups = [
    { id: "lineup", label: "Lineup", items: LINEUP_MESSAGES },
    ...MESSAGE_GROUPS.map((g) => ({ id: g.id, label: g.label, items: MESSAGE_TYPES.filter((m) => m.group === g.id).map((m) => ({ value: m.key as MessageChoice, label: m.label })) })),
    { id: "mine", label: "Your templates", items: [{ value: "snippets" as MessageChoice, label: "Saved replies" }] },
  ];
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-surface-low p-4 sm:p-5" role="radiogroup" aria-label="Message to edit">
      {groups.map((g) => (
        <div key={g.id} className="flex flex-col gap-1.5 sm:flex-row sm:items-baseline sm:gap-4">
          <span className="w-36 flex-none type-label-m text-on-surface-variant">{g.label}</span>
          <div className="flex flex-wrap gap-1.5">
            {g.items.map((it) => {
              const on = it.value === value;
              return (
                <button
                  key={it.value}
                  role="radio"
                  aria-checked={on}
                  onClick={() => onChange(it.value)}
                  className={cx("state-layer pressable h-8 rounded-sm px-3 type-label-l", on ? "bg-secondary-container text-on-secondary-container" : "border border-outline-variant text-on-surface-variant")}
                >
                  {it.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function MessageSection({ type }: { type: MessageKey }) {
  const { settings, saveSettings } = useApp();
  const m = MESSAGE_TYPES.find((x) => x.key === type)!;
  const held = m.group === "held";
  const off = held && !settings.heldReplies?.enabled;
  return (
    <Section
      title={m.label}
      icon={IconChat}
      description={
        <>
          {m.when}
          {held && " Banned, ignored and host comics never get a reply."}
          {m.toGroup && " Pick when it goes out for each show in Messages → Groups, or in the show's settings."}
          {m.group === "replies" && " Drafted under Updates → Needs a reply; nothing goes out until you send it, unless “Send without asking me” is on."}
        </>
      }
      aside={held ? <Switch checked={!off} onChange={(v) => saveSettings({ heldReplies: { ...settings.heldReplies, enabled: v } })} label="Tell held comics why" /> : undefined}
    >
      <TemplateEditor
        value={messageRich(settings, type)}
        fallback={{ kind: m.defaultKind ?? "text", body: m.default, ...(m.defaultPoll && { poll: m.defaultPoll }), ...(m.defaultAttachLocation && { attachLocation: true }) }}
        keys={m.toGroup ? [...m.vars] : ["name", ...m.vars]}
        extraVars={m.sample}
        disabled={off}
        kinds={type === "groupWelcome" ? ["text"] : type === "offer" ? ["text", "poll"] : ["text", "poll", "location"]}
        offer={type === "offer"}
        onSave={(msg) => saveSettings({ messages: { ...settings.messages, [type]: storeMessage(msg) } })}
      />
    </Section>
  );
}

const newId = () => Math.random().toString(36).slice(2, 10);

/** Saved replies: drop one into any reply box with the Templates button. */
function SnippetsSection() {
  const { settings, saveSettings } = useApp();
  const list = settings.snippets ?? [];
  const [open, setOpen] = useState<string | null>(list[0]?.id ?? null);
  const current = list.find((s) => s.id === open) ?? null;
  // JSON round trip drops the undefined fields Firestore refuses.
  const save = (next: Snippet[]) => saveSettings({ snippets: JSON.parse(JSON.stringify(next)) as Snippet[] });
  const add = async () => {
    const s: Snippet = { id: newId(), title: "New template", body: "Hey {{name}}! " };
    await save([...list, s]);
    setOpen(s.id);
  };
  return (
    <Section
      title="Saved replies"
      icon={IconTemplate}
      description="Your own templates for things you type again and again: directions, a rules reminder, a waitlist note. Tap Templates on any reply, offer or new-face card to drop one in, with {{name}} filled in for that comic."
      aside={
        <Button size="sm" variant="tonal" icon={IconAdd} onClick={add}>
          New
        </Button>
      }
    >
      {!list.length ? (
        <p className="type-body-m text-on-surface-variant">No saved replies yet. Tap New to write your first one.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-1.5">
            {list.map((s) => (
              <button
                key={s.id}
                onClick={() => setOpen(s.id)}
                aria-pressed={s.id === open}
                className={cx("state-layer pressable h-8 max-w-56 truncate rounded-sm px-3 type-label-l", s.id === open ? "bg-secondary-container text-on-secondary-container" : "border border-outline-variant text-on-surface-variant")}
              >
                {s.title || "Untitled"}
              </button>
            ))}
          </div>
          {current && <SnippetEditor key={current.id} snippet={current} onSave={(patch) => save(list.map((s) => (s.id === current.id ? { ...s, ...patch } : s)))} onDelete={async () => {
            await save(list.filter((s) => s.id !== current.id));
            setOpen(list.find((s) => s.id !== current.id)?.id ?? null);
            toast.success("Template deleted");
          }} />}
        </div>
      )}
    </Section>
  );
}

function SnippetEditor({ snippet, onSave, onDelete }: { snippet: Snippet; onSave: (patch: Partial<Snippet>) => Promise<void>; onDelete: () => Promise<void> }) {
  const [title, setTitle] = useState(snippet.title);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field label="Name">
          <TextInput value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== snippet.title && onSave({ title: title.trim() || "Untitled" })} />
          </Field>
        </div>
        <Button variant="text" icon={IconTrash} onClick={onDelete} aria-label={`Delete ${snippet.title}`}>
          Delete
        </Button>
      </div>
      <TemplateEditor
        value={snippetRich(snippet)}
        fallback={snippetRich(snippet)}
        kinds={["text", "poll", "location"]}
        keys={["name", "show", "venue", "day", "date", "time", "mapsLink"]}
        onSave={(m) => onSave({ title: title.trim() || "Untitled", body: m.body, kind: m.kind, poll: m.poll, attachLocation: m.kind === "text" && m.attachLocation ? true : undefined })}
      />
    </div>
  );
}

const voiceKindOf = (m: MessageChoice): VoiceKind | null =>
  m === "snippets" || m === "groupWelcome" || (GROUP_POST_KEYS as readonly string[]).includes(m) ? null : m === "cancel" ? "cancelSpot" : (m as VoiceKind);

/** Your voice: learn how you write from your own sent messages, then send every message that way. */
function VoiceSection({ kind }: { kind: VoiceKind | null }) {
  const { uid, settings, saveSettings } = useApp();
  const voice = settings.voice ?? { enabled: false, profile: null };
  const profile = voice.profile ?? null;
  const [learning, setLearning] = useState(false);
  const [summary, setSummary] = useState(profile?.summary ?? "");
  const [trying, setTrying] = useState(false);
  const [preview, setPreview] = useState<{ reference: string; drafts: { text: string; problem: string | null }[] } | null>(null);
  const [picking, setPicking] = useState(false);
  const sources = voice.sources ?? { mode: "recommended" as const, chats: [] };
  const demo = isDemoUser();
  useEffect(() => setSummary(profile?.summary ?? ""), [profile?.summary]);
  const setSources = (next: typeof sources) => saveSettings({ voice: { ...voice, sources: next } });

  const save = (patch: Partial<NonNullable<typeof profile>>) => profile && saveSettings({ voice: { ...voice, profile: { ...profile, ...patch } } });
  const learn = async () => {
    if (sources.mode === "selected" && !sources.chats.length) return void toast.error("Pick at least one chat");
    setLearning(true);
    try {
      const r = await runCommand<{ samples: number; examples: number }>(uid, "learn_voice", {}, 15 * 60_000);
      toast.success(`Learned from ${r.samples} of your messages`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLearning(false);
    }
  };
  const tryIt = async () => {
    if (!kind) return;
    setTrying(true);
    setPreview(null);
    try {
      setPreview(await runCommand(uid, "preview_voice", { kind }, 5 * 60_000));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTrying(false);
    }
  };

  return (
    <Section
      title="Your voice"
      icon={IconSparkle}
      description={
        <>
          Messages go out the way you write: your greetings, your Hinglish, your emoji, a little different for each comic. Nothing BOT Curating reads only messages <b>you</b> sent, in the chats you choose (by default your recent DMs and show groups), keeps a short description and up to 15 examples, and never stores the chats. Your template below is the guide and the safety net: if a draft changes or drops a date, time, venue or link, or the model is busy, the template goes out instead. It uses your AI models setting, so on Local only nothing leaves your server.
        </>
      }
      aside={<Switch checked={voice.enabled && Boolean(profile)} disabled={!profile} onChange={(v) => saveSettings({ voice: { ...voice, enabled: v } })} label="Write messages in my voice" />}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span className="type-label-l text-on-surface-variant">Learn from</span>
          <Segmented
            size="sm"
            value={sources.mode}
            onChange={(mode) => void setSources({ ...sources, mode })}
            options={[
              { value: "recommended", label: "Recommended" },
              { value: "selected", label: "Only chats I pick" },
            ]}
          />
          <div className="flex flex-wrap items-center gap-3">
            {sources.mode === "selected" && (
              <Button size="sm" variant="tonal" disabled={demo} onClick={() => setPicking(true)}>
                Choose chats…
              </Button>
            )}
            <span className="min-w-0 flex-1 basis-56 type-body-s text-on-surface-variant">{demo && sources.mode === "selected" ? "The demo has no WhatsApp, so there are no chats to choose from. On a real account this lists your groups and people." : voiceSourcesSummary(sources)}</span>
          </div>
        </div>
        <VoiceSourcesSheet open={picking} onClose={() => setPicking(false)} value={sources.chats} onSave={(chats) => setSources({ mode: "selected", chats })} />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant={profile ? "outlined" : "filled"} icon={IconSparkle} loading={learning} onClick={learn}>
            {profile ? "Learn again" : "Learn my voice"}
          </Button>
          <span className="type-body-s text-on-surface-variant">
            {learning
              ? "Reading your messages. This takes a minute or two."
              : profile
                ? `Learned from ${profile.sampleCount} of your messages on ${new Date(profile.learnedAt).toLocaleDateString([], { day: "numeric", month: "short" })}.`
                : "Needs your WhatsApp linked. Takes a minute or two."}
          </span>
        </div>

        {profile && (
          <>
            <div className="flex flex-col gap-2">
              <label htmlFor="voice-summary" className="type-label-l text-on-surface-variant">How you write</label>
              <TextArea id="voice-summary" value={summary} onChange={(e) => setSummary(e.target.value)} rows={5} className="min-h-0" />
              <div className="flex justify-end gap-2">
                {summary !== profile.summary && (
                  <>
                    <Button size="sm" variant="text" onClick={() => setSummary(profile.summary)}>Discard</Button>
                    <Button size="sm" onClick={async () => { await save({ summary: summary.trim() }); toast.success("Saved"); }}>Save</Button>
                  </>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="type-label-l text-on-surface-variant">Examples it copies ({profile.examples.length})</span>
              <ul className="flex flex-col gap-1.5">
                {profile.examples.map((ex, i) => (
                  <li key={i} className="flex items-start gap-2 rounded-md bg-surface-container px-3 py-2">
                    <span className="min-w-0 flex-1 whitespace-pre-wrap type-body-m">{ex}</span>
                    <button className="state-layer pressable -mr-1 grid size-8 flex-none place-items-center rounded-full text-on-surface-variant" aria-label="Remove this example" onClick={() => save({ examples: profile.examples.filter((_, j) => j !== i) })}>
                      <IconClose className="icon size-4" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex flex-col gap-3 rounded-lg bg-surface-container p-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="min-w-0 flex-1 type-title-s">Try it on the message picked below</span>
                <Button size="sm" variant="tonal" loading={trying} disabled={!kind} onClick={tryIt}>
                  Write 3 versions
                </Button>
              </div>
              {preview && (
                <div className="grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <span className="type-label-m text-on-surface-variant">Your template</span>
                    <Bubble outgoing>{preview.reference}</Bubble>
                  </div>
                  <div className="flex flex-col gap-2">
                    <span className="type-label-m text-on-surface-variant">In your voice</span>
                    {preview.drafts.map((d, i) => (
                      <div key={i} className="flex flex-col gap-1">
                        <Bubble outgoing>{d.text || <span className="opacity-50">No draft</span>}</Bubble>
                        {d.problem && <span className="type-body-s text-error">Wouldn't be sent ({d.problem}); your template would go instead.</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Section>
  );
}
