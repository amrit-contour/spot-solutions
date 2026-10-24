import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  DAY_NAMES,
  DEFAULT_ACK_TEMPLATE,
  DEFAULT_CONFIRM_TEMPLATE,
  DEFAULT_REJECT_TEMPLATE,
  SAMPLE_VARS,
  TEMPLATE_VARIABLES,
  renderTemplate,
  type GroupInfo,
} from "@spot/shared";
import { useApp } from "../lib/app";
import { useCollection } from "../lib/data";
import { useInstall } from "../lib/install";
import { PageHeader } from "../components/Shell";
import { ConnectCard } from "../components/ConnectCard";
import { AiModels } from "../components/AiModels";
import { Bubble, Button, Field, Segmented, Select, Stepper, Switch, TextArea, TextInput, cx } from "../components/ui";
import { IconChat, IconChatCheck, IconChatCross, IconCheck, IconCpu, IconMic, IconPhone, IconShield } from "../components/icons";

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
      <header className="mb-5 flex items-start gap-4">
        <span className="grid size-10 flex-none place-items-center rounded-md bg-secondary-container text-on-secondary-container">
          <I className="icon size-5" />
        </span>
        <div className="min-w-0 flex-1 pt-1.5">
          <h2 className="type-title-l">{title}</h2>
          {description && <p className="mt-1 max-w-[68ch] type-body-m text-on-surface-variant">{description}</p>}
        </div>
        {aside && <div className="flex-none pt-1">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

function TemplateEditor({ value, onSave, fallback, extraVars, disabled }: { value: string; onSave: (v: string) => Promise<void>; fallback: string; extraVars?: Record<string, string | number | null>; disabled?: boolean }) {
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
          {TEMPLATE_VARIABLES.map((v) => (
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
              toast.success("Template saved");
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
  const [msg, setMsg] = useState<"ack" | "confirm" | "reject">("ack");

  return (
    <div className="w-full">
      <PageHeader title="Settings" subtitle="How Spot Solutions talks on your behalf" />
      <div className="flex flex-col gap-6 px-4 pb-12 sm:px-8 lg:flex-row lg:items-start lg:gap-8">
        <SettingsNav current={tab} />
        <div className="flex min-w-0 flex-1 flex-col gap-4">
        {tab === "whatsapp" && (
          <>
            <ConnectCard />
            <InstallCard />
          </>
        )}
        {tab === "messages" && (
          <>
            <Segmented
              value={msg}
              onChange={setMsg}
              options={[
                { value: "ack", label: "Acknowledge" },
                { value: "confirm", label: "Confirmation" },
                { value: "reject", label: "Regret" },
              ]}
            />

        {msg === "ack" && (
<Section
          title="Auto-acknowledge"
          icon={IconChat}
          description={
            <>
              Off by default. When on, it replies only when Gemma quotes a clear ask at 85%+ confidence, in a message that arrived in the last 10 minutes. It never replies to businesses or to chats from before you linked, and sends at most once per comic per week.
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
          <div className={cx("flex items-center gap-4", !settings.selfService.enabled && "pointer-events-none opacity-50")}>
            <div className="flex-1">
              <div className="type-title-s">Send without asking me</div>
              <div className="type-body-s text-on-surface-variant">Off: nothing goes out until you tap Send. On: replies go out straight away (fresh messages from people only), and a cancellation frees the slot automatically.</div>
            </div>
            <Switch checked={settings.selfService.autoSend} onChange={(v) => saveSettings({ selfService: { ...settings.selfService, autoSend: v } })} label="Send replies automatically" />
          </div>
          <div className="mt-6 flex items-center gap-4">
            <div className="flex-1">
              <div className="type-title-s">Ask new faces who they are</div>
              <div className="type-body-s text-on-surface-variant">When someone you haven't saved asks for a spot, draft “What's your name, which scene are you from, how long have you been doing comedy?”. Their answer fills in their profile.</div>
            </div>
            <Switch checked={settings.onboarding.enabled} onChange={(v) => saveSettings({ onboarding: { enabled: v } })} label="Ask new faces who they are" />
          </div>
        </Section>

          </>
        )}
        {tab === "show" && <AfterShowSection />}
        {tab === "ai" && (

        <Section title="AI models" icon={IconCpu} description="Pick which model reads your DMs, and a backup. Local Ollama keeps chats on your server and costs nothing; Gemini is smarter but sends message text to Google.">
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
    <select value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-12 rounded-sm border border-outline bg-transparent px-3 type-body-l outline-none focus:border-primary">
      {DAYS.map((d) => (
        <option key={d} value={d}>
          {DAY_NAMES[d]}
        </option>
      ))}
    </select>
  );
  return (
    <Section title="Request rules" icon={IconShield} description="Requests that break a rule go to the Held tab instead of Asked. Nothing is sent to them, and you can still allow any of them.">
      <div className="flex flex-col gap-6">
        <div>
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <div className="type-title-s">Request window</div>
              <div className="type-body-s text-on-surface-variant">Only take requests during this time each week. Anything else is held as a mid-week ask.</div>
            </div>
            <Switch checked={r.window.enabled} onChange={(v) => setWindow({ enabled: v })} label="Request window" />
          </div>
          {r.window.enabled && (
            <div className="mt-4 grid gap-4 rounded-lg bg-surface-container p-4 sm:grid-cols-2">
              <Field label="Opens">
                <div className="flex gap-2">
                  {daySelect(r.window.startDay, (d) => setWindow({ startDay: d as never }))}
                  <TextInput type="time" value={r.window.startTime} onChange={(e) => setWindow({ startTime: e.target.value })} />
                </div>
              </Field>
              <Field label="Closes">
                <div className="flex gap-2">
                  {daySelect(r.window.endDay, (d) => setWindow({ endDay: d as never }))}
                  <TextInput type="time" value={r.window.endTime} onChange={(e) => setWindow({ endTime: e.target.value })} />
                </div>
              </Field>
            </div>
          )}
        </div>
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <div className="type-title-s">Skip last week's comics</div>
            <div className="type-body-s text-on-surface-variant">Hold requests from anyone who performed last week, so newer faces get a shot.</div>
          </div>
          <Switch checked={r.skipLastWeek} onChange={(v) => saveSettings({ rules: { ...r, skipLastWeek: v } })} label="Skip last week's comics" />
        </div>
        <p className="type-body-s text-on-surface-variant">Hosts, ignored and banned comics are set per person in Comics.</p>
      </div>
    </Section>
  );
}

function AfterShowSection() {
  const { uid, settings, saveSettings } = useApp();
  const groups = useCollection<GroupInfo>(uid, "groups");
  const m = settings.micCheck;
  return (
    <Section title="Around the show" icon={IconMic} description="Hosts' availability, last-minute spot offers, and checking the mic actually happened.">
      <div className="flex flex-col gap-6">
        <Field label="Hosts group" hint="“Ask hosts” on the Lineup page sends this group a poll of the week's shows. Votes show up on each show as “Hosts free”.">
          <Select value={settings.hostPoll.groupId ?? ""} onChange={(v) => saveSettings({ hostPoll: { groupId: v || null } })} placeholder="None" options={groups.data.map((g) => ({ value: g.id, label: g.name }))} />
        </Field>
        <Field label="Spot offers expire after" hint="Offer a spot from a show's menu on the Lineup page. No reply in time and the offer lapses.">
          <Stepper value={settings.offers.expiryHours} onChange={(v) => saveSettings({ offers: { expiryHours: v } })} min={1} max={48} suffix="h" />
        </Field>
        <div>
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <div className="type-title-s">Did the mic happen?</div>
              <div className="type-body-s text-on-surface-variant">The morning after each show, Requests asks you. “No” stops it counting as anyone's spot.</div>
            </div>
            <Switch checked={m.enabled} onChange={(v) => saveSettings({ micCheck: { ...m, enabled: v } })} label="Mic check" />
          </div>
          {m.enabled && (
            <div className="mt-4 grid gap-4 rounded-lg bg-surface-container p-4 sm:grid-cols-2">
              <Field label="Ask from">
                <TextInput type="time" value={m.time} onChange={(e) => saveSettings({ micCheck: { ...m, time: e.target.value } })} />
              </Field>
              <div className="flex items-center gap-3 sm:pt-6">
                <div className="flex-1">
                  <div className="type-title-s">Also ask on WhatsApp</div>
                  <div className="type-body-s text-on-surface-variant">In your “Message yourself” chat. Reply yes or no there.</div>
                </div>
                <Switch checked={m.whatsapp} onChange={(v) => saveSettings({ micCheck: { ...m, whatsapp: v } })} label="Ask on WhatsApp" />
              </div>
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}
