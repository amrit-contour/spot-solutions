import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  DEFAULT_ACK_TEMPLATE,
  DEFAULT_CONFIRM_TEMPLATE,
  DEFAULT_REJECT_TEMPLATE,
  SAMPLE_VARS,
  TEMPLATE_VARIABLES,
  renderTemplate,
} from "@spot/shared";
import { useApp } from "../lib/app";
import { useInstall } from "../lib/install";
import { PageHeader } from "../components/Shell";
import { ConnectCard } from "../components/ConnectCard";
import { Bubble, Button, Field, Segmented, Stepper, Switch, TextArea, TextInput, cx } from "../components/ui";
import { IconChat, IconChatCheck, IconChatCross, IconCheck, IconCpu, IconPhone, IconShield } from "../components/icons";

function Section({ title, icon: I, description, children, aside }: { title: string; icon: typeof IconChat; description?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-xl bg-surface-low p-5 sm:p-6">
      <div className="mb-5 flex items-start gap-4">
        <span className="grid size-10 flex-none place-items-center rounded-md bg-secondary-container text-on-secondary-container">
          <I className="icon size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="type-title-l">{title}</h2>
          {description && <p className="mt-0.5 type-body-m text-on-surface-variant">{description}</p>}
        </div>
        {aside}
      </div>
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
    <div className={cx("grid gap-5 lg:grid-cols-2", disabled && "pointer-events-none opacity-50")}>
      <div className="flex flex-col gap-3">
        <TextArea ref={ref} value={draft} onChange={(e) => setDraft(e.target.value)} rows={6} spellCheck={false} className="font-mono text-sm" />
        <div className="flex flex-wrap gap-1.5">
          {TEMPLATE_VARIABLES.map((v) => (
            <button key={v.key} onClick={() => insert(v.key)} className="state-layer pressable h-7 rounded-sm bg-surface-high px-2.5 font-mono text-xs text-on-surface-variant" title={`Insert ${v.label}`}>
              {`{{${v.key}}}`}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="text" onClick={() => setDraft(fallback)} disabled={draft === fallback}>
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
      <div className="flex flex-col rounded-lg bg-surface-lowest p-4">
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
  const [modelName, setModelName] = useState(settings.model.name);
  useEffect(() => setModelName(settings.model.name), [settings.model.name]);

  useEffect(() => {
    if (location.hash === "#whatsapp") document.getElementById("whatsapp")?.scrollIntoView({ behavior: "smooth" });
  }, []);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Settings" subtitle="How Spot Solutions talks on your behalf" />
      <div className="flex flex-col gap-4 px-4 pb-12 sm:px-8">
        <ConnectCard />
        <InstallCard />

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

        <Section
          title="Regret message"
          icon={IconChatCross}
          description="When every show for the week is confirmed or cancelled, anyone who asked but wasn't placed gets this. Dismissed requests are skipped."
          aside={<Switch checked={settings.reject.enabled} onChange={(v) => saveSettings({ reject: { ...settings.reject, enabled: v } })} label="Send regret messages" />}
        >
          <TemplateEditor value={settings.reject.template} fallback={DEFAULT_REJECT_TEMPLATE} disabled={!settings.reject.enabled} onSave={(t) => saveSettings({ reject: { ...settings.reject, template: t } })} />
        </Section>

        <Section title="Model" icon={IconCpu} description="Which Gemma reads your DMs. Local is private and free; the Gemini API is a backup for when your laptop is slow or off.">
          <div className="flex flex-col gap-6">
            <Segmented
              value={settings.model.provider}
              onChange={(p) => saveSettings({ model: { ...settings.model, provider: p } })}
              options={[
                { value: "ollama", label: "Local · Ollama", icon: IconShield },
                { value: "gemini", label: "Gemini API" },
              ]}
            />
            <div className="grid gap-6 sm:grid-cols-2">
              <Field label="Ollama model" hint="gemma3:4b fits an 8 GB laptop. Try gemma3:1b on older machines.">
                <TextInput value={modelName} onChange={(e) => setModelName(e.target.value)} onBlur={() => modelName !== settings.model.name && saveSettings({ model: { ...settings.model, name: modelName } })} className="font-mono" />
              </Field>
              <Field label="Wait for a pause of" hint="Messages sent in a burst are read together.">
                <Stepper value={settings.debounceSeconds} onChange={(v) => saveSettings({ debounceSeconds: v })} min={5} max={300} suffix="sec" />
              </Field>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <div className="type-title-s">Fall back to the Gemini API</div>
                <div className="type-body-s text-on-surface-variant">Only used when the local model fails or times out. The worker needs a GEMINI_API_KEY for this.</div>
              </div>
              <Switch checked={settings.model.fallback} onChange={(v) => saveSettings({ model: { ...settings.model, fallback: v } })} label="Gemini fallback" />
            </div>
          </div>
        </Section>

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
