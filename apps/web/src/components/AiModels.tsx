// Settings → AI models: Gemini and Ollama Cloud keys (write-only), fetched model lists, primary + fallback routes with live tests.
import { useEffect, useState } from "react";
import { deleteDoc, deleteField, doc, setDoc, updateDoc } from "firebase/firestore";
import { toast } from "sonner";
import { pickRoutes, revertAutoSwitch, type AiKeyStatus, type AiPatch, type AiProvider, type AiRoute, type AiSettings } from "@spot/shared";
import { useApp } from "../lib/app";
import { db } from "@spot/ui/firebase";
import { runCommand, timeAgo, useDocument, userDoc } from "../lib/data";
import { serverName, useAllServers, useLease } from "../lib/fleet";
import { Button, Chip, IconButton, Info, SearchSelect, Segmented, Spinner, Switch, TextInput, cx } from "@spot/ui";
import { IconCheck, IconCpu, IconRefresh, IconServer, IconShield, IconSparkle, IconTrash, IconWarn } from "@spot/ui";

interface UserAiDoc {
  aiKeys?: AiKeyStatus;
  aiModels?: { gemini?: string[]; fetchedAt?: number };
}

interface OllamaList {
  up: boolean;
  models: { name: string; size: number }[];
  loaded: string[];
  /** Ollama Cloud models (`beam:cloud`) this account can use: there only when a key is set (server console or below). */
  cloud?: string[];
  cloudSource?: "server" | "account" | null;
  cloudError?: string | null;
}

/** settings.ai.cloud: a display hint only. The key itself is in users/{uid}/secrets/ollamaCloud, which this page can write but never read. */
interface CloudHint {
  url: string;
  keyHint: string;
  savedAt: number;
  model?: string | null;
}
const DEFAULT_CLOUD_URL = "https://ollama.com";
/** `beam:cloud`, `gpt-oss:20b-cloud`: runs on ollama.com, not on the server. */
const isCloudModel = (m: string) => /(:cloud|-cloud)$/i.test(m);

const GB = (b: number) => `${(b / 1e9).toFixed(1)} GB`;

/** Models worth downloading onto a small server, with what they need. */
const PULLABLE = [
  { name: "gemma3:1b", note: "fastest · ~1 GB" },
  { name: "gemma3:4b", note: "recommended · ~3.3 GB" },
  { name: "gemma3n:e2b", note: "efficient · ~5.6 GB" },
  { name: "gemma3n:e4b", note: "smarter · ~7.5 GB" },
  { name: "gemma3:12b", note: "needs 16 GB RAM · ~8 GB" },
  { name: "qwen3:4b", note: "alternative · ~2.5 GB" },
  { name: "llama3.2:3b", note: "alternative · ~2 GB" },
];

function textModels(list: { name: string; supportedGenerationMethods?: string[] }[]) {
  return list
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => /^(gemini|gemma)/.test(n) && !/(embedding|image|imagen|veo|tts|audio|live|vision|aqa|learnlm)/.test(n))
    .sort((a, b) => Number(b.startsWith("gemini")) - Number(a.startsWith("gemini")) || b.localeCompare(a, undefined, { numeric: true }));
}

/** Used once, when the key is first entered (the page still has it then). Later fetches go through the server. */
async function fetchWithKey(key: string) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ?? `Gemini said ${res.status}`);
  return textModels(body.models ?? []);
}

type Lists = Record<AiProvider, { models: string[]; fetch: () => void; busy: boolean; canFetch: boolean; ready: boolean; why: string }>;

export function AiModels() {
  const { uid, settings, workerOnline, server } = useApp();
  const me = useDocument<UserAiDoc>(["users", uid]);
  const gemini = me.data?.aiKeys?.gemini;
  const geminiModels = me.data?.aiModels?.gemini ?? [];
  const fetchedAt = me.data?.aiModels?.fetchedAt;
  const servers = useAllServers();
  const lease = useLease(uid);
  const host = serverName(servers, lease.data?.server);
  const [ollama, setOllama] = useState<OllamaList | null>(null);
  const [busy, setBusy] = useState<{ ollama?: boolean; gemini?: boolean }>({});

  const fetchOllama = async () => {
    setBusy((b) => ({ ...b, ollama: true }));
    try {
      setOllama(await runCommand<OllamaList>(uid, "list_models", {}, 30_000));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy((b) => ({ ...b, ollama: false }));
    }
  };
  const fetchGemini = async () => {
    setBusy((b) => ({ ...b, gemini: true }));
    try {
      const r = await runCommand<{ count: number }>(uid, "list_gemini_models", {}, 30_000);
      toast.success(`${r.count} Gemini models available`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy((b) => ({ ...b, gemini: false }));
    }
  };
  useEffect(() => {
    if (workerOnline && !ollama) void fetchOllama();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerOnline]);

  // Writes a switch/keep change field by field, so removed fields (autoSwitched, keepMissing) are really deleted.
  const writeAi = (p: AiPatch) =>
    updateDoc(doc(db, "users", uid), {
      ...Object.fromEntries(Object.entries(p.set).map(([k, v]) => [`settings.ai.${k}`, v])),
      ...Object.fromEntries(p.remove.map((k) => [`settings.ai.${k}`, deleteField()])),
    }).catch((e: Error) => toast.error(e.message));
  const installedNames = ollama?.up ? ollama.models.map((m) => m.name) : null;
  const cloudModels = (ollama?.cloud ?? []).filter((m) => !installedNames?.includes(m));
  const cloudHint = (settings.ai as AiSettings & { cloud?: CloudHint }).cloud;
  const pick = (next: { primary?: AiRoute; fallback?: AiRoute | null }) => writeAi(pickRoutes(settings.ai, next, installedNames, Date.now()));
  const lists: Lists = {
    ollama: {
      // Local models, then Ollama Cloud ones (labelled Cloud in the picker) when a key is set for this account.
      models: [...(ollama?.models ?? []).map((m) => m.name), ...cloudModels],
      fetch: fetchOllama,
      busy: !!busy.ollama,
      canFetch: workerOnline,
      ready: workerOnline && (!!ollama?.up || cloudModels.length > 0),
      why: !workerOnline ? (server.reach === "unknown" ? "You're offline" : "Server offline") : ollama && !ollama.up ? "Ollama isn't running on the server" : "Fetching models from your server…",
    },
    gemini: {
      models: geminiModels,
      fetch: fetchGemini,
      busy: !!busy.gemini,
      canFetch: workerOnline && !!gemini?.set,
      ready: !!gemini?.set,
      why: "Add a Gemini key above first",
    },
  };

  const sw = settings.ai.autoSwitched;
  const switched = sw && [settings.ai.primary, settings.ai.fallback].some((r) => r?.provider === "ollama" && r.model === sw.to) ? sw : null;
  const canon = (n: string) => (n.includes(":") ? n : `${n}:latest`);
  const has = (m: string) => installedNames?.some((n) => canon(n) === canon(m)) ?? false;
  // The model that was swapped out is installed on this server (the account moved, or it was installed since): offer the way back, never do it by itself.
  const fromHere = Boolean(switched && installedNames?.length && has(switched.from));
  const kept = settings.ai.keepMissing;
  const keptActive = kept && [settings.ai.primary, settings.ai.fallback].some((r) => r?.provider === "ollama" && canon(r.model) === canon(kept.model)) && installedNames?.length && !has(kept.model) ? kept : null;

  return (
    <div className="flex flex-col gap-4">
      <GeminiKey status={gemini} count={geminiModels.length} fetchedAt={fetchedAt} onFetch={fetchGemini} fetching={!!busy.gemini} canFetch={workerOnline} />
      <CloudKey hint={cloudHint} list={ollama} onSaved={() => { if (workerOnline) setTimeout(() => void fetchOllama(), 2_500); }} />

      {switched && (
        <p role="status" className="flex items-start gap-2 rounded-lg bg-surface-container p-3 type-body-s text-on-surface-variant">
          <IconWarn className="icon mt-0.5 size-4 flex-none" />
          <span className="min-w-0 flex-1">
            {fromHere ? (
              <>
                <span className="font-mono">{switched.from}</span> is installed on {host}. Your model was changed to <span className="font-mono">{switched.to}</span> because it wasn't on {switched.server}.
              </>
            ) : (
              <>
                {switched.from} isn't installed on {switched.server}, so your model is now <span className="font-mono">{switched.to}</span>. Pick another below if you'd rather.
              </>
            )}
          </span>
          <Button size="sm" variant="tonal" onClick={() => { const p = revertAutoSwitch(settings.ai, { keepMissing: !fromHere, now: Date.now() }); if (p) void writeAi(p); }}>
            {fromHere ? `Switch back to ${switched.from}` : "Undo"}
          </Button>
        </p>
      )}
      {!switched && keptActive && (
        <p role="status" className="flex items-start gap-2 rounded-lg bg-surface-container p-3 type-body-s text-on-surface-variant">
          <IconWarn className="icon mt-0.5 size-4 flex-none" />
          <span>
            <span className="font-mono">{keptActive.model}</span> isn't installed on {host}; another model answers until you install it. Install it from the server console's AI models.
          </span>
        </p>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
        <RouteCard title="Primary" host={host} info="Reads every incoming message first." route={settings.ai.primary} lists={lists} onChange={(r) => pick({ primary: r })} onKeep={(m) => writeAi({ set: { keepMissing: { model: m, at: Date.now() } }, remove: [] })} kept={keptActive?.model} />
        <RouteCard
          title="Fallback"
          host={host}
          info="Used only if the primary fails or times out. When off, that message is skipped and noted in the server log."
          route={settings.ai.fallback}
          lists={lists}
          onChange={(r) => pick({ fallback: r })}
          onKeep={(m) => writeAi({ set: { keepMissing: { model: m, at: Date.now() } }, remove: [] })}
          kept={keptActive?.model}
          toggle={{
            on: Boolean(settings.ai.fallback),
            set: (v) =>
              pick({
                fallback: v
                  ? settings.ai.primary.provider === "ollama"
                    ? { provider: "gemini", model: geminiModels[0] ?? "" }
                    : { provider: "ollama", model: ollama?.models[0]?.name ?? "" }
                  : null,
              }),
          }}
        />
      </div>

      <OllamaPanel ollama={ollama} loading={!!busy.ollama} onRefresh={fetchOllama} onPulled={setOllama} online={workerOnline} />
    </div>
  );
}

function GeminiKey({ status, count, fetchedAt, onFetch, fetching, canFetch }: { status?: AiKeyStatus["gemini"]; count: number; fetchedAt?: number; onFetch: () => void; fetching: boolean; canFetch: boolean }) {
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
      const models = await fetchWithKey(k);
      await setDoc(userDoc(uid, "secrets", "ai"), { geminiKey: k }, { merge: true });
      await setDoc(doc(db, "users", uid), { aiKeys: { gemini: { set: true, last4: k.slice(-4), updatedAt: Date.now() } }, aiModels: { gemini: models, fetchedAt: Date.now() } }, { merge: true });
      setKey("");
      setEditing(false);
      toast.success(`Key works. ${models.length} models fetched.`);
    } catch (e) {
      toast.error(`Key didn't work: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm("Remove your Gemini key? Anything routed to Gemini stops working.")) return;
    await deleteDoc(userDoc(uid, "secrets", "ai"));
    await setDoc(doc(db, "users", uid), { aiKeys: { gemini: null }, aiModels: { gemini: [] } }, { merge: true });
    toast("Gemini key removed");
  };

  return (
    <div className="rounded-lg bg-surface-container p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="grid size-9 flex-none place-items-center rounded-md bg-tertiary-container text-on-tertiary-container">
          <IconSparkle className="icon size-5" />
        </span>
        <span className="type-title-s">Gemini API key</span>
        <Info>Smarter cloud models (Gemini 2.5, Gemma 27B). Get a free key at aistudio.google.com/apikey. Stored write-only: this page can't read it back, only your server uses it.</Info>
        {status?.set ? (
          <Chip tone="success" icon={IconCheck}>
            ••••{status.last4}
          </Chip>
        ) : (
          <Chip>Not set</Chip>
        )}
        <div className="flex-1" />
        {status?.set && !editing && (
          <div className="flex items-center gap-1">
            <span className="mr-2 hidden type-body-s text-on-surface-variant md:inline">
              {count} models{fetchedAt ? ` · fetched ${timeAgo(fetchedAt)}` : ""}
            </span>
            <Button size="sm" variant="tonal" icon={IconRefresh} onClick={onFetch} loading={fetching} disabled={!canFetch}>
              Fetch models
            </Button>
            <Button size="sm" variant="text" onClick={() => setEditing(true)}>
              Replace
            </Button>
            <IconButton icon={IconTrash} label="Remove key" onClick={remove} className="size-8 text-error" />
          </div>
        )}
      </div>
      {showInput && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <TextInput type="password" autoComplete="off" placeholder="Paste key (AIza…)" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} className="font-mono" />
          <Button onClick={save} loading={busy} disabled={!key.trim()} icon={IconShield} className="h-12 flex-none">
            Test & save
          </Button>
          {editing && (
            <Button variant="text" className="h-12 flex-none" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Ollama Cloud key for this account: written to users/{uid}/secrets/ollamaCloud (write-only, rules forbid reading it back), so every
 * server this account runs on gets it without typing it there. A key set in a server's console wins over this one on that server.
 */
function CloudKey({ hint, list, onSaved }: { hint?: CloudHint; list: OllamaList | null; onSaved: () => void }) {
  const { uid } = useApp();
  const [key, setKey] = useState("");
  const [url, setUrl] = useState(hint?.url ?? DEFAULT_CLOUD_URL);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const showInput = !hint || editing;

  const save = async () => {
    const k = key.replace(/\s+/g, "");
    const u = url.trim().replace(/\/+$/, "") || DEFAULT_CLOUD_URL;
    if (!k) return;
    if (!/^https:\/\//i.test(u)) return toast.error("The URL must start with https:// (for example https://ollama.com).");
    if (k.length < 16) return toast.error("That doesn't look like an Ollama API key. Copy it again from ollama.com/settings/keys.");
    setBusy(true);
    try {
      const savedAt = Date.now();
      await setDoc(userDoc(uid, "secrets", "ollamaCloud"), { key: k, url: u, savedAt });
      await updateDoc(doc(db, "users", uid), { "settings.ai.cloud": { url: u, keyHint: k.slice(-4), savedAt, model: hint?.model ?? null } satisfies CloudHint });
      setKey("");
      setEditing(false);
      setShow(false);
      toast.success("Ollama Cloud key saved. Your server picks it up in a few seconds.");
      onSaved();
    } catch (e) {
      toast.error(`Couldn't save the key: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm("Remove your Ollama Cloud key? Cloud models stop answering for you, unless your server's console has its own key.")) return;
    await deleteDoc(userDoc(uid, "secrets", "ollamaCloud"));
    await updateDoc(doc(db, "users", uid), { "settings.ai.cloud": deleteField() });
    toast("Ollama Cloud key removed");
    onSaved();
  };

  const source = list?.cloudSource;
  return (
    <div className="rounded-lg bg-surface-container p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="grid size-9 flex-none place-items-center rounded-md bg-secondary-container text-on-secondary-container">
          <IconServer className="icon size-5" />
        </span>
        <span className="type-title-s">Ollama Cloud key</span>
        <Info>Bigger models (like beam) that run on ollama.com. Get a key at ollama.com/settings/keys. Stored write-only and sent to every server your account runs on; a key set in a server's own console wins there.</Info>
        {hint ? (
          <Chip tone="success" icon={IconCheck}>
            ••••{hint.keyHint}
          </Chip>
        ) : (
          <Chip>Not set</Chip>
        )}
        <div className="flex-1" />
        {hint && !editing && (
          <div className="flex items-center gap-1">
            <span className="mr-2 hidden type-body-s text-on-surface-variant md:inline">saved {timeAgo(hint.savedAt)}</span>
            <Button size="sm" variant="text" onClick={() => { setUrl(hint.url); setEditing(true); }}>
              Replace
            </Button>
            <IconButton icon={IconTrash} label="Remove Ollama Cloud key" onClick={remove} className="size-8 text-error" />
          </div>
        )}
      </div>
      {(source || list?.cloudError) && (
        <p className={cx("mt-2 type-body-s", list?.cloudError ? "text-error" : "text-on-surface-variant")}>
          {list?.cloudError
            ? list.cloudError
            : source === "server"
              ? `Your server uses the key from its own console (it wins over this one). ${list?.cloud?.length ?? 0} cloud models available.`
              : `Your server uses this key. ${list?.cloud?.length ?? 0} cloud models available; pick one below (labelled Cloud).`}
        </p>
      )}
      {showInput && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <TextInput aria-label="Ollama Cloud URL" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono sm:max-w-64" />
          <div className="flex min-w-0 flex-1 gap-2">
            <TextInput type={show ? "text" : "password"} aria-label="Ollama API key" autoComplete="off" placeholder="Paste your Ollama API key" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} className="min-w-0 font-mono" />
            <Button variant="text" className="h-12 flex-none" onClick={() => setShow((v) => !v)} aria-pressed={show}>
              {show ? "Hide" : "Show"}
            </Button>
          </div>
          <Button onClick={save} loading={busy} disabled={!key.trim()} icon={IconShield} className="h-12 flex-none">
            Save
          </Button>
          {editing && (
            <Button variant="text" className="h-12 flex-none" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function RouteCard({ title, host, info, route, lists, onChange, onKeep, kept, toggle }: { title: string; host: string; info: string; route: AiRoute | null; lists: Lists; onChange: (r: AiRoute) => void; onKeep: (model: string) => void; kept?: string; toggle?: { on: boolean; set: (v: boolean) => void } }) {
  const { uid, workerOnline } = useApp();
  const [test, setTest] = useState<{ state: "idle" | "running" | "ok" | "fail"; msg?: string }>({ state: "idle" });
  useEffect(() => setTest({ state: "idle" }), [route?.provider, route?.model]);

  const provider = route?.provider ?? "ollama";
  const list = lists[provider];
  const valid = Boolean(route && list.models.includes(route.model));
  const missingLocal = Boolean(route && provider === "ollama" && route.model && !isCloudModel(route.model) && list.ready && list.models.length && !valid);
  const problem = !route ? "" : !list.ready ? list.why : !list.models.length ? "No models fetched yet. Tap ↻ to fetch them." : !valid ? (provider === "ollama" && route.model && isCloudModel(route.model) ? `${route.model} is an Ollama Cloud model. Add an Ollama Cloud key above (or on the server console) to use it.` : provider === "ollama" && route.model ? `${route.model} isn't installed on ${host}. Install it from the server console's AI models, or pick another.` : "Pick a model from the list") : "";

  const runTest = async () => {
    if (!route) return;
    setTest({ state: "running" });
    try {
      const r = await runCommand<{ ms: number }>(uid, "test_ai", { provider: route.provider, model: route.model }, 120_000);
      setTest({ state: "ok", msg: `Works · answered in ${(r.ms / 1000).toFixed(1)} s` });
    } catch (e) {
      setTest({ state: "fail", msg: (e as Error).message });
    }
  };

  // One fixed-height status line (problem, test result or hint), so the card never changes size.
  const status =
    !route
      ? { tone: "text-on-surface-variant", text: "Off" }
      : test.state !== "idle"
        ? { tone: test.state === "ok" ? "text-primary" : test.state === "fail" ? "text-error" : "text-on-surface-variant", text: test.msg ?? "Testing…" }
        : problem
          ? { tone: "text-error", text: problem }
          : { tone: "text-on-surface-variant", text: "Sends a tiny prompt through your server" };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-outline-variant p-4">
      <div className="flex h-8 items-center gap-1.5">
        <span className="type-title-s">{title}</span>
        <Info>{info}</Info>
        <div className="flex-1" />
        {toggle && <Switch checked={toggle.on} onChange={toggle.set} label={`Use a ${title.toLowerCase()} model`} />}
      </div>

      <div className={cx("flex flex-col gap-3 transition-opacity", !route && "pointer-events-none opacity-40")} aria-disabled={!route}>
        <Segmented
          full
          value={provider}
          onChange={(p) => onChange({ provider: p, model: lists[p].models[0] ?? "" })}
          options={[
            { value: "ollama", label: lists.ollama.models.some(isCloudModel) ? "Ollama · local & Cloud" : "Local · Ollama", icon: IconCpu },
            { value: "gemini", label: "Gemini", icon: IconSparkle },
          ]}
        />
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <SearchSelect
              label="Model"
              searchPlaceholder="Search models"
              value={valid ? route!.model : ""}
              onChange={(m) => route && onChange({ ...route, model: m })}
              placeholder={list.models.length ? "Choose a model" : "No models fetched"}
              options={list.models.map((m) => ({ value: m, label: provider === "ollama" && isCloudModel(m) ? `${m} · Cloud` : m }))}
              className="font-mono text-sm"
            />
          </div>
          <IconButton
            icon={IconRefresh}
            label={`Fetch ${provider === "gemini" ? "Gemini" : "Ollama"} models`}
            tone="tonal"
            onClick={list.fetch}
            disabled={!list.canFetch || list.busy}
            className={cx("size-12 flex-none", list.busy && "[&_svg]:animate-spin")}
          />
        </div>
        <div className="flex h-8 items-center gap-3">
          <Button size="sm" variant="tonal" onClick={runTest} disabled={!workerOnline || !valid || test.state === "running"} loading={test.state === "running"}>
            Test
          </Button>
          {missingLocal && route && kept !== route.model && (
            <Button size="sm" variant="text" onClick={() => onKeep(route.model)} title="Keep this model even though it isn't installed. Another model answers until you install it; nothing is swapped in your settings.">
              Keep anyway
            </Button>
          )}
          <span className={cx("flex min-w-0 flex-1 items-center gap-1.5 type-body-s", status.tone)} title={status.text}>
            {problem && route && test.state === "idle" && <IconWarn className="icon size-4 flex-none" />}
            <span className="truncate">{status.text}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function OllamaPanel({ ollama, loading, onRefresh, onPulled, online }: { ollama: OllamaList | null; loading: boolean; onRefresh: () => void; onPulled: (o: OllamaList) => void; online: boolean }) {
  const { uid } = useApp();
  const installed = new Set(ollama?.models.map((m) => m.name));
  const choices = PULLABLE.filter((m) => !installed.has(m.name));
  const [name, setName] = useState("");
  const [pulling, setPulling] = useState(false);
  const pull = async () => {
    if (!name) return;
    setPulling(true);
    const t = toast.loading(`Downloading ${name} on the server. This can take a while…`);
    try {
      onPulled(await runCommand<OllamaList>(uid, "pull_model", { model: name }, 60 * 60_000));
      toast.success(`${name} is ready`, { id: t });
      setName("");
    } catch (e) {
      toast.error((e as Error).message, { id: t });
    } finally {
      setPulling(false);
    }
  };
  return (
    <div className="rounded-lg bg-surface-container p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="type-title-s">Models on your server</span>
        <Info>Local models run on your own laptop through Ollama, so chats never leave it. On an 8 GB machine, stay at 4B parameters or below.</Info>
        {ollama && <Chip tone={ollama.up ? "success" : "error"}>{ollama.up ? "Ollama running" : "Ollama not running"}</Chip>}
        <div className="flex-1" />
        <Button size="sm" variant="text" icon={IconRefresh} onClick={onRefresh} loading={loading} disabled={!online}>
          Refresh
        </Button>
      </div>
      <div className="mt-3 flex min-h-8 flex-wrap items-center gap-1.5">
        {!online ? (
          <span className="type-body-s text-on-surface-variant">Server offline.</span>
        ) : !ollama ? (
          <span className="flex items-center gap-2 type-body-s text-on-surface-variant">
            <Spinner className="size-4" /> Asking the server…
          </span>
        ) : ollama.models.length ? (
          ollama.models.map((m) => (
            <Chip key={m.name} tone={ollama.loaded.includes(m.name) ? "primary" : "neutral"}>
              <span className="font-mono">{m.name}</span>
              <span className="opacity-70">· {GB(m.size)}</span>
            </Chip>
          ))
        ) : (
          <span className="type-body-s text-on-surface-variant">No models yet.</span>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <div className="min-w-0 flex-1">
          <SearchSelect label="Add a model" searchPlaceholder="Search models" value={name} onChange={setName} placeholder={choices.length ? "Add a model…" : "All suggested models installed"} options={choices.map((m) => ({ value: m.name, label: `${m.name} · ${m.note}` }))} className="font-mono text-sm" />
        </div>
        <Button variant="tonal" className="h-12 flex-none" onClick={pull} loading={pulling} disabled={!online || !name}>
          Download
        </Button>
      </div>
      <p className="mt-2 type-body-s text-on-surface-variant">Only models listed above are installed on this server. A model that isn't gets swapped for one that is. You can also install one from the server console's AI models.</p>
    </div>
  );
}
