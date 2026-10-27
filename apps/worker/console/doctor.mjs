// The server doctor: one list of checks that finds what a Nothing BOT Server needs to run (runtime, packages, WhatsApp's
// browser, AI model, data, settings, services, disk), reuses what an older install already has, downloads what is
// missing, and says the result in plain words. Run after install, after every update, at worker/console start and from
// the console's "Check and repair" button. This file is only the decisions; every touch on the machine goes through `d`
// (fs, run, fetch...), so tests use fakes and the platform scripts only supply the platform actions. See doctor-run.mjs.
//
// A check is { id, title, run(d) -> { ok, detail, fix? }, repair?(d) -> detail }.  `critical` ones stop an install when they stay broken.
import path from "node:path";

const GIB = 1024 ** 3;
export const MIN_NODE_MAJOR = 22;
export const MIN_FREE_BYTES = 2 * GIB;

/** Top-level entries of an old data folder that are never carried over (machine-specific or regenerated). */
export const NOT_MIGRATED = new Set(["console-token", "live-stats.json", "live-stats.json.tmp", "update.json", "update.json.tmp", "task.json", "move.json", "console.log", "worker.log", ".nbs-data-copy"]);

const sessionsDir = (d) => path.join(d.paths.dataDir, "wwebjs");
const hasEntries = (d, dir) => { try { return d.fs.readdirSync(dir).length > 0; } catch { return false; } };

export const CHECKS = [
  {
    id: "node", title: "Node.js runtime", critical: true,
    run: (d) => {
      const major = Number(String(d.nodeVersion).replace(/^v/, "").split(".")[0]);
      return major >= MIN_NODE_MAJOR ? { ok: true, detail: `Node ${d.nodeVersion}` } : { ok: false, detail: `Node ${d.nodeVersion} is too old (needs ${MIN_NODE_MAJOR} or newer)`, fix: "Run Update, or run the installer again; it installs the right Node." };
    },
  },
  {
    id: "deps", title: "Program files and packages", critical: true,
    run: (d) => {
      const wk = path.join(d.paths.appDir, "apps", "worker");
      if (!d.fs.existsSync(path.join(wk, "package.json"))) return { ok: false, detail: "The server program isn't installed here", fix: "Run the installer again." };
      if (!d.fs.existsSync(path.join(wk, "node_modules", "whatsapp-web.js")) || !d.fs.existsSync(path.join(wk, "node_modules", "tsx"))) return { ok: false, detail: "Some packages are missing", repairable: true };
      // pnpm keeps a copy of the lockfile it installed from; a different one means an update didn't finish installing.
      const have = d.readText(path.join(d.paths.appDir, "node_modules", ".pnpm", "lock.yaml"));
      const want = d.readText(path.join(d.paths.appDir, "pnpm-lock.yaml"));
      if (want && have && have !== want) return { ok: false, detail: "The installed packages are older than this version needs", repairable: true };
      return { ok: true, detail: "Packages are installed" };
    },
    repair: async (d) => { await d.installDeps(); return "Packages reinstalled"; },
  },
  {
    id: "browser", title: "WhatsApp's browser (Chrome)", critical: true,
    run: async (d) => {
      const r = await d.browserCheck(); // { ok, path?, build? }
      return r.ok ? { ok: true, detail: `Chrome ${r.build ?? ""} is ready`.replace("  ", " ") } : { ok: false, detail: "WhatsApp's browser isn't installed on this server", repairable: true };
    },
    repair: async (d) => { await d.browserEnsure(d.paths.legacyChromeDirs); return "Browser installed (an older copy was reused when there was one)"; },
  },
  {
    id: "data", title: "Data folder", critical: true,
    run: (d) => {
      if (!d.fs.existsSync(d.paths.dataDir)) return { ok: false, detail: `${d.paths.dataDir} doesn't exist`, repairable: true };
      try { d.fs.accessWritable(d.paths.dataDir); } catch { return { ok: false, detail: `${d.paths.dataDir} can't be written to`, fix: "Check the folder's permissions, or that its drive is connected." }; }
      return { ok: true, detail: d.paths.dataDir };
    },
    repair: (d) => { d.fs.mkdirSync(d.paths.dataDir, { recursive: true }); return "Data folder created"; },
  },
  {
    id: "legacy-data", title: "Data from an older install",
    run: (d) => {
      const old = (d.paths.legacyDataDirs ?? []).find((x) => x !== d.paths.dataDir && hasEntries(d, path.join(x, "wwebjs")));
      if (!old) return { ok: true, detail: "Nothing to bring over" };
      if (hasEntries(d, sessionsDir(d))) return { ok: true, detail: "This server already has its own WhatsApp logins" };
      return { ok: false, detail: `An older install at ${old} has WhatsApp logins and settings that this server doesn't have yet`, repairable: true, old };
    },
    // Copies only what's missing; nothing already in the new folder is ever replaced.
    repair: (d, res) => {
      const old = res?.old ?? (d.paths.legacyDataDirs ?? []).find((x) => hasEntries(d, path.join(x, "wwebjs")));
      if (!old) return "Nothing to bring over";
      d.fs.mkdirSync(d.paths.dataDir, { recursive: true });
      let n = 0;
      for (const name of d.fs.readdirSync(old)) {
        if (NOT_MIGRATED.has(name)) continue;
        const to = path.join(d.paths.dataDir, name);
        if (d.fs.existsSync(to)) continue;
        d.fs.cpSync(path.join(old, name), to, { recursive: true, force: false, errorOnExist: false, verbatimSymlinks: true });
        n++;
      }
      return `Copied ${n} item${n === 1 ? "" : "s"} from ${old} (your old install is untouched)`;
    },
  },
  {
    id: "settings", title: "Settings (.env) and Firebase key",
    run: (d) => {
      const raw = d.readText(d.paths.envFile);
      if (raw == null) return { ok: false, detail: "There are no saved settings yet", repairable: true };
      const env = d.parseEnv(raw);
      const legacy = Object.keys(env).filter((k) => k.startsWith("SPOT_") && !Object.keys(env).includes("NBS_" + k.slice(5)));
      if (legacy.length) return { ok: false, detail: `${legacy.length} setting${legacy.length === 1 ? " is" : "s are"} still under the old SPOT_ names`, repairable: true, legacy, env };
      const key = env.FIREBASE_SERVICE_ACCOUNT;
      if (!key) return { ok: false, detail: "No Firebase key is set", fix: "Open the console and add this server's key (Server section)." };
      const txt = d.readText(key);
      if (txt == null) return { ok: false, detail: "This server has no Firebase key yet", fix: "Open the console and add this server's key (Server section)." };
      try { const j = JSON.parse(txt); if (!j.private_key || !j.client_email) throw 0; } catch { return { ok: false, detail: "The Firebase key file isn't a valid key", fix: "Add a fresh key from the console." }; }
      return { ok: true, detail: "Settings and key look good" };
    },
    repair: (d, res) => {
      if (res?.detail?.startsWith("There are no saved")) { d.writeText(d.paths.envFile, `FIREBASE_SERVICE_ACCOUNT=${path.join(d.paths.dataDir, "service-account.json")}\nWWEBJS_DATA=${path.join(d.paths.dataDir, "wwebjs")}\nCHROME_PATH=\n`); return "Created a settings file; add the Firebase key in the console"; }
      const lines = d.readText(d.paths.envFile).split("\n");
      const out = [...lines];
      for (const l of lines) { const m = /^SPOT_([A-Z0-9_]+)=(.*)$/.exec(l); if (m && !lines.some((x) => x.startsWith(`NBS_${m[1]}=`))) out.push(`NBS_${m[1]}=${m[2]}`); }
      d.writeText(d.paths.envFile, out.join("\n"));
      return "Old SPOT_ settings copied to their new NBS_ names";
    },
  },
  {
    id: "ai", title: "Local AI model (Ollama)",
    run: async (d) => {
      const env = d.parseEnv(d.readText(d.paths.envFile) ?? "");
      if (/^(1|true|yes)$/i.test(env.NBS_NO_LOCAL_MODEL ?? "")) return { ok: true, detail: "This server uses Gemini only; no local model needed" };
      const model = env.NBS_LOCAL_MODEL || d.defaultModel;
      const tags = await d.ollamaTags(); // null when unreachable
      if (!tags) return { ok: false, detail: "Ollama isn't running or isn't installed", repairable: true, background: true };
      if (!tags.some((m) => m === model || m.split(":")[0] === model)) return { ok: false, detail: `The AI model ${model} isn't downloaded yet`, repairable: true, background: true };
      return { ok: true, detail: `Ollama is running with ${model}` };
    },
    repair: async (d) => { await d.ollamaEnsure(); return "Starting Ollama and downloading the model in the background (it can take a while)"; },
  },
  {
    id: "services", title: "Background services",
    run: async (d) => { const r = await d.servicesCheck(); return r.ok ? { ok: true, detail: "Services are set up for this install" } : { ok: false, detail: r.detail, repairable: Boolean(d.servicesRepair), fix: d.servicesRepair ? undefined : "Run the installer again." }; },
    repair: async (d) => { await d.servicesRepair(); return "Services re-registered"; },
  },
  {
    id: "disk", title: "Disk space",
    run: async (d) => {
      const free = await d.freeBytes(d.paths.dataDir);
      if (free == null) return { ok: true, detail: "Couldn't measure free space" };
      return free >= MIN_FREE_BYTES ? { ok: true, detail: `${(free / GIB).toFixed(1)} GB free` } : { ok: false, detail: `Only ${(free / GIB).toFixed(1)} GB free`, fix: "Free some space (Storage in the console can clean up old copies)." };
    },
  },
];

/** The checks that are quick enough to run at every start (no network, no downloads). */
export const QUICK = new Set(["node", "deps", "data", "settings", "disk"]);

async function runOne(check, d) {
  try { return { id: check.id, title: check.title, critical: Boolean(check.critical), ...(await check.run(d)) }; }
  catch (e) { return { id: check.id, title: check.title, critical: Boolean(check.critical), ok: false, detail: `The check itself failed: ${e.message}` }; }
}

/** Runs the checks; with `repair` it fixes every repairable problem and checks again. Result: { ok, results }. */
export async function runDoctor(d, { repair = false, only = null, quick = false } = {}) {
  const list = CHECKS.filter((c) => (!only || only.includes(c.id)) && (!quick || QUICK.has(c.id)));
  const results = [];
  for (const c of list) {
    let r = await runOne(c, d);
    if (!r.ok && repair && r.repairable && c.repair) {
      try {
        const msg = await c.repair(d, r);
        if (r.background) r = { ...r, ok: true, fixed: true, detail: msg };
        else { const again = await runOne(c, d); r = again.ok ? { ...again, fixed: true, detail: msg } : { ...again, detail: `${msg}, but it still isn't right: ${again.detail}` }; }
      } catch (e) { r = { ...r, repairError: e.message, detail: `${r.detail} (the repair failed: ${e.message})` }; }
    }
    results.push(r);
  }
  return { ok: results.every((r) => r.ok), results };
}

/** The one-line summary the console and the installers print. */
export function summarize({ ok, results }) {
  if (ok) return results.some((r) => r.fixed) ? "All checks passed (some things were repaired)" : "All checks passed";
  const bad = results.filter((r) => !r.ok);
  return `${bad.length} thing${bad.length === 1 ? "" : "s"} need${bad.length === 1 ? "s" : ""} attention: ${bad.map((r) => r.title).join(", ")}`;
}

/** Whether anything an install can't work without is still broken (decides the installer's exit code). */
export const hasCriticalFailure = ({ results }) => results.some((r) => !r.ok && r.critical);
