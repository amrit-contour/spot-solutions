// Settings → AI models: Gemini key (write-only), model lists, primary + fallback routes with live tests.
import { useEffect, useState } from "react";
import { deleteDoc, doc, setDoc } from "firebase/firestore";
import { toast } from "sonner";
import type { AiKeyStatus, AiProvider, AiRoute } from "@spot/shared";
import { useApp } from "../lib/app";
import { db } from "../lib/firebase";
import { runCommand, useDocument, userDoc } from "../lib/data";
import { Button, Chip, Segmented, Select, Spinner, Switch, TextInput, cx } from "./ui";
import { IconCheck, IconCpu, IconRefresh, IconShield, IconSparkle, IconTrash, IconWarn } from "./icons";

interface UserAiDoc {
  aiKeys?: AiKeyStatus;
  aiModels?: { gemini?: string[]; fetchedAt?: number };
}

interface OllamaList {
  up: boolean;
  models: { name: string; size: number }[];
  loaded: string[];
}

const GB = (b: number) => `${(b / 1e9).toFixed(1)} GB`;

/** Text models only: drop embeddings, image/video/audio generation, live and TTS variants. */
function textModels(list: { name: string; supportedGenerationMethods?: string[] }[]) {
  return list
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => /^(gemini|gemma)/.test(n) && !/(embedding|image|imagen|veo|tts|audio|live|vision|aqa|learnlm)/.test(n))
    .sort((a, b) => Number(b.startsWith("gemini")) - Number(a.startsWith("gemini")) || b.localeCompare(a, undefined, { numeric: true }));
}

async function fetchGeminiModels(key: string) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? `Gemini said ${res.status}`);
  return textModels(body.models ?? []);
}

export function AiModels() {
  const { uid, settings, saveSettings, workerOnline } = useApp();
  const me = useDocument<UserAiDoc>(["users", uid]);
  const gemini = me.data?.aiKeys?.gemini;
  const geminiModels = me.data?.aiModels?.gemini ?? [];
  const [ollama, setOllama] = useState<OllamaList | null>(null);
  const [loadingOllama, setLoadingOllama] = useState(false);

  const refreshOllama = async () => {
    setLoadingOllama(true);
    try {
      setOllama(await runCommand<OllamaList>(uid, "list_models", {}, 30_000));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoadingOllama(false);
    }
  };
  useEffect(() => {
    if (workerOnline && !ollama) void refreshOllama();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerOnline]);

  const options = (p: AiProvider) => (p === "ollama" ? (ollama?.models ?? []).map((m) => m.name) : geminiModels);
  const setAi = (patch: Partial<typeof settings.ai>) => saveSettings({ ai: { ...settings.ai, ...patch } });

  return (
    <div className="flex flex-col gap-6">
      <GeminiKey status={gemini} count={geminiModels.length} />

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <RouteCard title="Primary" hint="Reads every message first." route={settings.ai.primary} options={options} ollama={ollama} geminiReady={Boolean(gemini?.set)} onChange={(r) => setAi({ primary: r })} />
        <RouteCard
          title="Fallback"
          hint="Used only if the primary fails or times out."
          route={settings.ai.fallback}
          options={options}
          ollama={ollama}
          geminiReady={Boolean(gemini?.set)}
          onChange={(r) => setAi({ fallback: r })}
          toggle={{
            on: Boolean(settings.ai.fallback),
            set: (v) =>
              setAi({
                fallback: v
                  ? settings.ai.primary.provider === "ollama"
                    ? { provider: "gemini", model: geminiModels.find((m) => m.startsWith("gemma-3-27b")) ?? geminiModels[0] ?? "gemma-3-27b-it" }
                    : { provider: "ollama", model: ollama?.models[0]?.name ?? "gemma3:4b" }
                  : null,
              }),
          }}
        />
      </div>

      <OllamaPanel ollama={ollama} loading={loadingOllama} onRefresh={refreshOllama} onPulled={setOllama} online={workerOnline} />
    </div>
  );
}

function GeminiKey({ status, count }: { status?: AiKeyStatus["gemini"]; count: number }) {
  const { uid } = useApp();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const showInput = !status?.set || editing;

  const save = async () => {
    const k = key.trim();
    if (!k) return;
    setBusy(true);
    try {
      const models = await fetchGeminiModels(k);
      await setDoc(userDoc(uid, "secrets", "ai"), { geminiKey: k }, { merge: true });
      await setDoc(doc(db, "users", uid), { aiKeys: { gemini: { set: true, last4: k.slice(-4), updatedAt: Date.now() } }, aiModels: { gemini: models, fetchedAt: Date.now() } }, { merge: true });
      setKey("");
      setEditing(false);
      toast.success(`Key works. ${models.length} models available.`);
    } catch (e) {
      toast.error(`Key didn't work: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm("Remove your Gemini key? Anything routed to Gemini will stop working.")) return;
    await deleteDoc(userDoc(uid, "secrets", "ai"));
    await setDoc(doc(db, "users", uid), { aiKeys: { gemini: null }, aiModels: { gemini: [] } }, { merge: true });
    toast("Gemini key removed");
  };

  return (
    <div className="rounded-lg bg-surface-container p-4">
      <div className="flex items-start gap-3">
        <span className="grid size-9 flex-none place-items-center rounded-md bg-tertiary-container text-on-tertiary-container">
          <IconSparkle className="icon size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="type-title-s">Gemini API key</span>
            {status?.set ? <Chip tone="success" icon={IconCheck}>Saved · ••••{status.last4}</Chip> : <Chip>Not set</Chip>}
          </div>
          <p className="mt-0.5 type-body-s text-on-surface-variant">
            Smarter, cloud models (Gemini 2.5, Gemma 27B). Free key from{" "}
            <a className="text-primary underline-offset-4 hover:underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
              Google AI Studio
            </a>
            . Stored write-only: this page can't read it back. {status?.set && `${count} models available.`}
          </p>
        </div>
      </div>
      {showInput ? (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <TextInput type="password" autoComplete="off" placeholder="AIza…" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} className="font-mono" />
          <div className="flex gap-2">
            <Button onClick={save} loading={busy} disabled={!key.trim()} icon={IconShield} className="h-12">
              Test & save
            </Button>
            {editing && (
              <Button variant="text" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="tonal" onClick={() => setEditing(true)}>
            Replace key
          </Button>
          <Button size="sm" variant="text" icon={IconTrash} onClick={remove} className="text-error">
            Remove
          </Button>
        </div>
      )}
    </div>
  );
}

function RouteCard({
  title,
  hint,
  route,
  options,
  ollama,
  geminiReady,
  onChange,
  toggle,
}: {
  title: string;
  hint?: string;
  route: AiRoute | null;
  toggle?: { on: boolean; set: (v: boolean) => void };
  options: (p: AiProvider) => string[];
  ollama: OllamaList | null;
  geminiReady: boolean;
  onChange: (r: AiRoute) => void;
}) {
  const { uid, workerOnline } = useApp();
  const [test, setTest] = useState<{ state: "idle" | "running" | "ok" | "fail"; msg?: string }>({ state: "idle" });
  useEffect(() => setTest({ state: "idle" }), [route?.provider, route?.model]);
  const header = (
    <div className="mb-4 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="type-title-s">{title}</div>
        {hint && <div className="type-body-s text-on-surface-variant">{hint}</div>}
      </div>
      {toggle && <Switch checked={toggle.on} onChange={toggle.set} label={`Use a ${title.toLowerCase()} model`} />}
    </div>
  );
  if (!route) {
    return (
      <div className="rounded-lg border border-outline-variant p-4">
        {header}
        <p className="type-body-s text-on-surface-variant">Off. If the primary fails, that message is skipped and noted in the server log.</p>
      </div>
    );
  }
  const list = options(route.provider);
  const missing = route.provider === "gemini" ? !geminiReady : ollama ? !ollama.models.some((m) => m.name === route.model) : false;

  const runTest = async () => {
    setTest({ state: "running" });
    try {
      const r = await runCommand<{ ms: number }>(uid, "test_ai", { provider: route.provider, model: route.model }, 120_000);
      setTest({ state: "ok", msg: `Answered in ${(r.ms / 1000).toFixed(1)} s` });
    } catch (e) {
      setTest({ state: "fail", msg: (e as Error).message });
    }
  };
  return (
    <div className="rounded-lg border border-outline-variant p-4">
      {header}
      <Segmented
        size="sm"
        value={route.provider}
        onChange={(p) => onChange({ provider: p, model: options(p)[0] ?? (p === "ollama" ? "gemma3:4b" : "gemma-3-27b-it") })}
        options={[
          { value: "ollama", label: "Ollama", icon: IconCpu },
          { value: "gemini", label: "Gemini", icon: IconSparkle },
        ]}
      />
      <div className="mt-3">
        {list.length ? (
          <Select value={list.includes(route.model) ? route.model : ""} onChange={(m) => onChange({ ...route, model: m })} placeholder={list.includes(route.model) ? undefined : `${route.model} (not available)`} options={list.map((m) => ({ value: m, label: m }))} className="font-mono text-sm" />
        ) : (
          <TextInput value={route.model} onChange={(e) => onChange({ ...route, model: e.target.value })} className="font-mono text-sm" />
        )}
      </div>
      {missing && (
        <p className="mt-2 flex items-center gap-1.5 type-body-s text-error">
          <IconWarn className="icon size-4" />
          {route.provider === "gemini" ? "Add a Gemini key above first." : "This model isn't on the server. Pull it below."}
        </p>
      )}
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" variant="tonal" onClick={runTest} disabled={!workerOnline || test.state === "running" || missing} loading={test.state === "running"}>
          Test
        </Button>
        <span className={cx("min-w-0 flex-1 truncate type-body-s", test.state === "ok" ? "text-primary" : test.state === "fail" ? "text-error" : "text-on-surface-variant")} title={test.msg}>
          {test.state === "idle" ? (workerOnline ? "Sends a tiny prompt through the server" : "Server offline") : test.msg ?? "Testing…"}
        </span>
      </div>
    </div>
  );
}

function OllamaPanel({ ollama, loading, onRefresh, onPulled, online }: { ollama: OllamaList | null; loading: boolean; onRefresh: () => void; onPulled: (o: OllamaList) => void; online: boolean }) {
  const { uid } = useApp();
  const [name, setName] = useState("");
  const [pulling, setPulling] = useState(false);
  const pull = async () => {
    const m = name.trim();
    if (!m) return;
    setPulling(true);
    const t = toast.loading(`Downloading ${m} on the server. Big models take a while…`);
    try {
      onPulled(await runCommand<OllamaList>(uid, "pull_model", { model: m }, 60 * 60_000));
      toast.success(`${m} is ready`, { id: t });
      setName("");
    } catch (e) {
      toast.error((e as Error).message, { id: t });
    } finally {
      setPulling(false);
    }
  };
  return (
    <div className="rounded-lg bg-surface-container p-4">
      <div className="flex items-center gap-2">
        <span className="flex-1 type-title-s">Models on your server (Ollama)</span>
        {ollama && <Chip tone={ollama.up ? "success" : "error"}>{ollama.up ? "Running" : "Not running"}</Chip>}
        <Button size="sm" variant="text" icon={IconRefresh} onClick={onRefresh} loading={loading} disabled={!online}>
          Refresh
        </Button>
      </div>
      {!online ? (
        <p className="mt-2 type-body-s text-on-surface-variant">Server offline. Start it to see and manage local models.</p>
      ) : !ollama ? (
        <div className="mt-3 flex items-center gap-2 type-body-s text-on-surface-variant">
          <Spinner className="size-4" /> Asking the server…
        </div>
      ) : (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {ollama.models.map((m) => (
            <Chip key={m.name} tone={ollama.loaded.includes(m.name) ? "primary" : "neutral"}>
              <span className="font-mono">{m.name}</span>
              <span className="opacity-70">· {GB(m.size)}</span>
            </Chip>
          ))}
          {!ollama.models.length && <li className="type-body-s text-on-surface-variant">No models yet.</li>}
        </ul>
      )}
      <div className="mt-3 flex gap-2">
        <TextInput placeholder="gemma3:1b, gemma3:12b, qwen3:4b…" value={name} onChange={(e) => setName(e.target.value)} className="font-mono text-sm" disabled={!online} />
        <Button variant="tonal" className="h-12" onClick={pull} loading={pulling} disabled={!online || !name.trim()}>
          Pull
        </Button>
      </div>
      <p className="mt-2 type-body-s text-on-surface-variant">
        Browse names at{" "}
        <a className="text-primary underline-offset-4 hover:underline" href="https://ollama.com/library" target="_blank" rel="noreferrer">
          ollama.com/library
        </a>
        . On an 8 GB laptop, stay at 4B parameters or below.
      </p>
    </div>
  );
}
