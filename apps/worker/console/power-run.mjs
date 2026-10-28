// The real machine behind power.mjs. Used two ways:
//   node power-run.mjs --apply [--json]   from install.ps1 / update-core.ps1: puts the chosen "stay on" settings (data/power.json) in force
//   node power-run.mjs --check [--json]   prints what is set
//   createMachinePower({...})              from the console (server.mjs)
// Always exits 0: a power setting that won't apply must never stop an install or an update.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPower, createKeepAwake } from "./power.mjs";
import { machinePaths } from "./doctor-run.mjs";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

export function createMachinePower({ env = process.env, dry = false, withKeepAwake = false, log = console.log } = {}) {
  const platform = process.platform;
  const paths = machinePaths(env);
  const keepAwake = createKeepAwake({
    platform, log,
    spawn: (cmd, args) => spawn(cmd, args, { stdio: "ignore", windowsHide: true }),
    enabled: () => !dry && withKeepAwake && power.state().keepAwake,
  });
  const power = createPower({
    platform, dry, keepAwake, dataDir: paths.dataDir, home: os.homedir(),
    macRoot: path.join(os.homedir(), "Library", "Application Support", "NothingBotServer"),
    nbsctl: path.join(paths.appDir, "deploy", "mac", "nbsctl"),
    run: async (cmd, args, { timeout = 15000 } = {}) => {
      try { return { ok: true, out: (await exec(cmd, args, { timeout, maxBuffer: 4 << 20, windowsHide: true })).stdout.trim() }; }
      catch (e) { return { ok: false, out: ((e.stdout ?? "").toString() || (e.stderr ?? "").toString()).trim() }; }
    },
    readText: (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
    writeText: (p, t) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, t); },
    listDir: (p) => readdirSync(p),
    exists: (p) => existsSync(p),
    uptime: () => os.uptime(),
  });
  return { power, keepAwake };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const { power } = createMachinePower();
  try {
    const r = args.includes("--apply") ? await power.applyAll({ force: true }) : { view: await power.view(), results: [] };
    if (json) console.log(JSON.stringify(r));
    else {
      for (const x of r.results) console.log(`${x.ok ? "ok  " : "FAIL"} ${x.id}${x.error ? ": " + x.error : ""}`);
      for (const i of r.view.items) console.log(`${i.ok ? "[x]" : "[ ]"} ${i.title}: ${i.detail}`);
      console.log(r.view.summary.text);
    }
  } catch (e) { console.error(`[power] ${e.message}`); }
}
