// "AI models" on the server console: the server's Gemini key, which models to use, a quick test, pulling local models,
// and the default routing for curators who haven't set their own (their own settings in the app always win).
// Thin calls to the Gemini REST API and Ollama, so the console works before and without the worker.
// The Gemini key goes in a header, never a URL, and is scrubbed from every message shown or logged.

import "./envcompat.mjs";

export const MODES = {
  local_first: "Local first, Gemini as backup",
  gemini_first: "Gemini first, local as backup",
  gemini_only: "Gemini only",
  local_only: "Local only (chats never reach Gemini)",
};
const GEMINI = process.env.NBS_GEMINI_URL ?? "https://generativelanguage.googleapis.com/v1beta";
// Gemini keys from AI Studio are long URL-safe strings (classic "AIza…" keys, and newer formats that may include dots).
const KEY_RE = /^[A-Za-z0-9._-]{20,300}$/;
const NAME_RE = /^[A-Za-z0-9._:/-]{1,100}$/;

export const maskKey = (k) => (k ? `••••${String(k).slice(-4)}` : null);
export const validKey = (k) => typeof k === "string" && KEY_RE.test(k.trim());
export const validModel = (m) => typeof m === "string" && NAME_RE.test(m);
export const validMode = (m) => typeof m === "string" && Object.hasOwn(MODES, m);

/** Messages for people: never contain the key. */
export const scrub = (msg, key) => {
  let s = String(msg ?? "");
  if (key) s = s.split(key).join("••••");
  return s.replace(/AIza[0-9A-Za-z_-]{20,}/g, "••••").slice(0, 300);
};

/** Text-capable Gemini and Gemma models, Gemini first, newest first (same filter as the app's AI models). */
export function pickModels(models) {
  return (models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => String(m.name).replace(/^models\//, ""))
    .filter((n) => /^(gemini|gemma)/.test(n) && !/(embedding|image|imagen|veo|tts|audio|live|vision|aqa|learnlm)/.test(n))
    .sort((a, b) => Number(b.startsWith("gemini")) - Number(a.startsWith("gemini")) || b.localeCompare(a, undefined, { numeric: true }));
}

/** The model the worker uses for local answers when none is chosen (apps/worker/src/serverAi.ts DEFAULT_LOCAL_MODEL). */
export const DEFAULT_LOCAL_MODEL = "gemma3:4b";

/** Installed models for the page: Ollama's /api/tags joined with /api/ps (what is loaded in memory right now). Pure, for tests. */
export function shapeModels(tags, ps, selected) {
  const loaded = new Map((ps ?? []).map((m) => [m.name ?? m.model, m]));
  const list = (tags ?? []).map((m) => {
    const l = loaded.get(m.name);
    return {
      name: String(m.name),
      size: Number(m.size) || 0,
      modifiedAt: m.modified_at ? Date.parse(m.modified_at) || null : null,
      inUse: m.name === selected,
      loaded: Boolean(l),
      loadedBytes: l ? Number(l.size) || null : null,
      unloadsAt: l?.expires_at ? Date.parse(l.expires_at) || null : null,
    };
  });
  return { list, totalBytes: list.reduce((n, m) => n + m.size, 0) };
}

export function createAi({ readEnv, writeEnv, restartWorker, ollamaUrl, ollamaInfo, noLocalModel, diskFree = () => null, fetchImpl = fetch }) {
  const geminiKey = (override) => (validKey(override) ? override : readEnv().GEMINI_API_KEY || "");
  let pull = null; // { model, status, completed, total, done, error, startedAt }

  /** The model the server answers with locally: the one chosen in the console, or the built-in default. */
  const selectedModel = () => readEnv().NBS_LOCAL_MODEL || DEFAULT_LOCAL_MODEL;

  async function localModels() {
    if (noLocalModel()) return null;
    try {
      const [t, p] = await Promise.all([
        fetchImpl(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2500) }).then((r) => r.json()),
        fetchImpl(`${ollamaUrl}/api/ps`, { signal: AbortSignal.timeout(2500) }).then((r) => r.json()).catch(() => ({})),
      ]);
      return { ...shapeModels(t.models, p.models, selectedModel()), selected: selectedModel(), free: diskFree() };
    } catch {
      return null;
    }
  }

  /** Removes a model from Ollama. Never the one the server uses, never a name that isn't a model. Returns the bytes freed. */
  async function deleteModel(name) {
    if (!validModel(name)) throw new Error("That isn't a model name.");
    if (noLocalModel()) throw new Error("This server runs without a local model.");
    if (name === selectedModel()) throw new Error(`${name} is the model this server uses. Pick another model first, then delete this one.`);
    const m = await localModels();
    const have = m?.list.find((x) => x.name === name);
    if (!have) throw new Error(`${name} isn't installed.`);
    const r = await fetchImpl(`${ollamaUrl}/api/delete`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Ollama said ${r.status}`);
    return { freed: have.size };
  }

  /** Frees a loaded model's memory right now (keep_alive 0). It loads again on the next question. */
  async function unloadModel(name) {
    if (!validModel(name)) throw new Error("That isn't a model name.");
    if (noLocalModel()) throw new Error("This server runs without a local model.");
    const r = await fetchImpl(`${ollamaUrl}/api/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: name, keep_alive: 0 }), signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Ollama said ${r.status}`);
  }

  async function view() {
    const env = readEnv();
    const o = await ollamaInfo();
    return {
      geminiKey: maskKey(env.GEMINI_API_KEY),
      mode: validMode(env.NBS_AI_MODE) ? env.NBS_AI_MODE : null,
      modes: MODES,
      localModel: env.NBS_LOCAL_MODEL || null,
      geminiModel: env.NBS_GEMINI_MODEL || null,
      localEnabled: !noLocalModel(),
      ollama: o,
      local: await localModels(),
      pull,
    };
  }

  async function listModels(keyOverride) {
    const key = geminiKey(keyOverride);
    if (!key) throw new Error("Add a Gemini key first.");
    try {
      const r = await fetchImpl(`${GEMINI}/models?pageSize=200`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(15_000) });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.error?.message ?? `Gemini said ${r.status}`);
      return pickModels(b.models);
    } catch (e) {
      throw new Error(scrub(e.message, key));
    }
  }

  async function test({ provider, model, key }) {
    if (!validModel(model)) throw new Error("Pick a model first.");
    const t = Date.now();
    if (provider === "gemini") {
      const k = geminiKey(key);
      if (!k) throw new Error("Add a Gemini key first.");
      try {
        const r = await fetchImpl(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": k },
          body: JSON.stringify({ contents: [{ parts: [{ text: "Reply with only the word OK." }] }], generationConfig: { maxOutputTokens: 16, temperature: 0 } }),
          signal: AbortSignal.timeout(30_000),
        });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(b.error?.message ?? `Gemini said ${r.status}`);
        return { ms: Date.now() - t, reply: String(b.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim().slice(0, 60) };
      } catch (e) {
        throw new Error(scrub(e.message, k));
      }
    }
    if (noLocalModel()) throw new Error("This server runs without a local model.");
    try {
      const r = await fetchImpl(`${ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, stream: false, think: false, keep_alive: "5m", options: { temperature: 0, num_predict: 16 }, messages: [{ role: "user", content: "Reply with only the word OK." }] }),
        signal: AbortSignal.timeout(180_000), // the first call loads the model into memory
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.error ?? `Ollama said ${r.status}`);
      return { ms: Date.now() - t, reply: String(b.message?.content ?? "").trim().slice(0, 60) };
    } catch (e) {
      throw new Error(e.name === "TimeoutError" ? "The model took too long to answer." : e.message);
    }
  }

  async function startPull(model) {
    if (!validModel(model)) throw new Error("Type a model name like gemma3:4b.");
    if (noLocalModel()) throw new Error("This server runs without a local model. Turn it on first.");
    if (pull && !pull.done) throw new Error(`Already downloading ${pull.model}.`);
    const mine = (pull = { model, status: "Starting", completed: 0, total: 0, done: false, error: null, startedAt: Date.now() });
    (async () => {
      try {
        const r = await fetchImpl(`${ollamaUrl}/api/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, stream: true }) });
        if (!r.ok || !r.body) throw new Error((await r.text().catch(() => "")).slice(0, 200) || `Ollama said ${r.status}`);
        const dec = new TextDecoder();
        let buf = "";
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            let j;
            try { j = JSON.parse(line); } catch { continue; }
            if (j.error) throw new Error(j.error);
            mine.status = j.status ?? mine.status;
            if (typeof j.total === "number") { mine.total = j.total; mine.completed = j.completed ?? 0; }
          }
        }
        mine.status = "Ready";
      } catch (e) {
        mine.error = e.message || "Download failed";
      }
      mine.done = true;
    })();
    return mine;
  }

  async function setKey(raw) {
    // Copying from AI Studio often brings a space or line break along; never let that fail a good key.
    const key = typeof raw === "string" ? raw.replace(/\s+/g, "") : raw;
    if (key === "" || key === null) { writeEnv({ GEMINI_API_KEY: "" }); await restartWorker(); return; }
    if (!validKey(key)) throw new Error("That doesn't look like a Gemini key. Copy it again from Google AI Studio (aistudio.google.com/apikey).");
    // Ask Google instead of guessing from the shape: a key it rejects is never saved.
    const check = await fetchImpl(`${GEMINI}/models?pageSize=1`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (check && (check.status === 400 || check.status === 401 || check.status === 403)) throw new Error("Google didn't accept this key. Check it's an API key from Google AI Studio and that the Gemini API is enabled for it.");
    writeEnv({ GEMINI_API_KEY: key });
    await restartWorker();
  }

  async function setDefaults({ mode, localModel, geminiModel }) {
    const patch = {};
    if (mode !== undefined) {
      if (mode !== "" && !validMode(mode)) throw new Error("Unknown routing.");
      patch.NBS_AI_MODE = mode;
    }
    if (localModel !== undefined) {
      if (localModel !== "" && !validModel(localModel)) throw new Error("That isn't a model name.");
      patch.NBS_LOCAL_MODEL = localModel;
    }
    if (geminiModel !== undefined) {
      if (geminiModel !== "" && !validModel(geminiModel)) throw new Error("That isn't a model name.");
      patch.NBS_GEMINI_MODEL = geminiModel;
    }
    if (!Object.keys(patch).length) throw new Error("Nothing to change.");
    writeEnv(patch);
    await restartWorker();
  }

  return { view, localModels, deleteModel, unloadModel, listModels, test, startPull, setKey, setDefaults, pullState: () => pull };
}
