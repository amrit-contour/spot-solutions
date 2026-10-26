import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  DAY_NAMES,
  DEFAULT_ACK_TEMPLATE,
  DEFAULT_CANCEL_SPOT_TEMPLATE,
  DEFAULT_CONFIRM_TEMPLATE,
  DEFAULT_REJECT_TEMPLATE,
  SAMPLE_VARS,
  TEMPLATE_VARIABLES,
  closedRequestsWeeks,
  clampScanDays,
  SCAN_DAYS_MAX,
  SCAN_DAYS_MIN,
  renderTemplate,
  MESSAGE_GROUPS,
  MESSAGE_TYPES,
  messageTemplate,
  type GroupInfo,
  type MessageKey,
  type Snippet,
  type VoiceKind,
} from "@spot/shared";
import { useApp } from "../lib/app";
import { runCommand } from "../lib/data";
import { useCollection } from "../lib/data";
import { useInstall } from "../lib/install";
import { PageHeader } from "../components/Shell";
import { ConnectCard } from "../components/ConnectCard";
import { AiModels } from "../components/AiModels";
import { AiPolicyPicker } from "../components/AiPolicy";
import { FleetCard } from "../components/FleetCard";
import { NotifyCard } from "../components/NotifyCard";
import { GoogleContactsCard } from "../components/GoogleContactsCard";
import { AppearanceCard } from "../components/AppearanceCard";
import { Bubble, Button, Field, Info, Select, SettingRow, Stepper, Switch, TextArea, TextInput, TimePicker, cx } from "../components/ui";
import { IconChat, IconChatCheck, IconChatCross, IconCheck, IconCpu, IconMic, IconPhone, IconShield, IconTemplate, IconTrash, IconAdd, IconSparkle, IconClose } from "../components/icons";

const TABS = [
  { id: "whatsapp", label: "WhatsApp & app", icon: IconPhone },
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

/** Side menu on desktop, scrolling tabs on phones. One topic on screen at a time. */
function SettingsNav({ current }: { current: TabId }) {
  return (
    <nav aria-label="Settings sections" className="-mx-4 flex gap-1 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 lg:sticky lg:top-6 lg:w-60 lg:flex-none lg:flex-col">
      {TABS.map((t) => {
        const active = t.id === current;
        return (
          <Link
            key={t.id}
            to={`#${t.id}`}
            replace
            aria-current={active ? "page" : undefined}
            className={cx(
              "state-layer relative flex h-10 flex-none items-center gap-2.5 rounded-full px-4 type-label-l whitespace-nowrap lg:h-12 lg:px-4",
              active ? "text-on-secondary-container" : "text-on-surface-variant",
            )}
          >
            {active && <motion.span layoutId="settings-tab" className="absolute inset-0 rounded-full bg-secondary-container" transition={{ type: "spring", duration: 0.4, bounce: 0.15 }} />}
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
];
const ALL_VARIABLES: { key: string; label: string }[] = [...TEMPLATE_VARIABLES, ...EXTRA_VARIABLES];

function TemplateEditor({ value, onSave, fallback, extraVars, disabled, keys, savedLabel = "Template saved" }: { value: string; onSave: (v: string) => Promise<void>; fallback: string; extraVars?: Record<string, string | number | null | undefined>; disabled?: boolean; keys?: readonly string[]; savedLabel?: string }) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(value), [value]);
  const dirty = draft !== value;

  const insert = (key: string) => {
    const el = ref.current;
    const token = key === "minutes" ? "{{#minutes}}⏱ {{minutes}} min{{/minutes}}" : `{{${key}}}`;
    if (!el) return setDraft((d) => d + token);
    const { selectionStart: s, selectionEnd: e } = el;
    const next = draft.slice(0, s) + token + draft.slice(e);
    setDraft(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + token.length, s + token.length);
    });
  };

  return (
    <div className={cx("grid items-start gap-5 lg:grid-cols-2", disabled && "pointer-events-none opacity-50")}>
      <div className="flex flex-col gap-3">
        <TextArea ref={ref} value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} spellCheck={false} className="min-h-0 font-mono text-sm" />
        <div className="flex flex-wrap gap-1.5">
          {(keys ? ALL_VARIABLES.filter((v) => keys.includes(v.key)) : TEMPLATE_VARIABLES).map((v) => (
            <button key={v.key} onClick={() => insert(v.key)} className="state-layer pressable h-7 rounded-sm bg-surface-high px-2.5 font-mono text-xs text-on-surface-variant" title={`Insert ${v.label}`}>
              {`{{${v.key}}}`}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="text" className="-ml-3" onClick={() => setDraft(fallback)} disabled={draft === fallback}>
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
              setSaving(true);
              await onSave(draft);
              setSaving(false);
              toast.success(savedLabel);
            }}
          >
            Save
          </Button>
        </div>
      </div>
      <div className="flex flex-col rounded-lg bg-surface-container p-4">
        <span className="mb-3 type-label-m text-on-surface-variant">Preview</span>
        <Bubble outgoing meta="9:41 PM">
          {renderTemplate(draft, { ...SAMPLE_VARS, ...extraVars }) || <span className="opacity-50">Empty message</span>}
        </Bubble>
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
      <PageHeader title="Settings" subtitle="How Spot Solutions talks on your behalf" />
      <div className="flex flex-col gap-6 px-4 pb-12 sm:px-8 lg:flex-row lg:items-start lg:gap-8">
        <SettingsNav current={tab} />
        <div className="flex min-w-0 flex-1 flex-col gap-4">
        {tab === "whatsapp" && (
          <>
            <ConnectCard />
            <FleetCard />
            <NotifyCard />
            <GoogleContactsCard />
            <AppearanceCard />
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
          <TemplateEditor value={settings.ack.template} fallback={DEFAULT_ACK_TEMPLATE} disabled={!settings.ack.enabled} onSave={(t) => saveSettings({ ack: { ...settings.ack, template: t } })} />
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
          <TemplateEditor value={settings.confirm.template} fallback={DEFAULT_CONFIRM_TEMPLATE} extraVars={{ minutes: withMinutes ? 5 : null }} onSave={(t) => saveSettings({ confirm: { template: t } })} />
        </Section>
        )}

        {msg === "cancel" && (
<Section
          title="Cancelled spot message"
          icon={IconChatCross}
          description="Sent when you take someone off a lineup you already confirmed, and you tick them in Send updates. Nothing goes out without that review."
        >
          <TemplateEditor value={settings.cancelSpot.template} fallback={DEFAULT_CANCEL_SPOT_TEMPLATE} onSave={(t) => saveSettings({ cancelSpot: { template: t } })} />
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
          <TemplateEditor value={settings.reject.template} fallback={DEFAULT_REJECT_TEMPLATE} disabled={!settings.reject.enabled} onSave={(t) => saveSettings({ reject: { ...settings.reject, template: t } })} />
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
    <Section title="Install the app" icon={IconPhone} description="Add Spot Solutions to your home screen. It opens full screen like a native app, and you can triage requests on the go.">
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
        <SettingRow label="Skip last week's comics" info={<>Hold requests from anyone who performed last week, so newer faces get a shot.</>}>
            <Switch checked={r.skipLastWeek} onChange={(v) => saveSettings({ rules: { ...r, skipLastWeek: v } })} label="Skip last week's comics" />
          </SettingRow>
        <SettingRow label="Tell held comics why" info={<>Off by default. When on, someone held by the request window or last week's rule gets one short reply saying why (edit the words in Messages → Held requests). Same safety as auto-acknowledge: clear asks only, fresh messages only, never businesses. Banned, ignored and hosts never get a reply.</>}>
          <Switch checked={Boolean(settings.heldReplies?.enabled)} onChange={(v) => saveSettings({ heldReplies: { enabled: v } })} label="Tell held comics why" />
        </SettingRow>
        <SettingRow label="Scan past messages: days to look back" info={<>The starting choice when you run Requests → Scan past messages. Spot Solutions only reads older DMs when you run that scan yourself.</>}>
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
      description="Spot Solutions tidies up old requests once a day, on your server. Lineups, comics and their history are never deleted."
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
            <Stepper value={settings.offers.expiryHours} onChange={(v) => saveSettings({ offers: { expiryHours: v } })} min={1} max={48} suffix="h" />
          </SettingRow>
          <SettingRow label="Did the mic happen?" info="The morning after each show, Requests asks you. “No” stops it counting as anyone's spot.">
            <Switch checked={m.enabled} onChange={(v) => saveSettings({ micCheck: { ...m, enabled: v } })} label="Mic check" />
          </SettingRow>
          {m.enabled && (
            <>
              <SettingRow label="Ask from">
                <TimePicker value={m.time} onChange={(v) => saveSettings({ micCheck: { ...m, time: v } })} className="h-10" wrapperClassName="w-36" label="Ask from" />
              </SettingRow>
              <SettingRow label="Also ask on WhatsApp" info="In your “Message yourself” chat. Reply yes or no there.">
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
          {m.group === "replies" && " Drafted under Updates → Needs a reply; nothing goes out until you send it, unless “Send without asking me” is on."}
        </>
      }
      aside={held ? <Switch checked={!off} onChange={(v) => saveSettings({ heldReplies: { enabled: v } })} label="Tell held comics why" /> : undefined}
    >
      <TemplateEditor
        value={messageTemplate(settings, type)}
        fallback={m.default}
        keys={["name", ...m.vars]}
        extraVars={m.sample}
        disabled={off}
        onSave={(t) => saveSettings({ messages: { ...settings.messages, [type]: t } })}
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
  const save = (next: Snippet[]) => saveSettings({ snippets: next });
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
      <TemplateEditor value={snippet.body} fallback={snippet.body} keys={["name", "show", "venue", "day", "date", "time", "mapsLink"]} onSave={(body) => onSave({ body, title: title.trim() || "Untitled" })} />
    </div>
  );
}

const voiceKindOf = (m: MessageChoice): VoiceKind | null =>
  m === "snippets" || m === "groupWelcome" ? null : m === "cancel" ? "cancelSpot" : (m as VoiceKind);

/** Your voice: learn how you write from your own sent messages, then send every message that way. */
function VoiceSection({ kind }: { kind: VoiceKind | null }) {
  const { uid, settings, saveSettings } = useApp();
  const voice = settings.voice ?? { enabled: false, profile: null };
  const profile = voice.profile ?? null;
  const [learning, setLearning] = useState(false);
  const [summary, setSummary] = useState(profile?.summary ?? "");
  const [trying, setTrying] = useState(false);
  const [preview, setPreview] = useState<{ reference: string; drafts: { text: string; problem: string | null }[] } | null>(null);
  useEffect(() => setSummary(profile?.summary ?? ""), [profile?.summary]);

  const save = (patch: Partial<NonNullable<typeof profile>>) => profile && saveSettings({ voice: { ...voice, profile: { ...profile, ...patch } } });
  const learn = async () => {
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
          Messages go out the way you write: your greetings, your Hinglish, your emoji, a little different for each comic. Spot Solutions reads only messages <b>you</b> sent (your recent DMs and show groups), keeps a short description and up to 15 examples, and never stores the chats. Your template below is the guide and the safety net: if a draft changes or drops a date, time, venue or link, or the model is busy, the template goes out instead. It uses your AI models setting, so on Local only nothing leaves your server.
        </>
      }
      aside={<Switch checked={voice.enabled && Boolean(profile)} disabled={!profile} onChange={(v) => saveSettings({ voice: { ...voice, enabled: v } })} label="Write messages in my voice" />}
    >
      <div className="flex flex-col gap-4">
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
                <div className="grid gap-3 lg:grid-cols-2">
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
