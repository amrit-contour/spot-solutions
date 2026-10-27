import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  BUILTIN_LABELS,
  DEFAULT_ALERT_RULES,
  DEFAULT_ALERT_THRESHOLD,
  DEFAULT_CLOSURE_THRESHOLD,
  MAX_ALERT_RULES,
  classifyFast,
  regexProblem,
  resolveAlertRules,
  toStoredAlertRules,
  type AlertRule,
  type ResolvedAlertRules,
} from "@spot/shared";
import { Button, Chip, Collapsible, IconAdd, IconClose, IconRefresh, IconTrash, Switch, TextInput } from "@spot/ui";
import { Card, Section } from "./ui";
import { saveAlertRules, useComicSettings } from "../lib/alerts";

const defaultOf = (id: string) => DEFAULT_ALERT_RULES.find((d) => d.id === id);
const changed = (r: AlertRule) => {
  const d = defaultOf(r.id);
  return d ? JSON.stringify(d) !== JSON.stringify(r) : false;
};
const weightText = (w: number) => (w === 0 ? "no effect" : w > 0 ? `adds ${w}` : `lowers ${-w}`);

/** "Alert rules": how sure the rules must be before a group post is pushed without waiting for the AI, and the rules behind it. */
export function AlertRulesPanel({ uid }: { uid: string }) {
  const { settings, loading } = useComicSettings(uid);
  const [cfg, setCfg] = useState<ResolvedAlertRules>(() => resolveAlertRules(undefined));
  const loaded = useRef(false);
  const dirty = useRef(false);
  useEffect(() => {
    if (loading || loaded.current) return;
    loaded.current = true;
    setCfg(resolveAlertRules(settings.alertRules));
  }, [loading, settings.alertRules]);

  // Saved a moment after the last change, so dragging a slider is one write.
  useEffect(() => {
    if (!dirty.current) return;
    const t = setTimeout(() => void saveAlertRules(uid, toStoredAlertRules(cfg)).catch((e: Error) => toast.error(e.message)), 600);
    return () => clearTimeout(t);
  }, [cfg, uid]);

  const update = (next: ResolvedAlertRules) => {
    dirty.current = true;
    // Through the stored shape and back, so problems (a bad regex) are worked out the same way the server will.
    setCfg(resolveAlertRules(toStoredAlertRules(next)));
  };
  const setRule = (id: string, patch: Partial<AlertRule>) => update({ ...cfg, rules: cfg.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  const resetRule = (id: string) => {
    const d = defaultOf(id);
    if (d) update({ ...cfg, rules: cfg.rules.map((r) => (r.id === id ? { ...d, patterns: d.patterns ? [...d.patterns] : undefined } : r)) });
  };
  const resetAll = () => {
    update(resolveAlertRules(undefined));
    toast("Alert rules are back to the defaults");
  };

  const [msg, setMsg] = useState("Spots at 7 and 9 today at Banter, DM");
  const tried = useMemo(() => classifyFast(msg, { rules: cfg }), [msg, cfg]);
  const isClosure = tried.kind === "closure";
  const labelOf = (id: string) => cfg.rules.find((r) => r.id === id)?.label ?? id;
  const shown = isClosure ? tried.closure : tried.offer;
  const customCount = cfg.rules.filter((r) => r.custom).length;

  return (
    <Section title="Alert rules" className="gap-3">
      <p className="px-1 type-body-m text-on-surface-variant">
        Each group post gets a score from 0 to 100 for how sure your server is that it is a spot offer. At or above the bar, you are notified straight away. Below it, the AI reads the post first, which takes longer.
      </p>

      <Card>
        <Slider label="Notify straight away at" value={cfg.threshold} min={0} max={100} step={5} onChange={(v) => update({ ...cfg, threshold: v })} text={`${cfg.threshold}`} hint={cfg.threshold === DEFAULT_ALERT_THRESHOLD ? "Default" : `Default ${DEFAULT_ALERT_THRESHOLD}`} />
        <p className="mt-1 type-body-s text-on-surface-variant">Lower: faster, but more posts that aren't offers slip through. Higher: fewer mistakes, but more posts wait for the AI.</p>
      </Card>

      <Card>
        <label className="block type-title-s" htmlFor="try-msg">Try a message</label>
        <TextInput id="try-msg" value={msg} onChange={(e) => setMsg(e.target.value)} className="mt-2" placeholder="Paste a post from a group" />
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
          <span className="type-headline-s tabular-nums" aria-live="polite">{shown.score}%</span>
          <Chip tone={tried.confident ? "success" : "neutral"}>
            {tried.confident ? (isClosure ? "Closes the spot straight away" : "Pushed straight away") : tried.kind === "schedule_update" || tried.kind === "opening_notice" ? "The AI reads this kind" : "The AI reads it first"}
          </Chip>
          <span className="type-body-s text-on-surface-variant">{isClosure ? "as a closure" : "as an offer"}, bar {tried.threshold}</span>
        </div>
        {shown.matched.length === 0 ? (
          <p className="mt-2 type-body-s text-on-surface-variant">No rule matched.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {shown.matched.map((m) => (
              <li key={m.id} className="flex min-w-0 items-baseline gap-2 type-body-s">
                <span className={`w-10 flex-none text-right tabular-nums ${m.points < 0 ? "text-error" : "text-primary"}`}>{m.points > 0 ? `+${m.points}` : m.points}</span>
                <span className="min-w-0 flex-1">{labelOf(m.id)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 type-body-s text-on-surface-variant">Which of your rooms a post names isn't tried here.</p>
      </Card>

      <Collapsible id="alert-rules-advanced" title="Advanced" subtitle="Switch rules on or off, change their weight, add your own" defaultOpen={false} persist={false}>
        <div className="flex min-w-0 flex-col gap-5 p-4">
          <Slider label="Closures: close straight away at" value={cfg.closureThreshold} min={0} max={100} step={5} onChange={(v) => update({ ...cfg, closureThreshold: v })} text={`${cfg.closureThreshold}`} hint={`Default ${DEFAULT_CLOSURE_THRESHOLD}`} />
          {(["offer", "closure"] as const).map((kind) => (
            <div key={kind} className="min-w-0">
              <p className="type-title-s">{kind === "offer" ? "Is it a spot offer?" : "Is it a closure?"}</p>
              <ul className="mt-2 flex flex-col gap-3">
                {cfg.rules.filter((r) => r.appliesTo === kind).map((r) => (
                  <RuleRow key={r.id} rule={r} problem={cfg.problems[r.id]} onChange={(p) => setRule(r.id, p)} onReset={() => resetRule(r.id)} onDelete={() => update({ ...cfg, rules: cfg.rules.filter((x) => x.id !== r.id) })} />
                ))}
              </ul>
            </div>
          ))}
          <AddRule disabled={customCount >= MAX_ALERT_RULES} onAdd={(r) => update({ ...cfg, rules: [...cfg.rules, r] })} />
          <div>
            <Button variant="tonal" icon={IconRefresh} onClick={resetAll}>Reset all to defaults</Button>
          </div>
        </div>
      </Collapsible>
    </Section>
  );
}

function Slider({ label, value, min, max, step = 1, onChange, text, hint }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; text: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="min-w-0 flex-1 type-title-s">{label}</span>
        <span className="flex-none type-title-m tabular-nums">{text}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} className="mt-1 w-full accent-primary" />
      {hint && <p className="type-body-s text-on-surface-variant">{hint}</p>}
    </div>
  );
}

function RuleRow({ rule: r, problem, onChange, onReset, onDelete }: { rule: AlertRule; problem?: string; onChange: (p: Partial<AlertRule>) => void; onReset: () => void; onDelete: () => void }) {
  const [draft, setDraft] = useState("");
  const addPhrase = () => {
    const p = draft.trim();
    if (p && !(r.patterns ?? []).some((x) => x.toLowerCase() === p.toLowerCase())) onChange({ patterns: [...(r.patterns ?? []), p] });
    setDraft("");
  };
  return (
    <li className={`min-w-0 rounded-md bg-surface-container p-3 ${r.enabled ? "" : "opacity-70"}`}>
      <div className="flex min-w-0 items-start gap-3">
        <span className="min-w-0 flex-1">
          <span className="block type-body-m">{r.label}</span>
          {r.kind === "builtin" && r.builtin && <span className="block type-body-s text-on-surface-variant">Looks for: {BUILTIN_LABELS[r.builtin]}</span>}
        </span>
        <Switch label={`Use "${r.label}"`} checked={r.enabled} onChange={(v) => onChange({ enabled: v })} />
      </div>
      <div className="mt-2">
        <div className="flex items-baseline justify-between gap-3 type-body-s">
          <span className={r.weight < 0 ? "text-error" : "text-primary"}>{weightText(r.weight)}</span>
          {r.weight < 0 && <span className="text-on-surface-variant">lowers the score</span>}
        </div>
        <input type="range" min={-100} max={100} step={5} value={r.weight} onChange={(e) => onChange({ weight: Number(e.target.value) })} aria-label={`Weight of "${r.label}"`} className="w-full accent-primary" />
      </div>
      {r.kind === "phrase" && (
        <div className="mt-2 min-w-0">
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {(r.patterns ?? []).map((p) => (
              <button key={p} type="button" onClick={() => onChange({ patterns: (r.patterns ?? []).filter((x) => x !== p) })} aria-label={`Remove ${p}`} className="state-layer inline-flex max-w-full items-center gap-1 rounded-full bg-surface-high px-2.5 py-1 type-label-m">
                <span className="min-w-0 truncate">{p}</span>
                <IconClose aria-hidden className="icon size-3.5 flex-none" />
              </button>
            ))}
          </div>
          <div className="mt-2 flex min-w-0 gap-2">
            <TextInput value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addPhrase())} placeholder="Add a word or phrase" aria-label={`Add a phrase to "${r.label}"`} />
            <Button variant="tonal" size="sm" icon={IconAdd} onClick={addPhrase}>Add</Button>
          </div>
        </div>
      )}
      {r.kind === "regex" && (
        <div className="mt-2 min-w-0">
          <TextInput value={r.regex ?? ""} onChange={(e) => onChange({ regex: e.target.value })} className="font-mono text-sm" aria-label={`Pattern of "${r.label}"`} spellCheck={false} />
        </div>
      )}
      {problem && <p className="mt-2 rounded-md bg-error-container px-3 py-2 type-body-s text-on-error-container">This rule is skipped: {problem}.</p>}
      {(changed(r) || r.custom) && (
        <div className="mt-2 flex justify-end gap-2">
          {r.custom ? (
            <Button variant="text" size="sm" icon={IconTrash} onClick={onDelete}>Delete</Button>
          ) : (
            <Button variant="text" size="sm" icon={IconRefresh} onClick={onReset}>Reset this rule</Button>
          )}
        </div>
      )}
    </li>
  );
}

function AddRule({ onAdd, disabled }: { onAdd: (r: AlertRule) => void; disabled?: boolean }) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"phrase" | "regex">("phrase");
  const [appliesTo, setAppliesTo] = useState<"offer" | "closure">("offer");
  const [text, setText] = useState("");
  const [weight, setWeight] = useState(30);
  const problem = kind === "regex" && text.trim() ? regexProblem(text) : null;
  const ok = text.trim() && !problem && !disabled;
  const sel = "rounded-md bg-surface-container-high px-3 py-2 type-body-m";
  const add = () => {
    if (!ok) return;
    const patterns = text.split(",").map((p) => p.trim()).filter(Boolean);
    onAdd({ id: `c-${Date.now().toString(36)}`, label: label.trim() || (kind === "phrase" ? patterns.join(", ").slice(0, 40) : "My pattern"), kind, ...(kind === "phrase" ? { patterns } : { regex: text.trim() }), weight, enabled: true, appliesTo, custom: true });
    setLabel("");
    setText("");
  };
  return (
    <div className="min-w-0 rounded-md bg-surface-container p-3">
      <p className="type-title-s">Add your own rule</p>
      <div className="mt-2 flex min-w-0 flex-col gap-2">
        <TextInput value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name it (optional)" aria-label="Rule name" />
        <div className="flex min-w-0 flex-wrap gap-2">
          <select value={kind} onChange={(e) => setKind(e.target.value as "phrase" | "regex")} className={sel} aria-label="Rule type">
            <option value="phrase">Words or phrases</option>
            <option value="regex">Pattern (regex)</option>
          </select>
          <select value={appliesTo} onChange={(e) => setAppliesTo(e.target.value as "offer" | "closure")} className={sel} aria-label="Counts towards">
            <option value="offer">Counts towards: spot offer</option>
            <option value="closure">Counts towards: closure</option>
          </select>
        </div>
        <TextInput value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === "phrase" ? "hosting tonight, need comics" : "\\bopen mic\\b"} aria-label={kind === "phrase" ? "Words or phrases, separated by commas" : "Pattern"} spellCheck={false} />
        {problem && <p className="type-body-s text-error">{problem}.</p>}
        <div>
          <div className="type-body-s"><span className={weight < 0 ? "text-error" : "text-primary"}>{weightText(weight)}</span></div>
          <input type="range" min={-100} max={100} step={5} value={weight} onChange={(e) => setWeight(Number(e.target.value))} aria-label="Weight" className="w-full accent-primary" />
        </div>
        <div className="flex justify-end">
          <Button size="sm" icon={IconAdd} onClick={add} disabled={!ok}>Add rule</Button>
        </div>
      </div>
    </div>
  );
}
