// Spot Solutions server console: a small local web UI on the server itself (port 7420).
// It solves the bootstrap problem (the worker can't reach Firebase until it has a key),
// and shows service health, machine stats and logs. No dependencies, plain Node.
//
// Env: SPOT_DATA_DIR, SPOT_ENV_FILE, SPOT_CONSOLE_PORT (7420), SPOT_CONSOLE_TOKEN_FILE
// Test hooks: SPOT_CONSOLE_DRY_RUN=1 never restarts or updates anything on the machine; SPOT_FUNCTIONS_URL, SPOT_DIST_URL,
// SPOT_WEB_URL and SPOT_GEMINI_URL point the console at stand-ins for Spot Solutions' servers.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync, chmodSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createConnect } from "./connect.mjs";
import { createUpdater } from "./update.mjs";
import { createAi } from "./ai.mjs";

const exec = promisify(execFile);
const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";
const MAC_ROOT = path.join(os.homedir(), "Library", "Application Support", "SpotSolutions");
const DATA = process.env.SPOT_DATA_DIR ?? (WIN ? "C:\\SpotSolutions\\data" : MAC ? path.join(MAC_ROOT, "data") : "/var/lib/spot-solutions");
const ENV_FILE = process.env.SPOT_ENV_FILE ?? (WIN ? "C:\\SpotSolutions\\app\\apps\\worker\\.env" : MAC ? path.join(MAC_ROOT, "app", "apps", "worker", ".env") : "/opt/spot-solutions/apps/worker/.env");
// Windows logs next to the data; macOS launch agents write to SpotSolutions/logs.
const WORKER_LOG = MAC ? path.join(DATA, "..", "logs", "worker.log") : path.join(DATA, "worker.log");
const OLLAMA_EXE = process.env.SPOT_OLLAMA_EXE ?? "ollama";
const PORT = Number(process.env.SPOT_CONSOLE_PORT ?? 7420);
// Release this console belongs to (written by the installer's tarball), shown in the header.
const VERSION = process.env.SPOT_VERSION ?? (() => { try { return readFileSync(new URL("../../../VERSION", import.meta.url), "utf8").trim(); } catch { return "dev"; } })();
// Changes on every start, so an embedded view (the Mac app) knows to reload a stale page.
const BOOT = Date.now();
const TOKEN_FILE = process.env.SPOT_CONSOLE_TOKEN_FILE ?? path.join(DATA, "console-token");
const KEY_FILE = path.join(DATA, "service-account.json");
// Cloud Function that trades a join code for this server's own key (functions/src/index.ts redeemJoinCode).
const JOIN_URL = process.env.SPOT_JOIN_URL ?? "https://asia-south1-spot-solutions.cloudfunctions.net/redeemJoinCode";
const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const HTML = readFileSync(new URL("./index.html", import.meta.url));
const FAVICON = readFileSync(new URL("./favicon.svg", import.meta.url));

if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, randomBytes(18).toString("base64url"), { mode: 0o600 });
// Lets the Windows "Open Server Console" shortcut and the installer print the remote link.
const TOKEN = readFileSync(TOKEN_FILE, "utf8").trim();

// ---------- .env helpers ----------
function readEnv() {
  if (!existsSync(ENV_FILE)) return {};
  return Object.fromEntries(
    readFileSync(ENV_FILE, "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
  );
}
function writeEnv(patch) {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split("\n") : [];
  const seen = new Set();
  const out = lines.map((l) => {
    const k = l.slice(0, l.indexOf("=")).trim();
    if (l.includes("=") && k in patch) {
      seen.add(k);
      return `${k}=${patch[k]}`;
    }
    return l;
  });
  for (const [k, v] of Object.entries(patch)) if (!seen.has(k)) out.push(`${k}=${v}`);
  writeFileSync(ENV_FILE, out.filter((l, i, a) => l !== "" || i < a.length - 1).join("\n") + "\n", { mode: 0o600 });
  if (!WIN) chmodSync(ENV_FILE, 0o600);
}

// ---------- system ----------
async function sh(cmd, args, timeout = 5000) {
  try {
    const { stdout } = await exec(cmd, args, { timeout, maxBuffer: 2 << 20 });
    return stdout.trim();
  } catch (e) {
    return (e.stdout ?? "").toString().trim() || null;
  }
}
const ps = (cmd, timeout) => sh("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], timeout);
// The Windows launcher runs the worker as `node ... tsx ... src\index.ts` from C:\SpotSolutions.
const WIN_WORKER = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*SpotSolutions*src*index.ts*' }";
// macOS: launch agents from spotctl, in this user's GUI domain.
const macLabel = (unit) => `com.spotsolutions.${unit === "spot-worker" ? "worker" : unit}`;
const gui = () => `gui/${process.getuid()}`;
async function isActive(unit) {
  if (MAC) {
    const out = await sh("launchctl", ["print", `${gui()}/${macLabel(unit)}`]);
    if (out?.includes("state = running")) return true;
    return unit === "ollama" ? (await ollama()).up : false; // Ollama may be the user's own install
  }
  if (!WIN) return (await sh("systemctl", ["is-active", unit])) === "active";
  if (unit === "ollama") return (await ollama()).up;
  return Boolean(await ps(`(${WIN_WORKER} | Measure-Object).Count -gt 0 | % { if ($_) { 'yes' } }`));
}
const DRY = process.env.SPOT_CONSOLE_DRY_RUN === "1";
async function restart(unit) {
  if (DRY) return null;
  if (MAC) return sh("launchctl", ["kickstart", "-k", `${gui()}/${macLabel(unit)}`], 30000);
  if (!WIN) return sh("sudo", ["-n", "/usr/bin/systemctl", "restart", unit], 30000);
  if (unit === "ollama") {
    return ps(`Get-Process ollama -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 2; Start-Process -FilePath '${OLLAMA_EXE}' -ArgumentList serve -WindowStyle Hidden`, 30000);
  }
  // The launcher loop starts the worker again within ~10 s.
  return ps(`${WIN_WORKER} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`, 30000);
}
function tailFile(file, bytes = 24000) {
  if (!existsSync(file)) return null;
  const size = statSync(file).size;
  const fd = openSync(file, "r");
  const buf = Buffer.alloc(Math.min(bytes, size));
  readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
  closeSync(fd);
  return buf.toString("utf8").split(/\r?\n/).slice(-150).join("\n");
}
async function workerLogs() {
  return WIN || MAC ? tailFile(WORKER_LOG) : sh("journalctl", ["-u", "spot-worker", "-n", "150", "--no-pager", "-o", "short-iso"], 8000);
}
async function disk() {
  if (WIN) {
    const out = await ps("$d = Get-PSDrive C; \"$($d.Used + $d.Free) $($d.Free)\"");
    if (!out) return null;
    const [total, free] = out.split(" ").map(Number);
    return { total, free };
  }
  const out = await sh("df", ["-k", "/"]);
  if (!out) return null;
  const c = out.split("\n").pop().split(/\s+/);
  return { total: Number(c[1]) * 1024, free: Number(c[3]) * 1024 };
}
let prev = os.cpus().map((c) => c.times);
function cpu() {
  const now = os.cpus().map((c) => c.times);
  let idle = 0, total = 0;
  now.forEach((t, i) => {
    const p = prev[i] ?? t;
    idle += t.idle - p.idle;
    total += t.user - p.user + t.nice - p.nice + t.sys - p.sys + t.idle - p.idle + t.irq - p.irq;
  });
  prev = now;
  return total ? 1 - idle / total : 0;
}
function lanIps() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
}
// Gemini-only servers (SPOT_NO_LOCAL_MODEL=1 in .env) have no Ollama: don't probe, don't flag it as down.
const noLocalModel = () => /^(1|true|yes)$/i.test(readEnv().SPOT_NO_LOCAL_MODEL ?? "");
async function ollama() {
  if (noLocalModel()) return { up: false, models: [] };
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2500) });
    const j = await r.json();
    return { up: true, models: j.models.map((m) => ({ name: m.name, size: m.size })) };
  } catch {
    return { up: false, models: [] };
  }
}
function keyInfo() {
  if (!existsSync(KEY_FILE)) return null;
  try {
    const k = JSON.parse(readFileSync(KEY_FILE, "utf8"));
    return { projectId: k.project_id, clientEmail: k.client_email, addedAt: statSync(KEY_FILE).mtimeMs };
  } catch {
    return { projectId: null, invalid: true };
  }
}

/** Memory that's actually available. os.freemem() counts file cache as used on macOS and Linux, so it reads ~100%. */
async function memory() {
  const total = os.totalmem();
  try {
    if (MAC) {
      const { stdout } = await exec("vm_stat");
      const page = Number(/page size of (\d+)/.exec(stdout)?.[1] ?? 4096);
      const pages = (name) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(stdout)?.[1] ?? 0);
      return { total, free: Math.min(total, (pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * page) };
    }
    if (!WIN) {
      const kb = Number(/MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1] ?? NaN);
      if (Number.isFinite(kb)) return { total, free: kb * 1024 };
    }
  } catch {}
  return { total, free: os.freemem() };
}

async function status() {
  const env = readEnv();
  const [worker, ollamaSvc, o, d, logs] = await Promise.all([
    isActive("spot-worker"),
    noLocalModel() ? false : isActive("ollama"),
    ollama(),
    disk(),
    workerLogs(),
  ]);
  const gk = env.GEMINI_API_KEY ?? "";
  return {
    version: VERSION,
    boot: BOOT,
    update: updater.view(),
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()}`,
    distro: WIN ? (await ps("(Get-CimInstance Win32_OperatingSystem).Caption")) : (existsSync("/etc/os-release") && readFileSync("/etc/os-release", "utf8").match(/PRETTY_NAME="([^"]+)"/)?.[1]) || null,
    platform: process.platform,
    arch: os.arch(),
    uptime: os.uptime(),
    ips: lanIps(),
    cpu: { model: os.cpus()[0]?.model?.trim(), cores: os.cpus().length, usage: cpu(), load: os.loadavg() },
    memory: await memory(),
    disk: d,
    services: { worker, ollama: ollamaSvc },
    localModel: !noLocalModel(),
    ollama: o,
    config: {
      key: keyInfo(),
      admins: (env.SPOT_ADMIN_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      geminiServerKey: gk ? `••••${gk.slice(-4)}` : null,
      serverId: env.SPOT_SERVER_ID || os.hostname(),
    },
    logs: logs ?? (WIN ? "No logs yet. The worker starts once a Firebase key is added." : "No logs yet (or this account can't read the journal)."),
  };
}

// ---------- http ----------
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const body = (req) =>
  new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
      if (s.length > 1 << 20) reject(new Error("too large"));
    });
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
const isServiceAccountKey = (k) => Boolean(k && k.type === "service_account" && k.project_id && k.private_key);
// One way to store a key, whether it was dropped as a file or came from a join code, then restart the worker.
async function installKey(k) {
  writeFileSync(KEY_FILE, JSON.stringify(k, null, 2), { mode: 0o600 });
  writeEnv({ FIREBASE_SERVICE_ACCOUNT: KEY_FILE, FIREBASE_PROJECT_ID: k.project_id });
  await restart("spot-worker");
}

// ---------- connect with an account, updates, AI models ----------
const addAdmin = (email) => {
  const e = String(email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return;
  const have = (readEnv().SPOT_ADMIN_EMAILS ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!have.includes(e)) writeEnv({ SPOT_ADMIN_EMAILS: [...have, e].join(",") });
};
const connect = createConnect({
  hostname: os.hostname(),
  // The signed-in admin who approved this server becomes one of its admins, so it shows in their Server page at once.
  onApproved: async ({ key, approvedBy }) => { addAdmin(approvedBy); await installKey(key); },
});
const updater = createUpdater({ version: VERSION, data: DATA, hostname: os.hostname(), platform: process.platform, uid: process.getuid?.(), macRoot: MAC_ROOT, dryRun: DRY });
updater.begin();
void updater.check(); // so the page can say right away whether a newer release exists
const ai = createAi({
  readEnv,
  writeEnv,
  restartWorker: () => restart("spot-worker"),
  ollamaUrl: OLLAMA,
  ollamaInfo: ollama,
  noLocalModel,
});

const isLocal = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
function authed(req) {
  if (isLocal(req)) return true;
  const cookie = /(?:^|;\s*)spot_console=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
  const a = Buffer.from(cookie), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// qrcode-terminal ships with the worker; the console stays usable without it.
function qrText(text) {
  try {
    let out = null;
    createRequire(import.meta.url)("qrcode-terminal").generate(text, { small: true }, (q) => (out = q));
    return out;
  } catch {
    return null;
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    // First visit with ?token=… sets a cookie, then the token leaves the URL.
    if (url.searchParams.get("token") === TOKEN) {
      res.writeHead(302, { "set-cookie": `spot_console=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, location: "/" });
      return res.end();
    }
    if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" });
      return res.end(FAVICON);
    }
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(HTML);
    }
    if (!url.pathname.startsWith("/api/")) return json(res, 404, { error: "Not found" });
    if (!authed(req)) return json(res, 401, { error: "Open the link with ?token=… printed by the installer (sudo cat " + TOKEN_FILE + ")" });

    if (url.pathname === "/api/status") return json(res, 200, await status());
    if (url.pathname === "/api/boot") return json(res, 200, { boot: BOOT });

    // Only for someone at this machine: the link carries the access token.
    if (url.pathname === "/api/phone") {
      if (!isLocal(req)) return json(res, 403, { error: "Only shown on the server itself" });
      const ip = lanIps()[0];
      if (!ip) return json(res, 200, { url: null, qr: null });
      const link = `http://${ip}:${PORT}/?token=${TOKEN}`;
      return json(res, 200, { url: link, qr: qrText(link) });
    }

    // Connect with a Spot Solutions account: a one-time link an admin approves in the web app (connect.mjs).
    if (url.pathname === "/api/connect" && req.method === "GET") return json(res, 200, connect.state());
    if (url.pathname === "/api/connect/start" && req.method === "POST") {
      const b = await body(req);
      return json(res, 200, await connect.start(b.deviceName));
    }
    if (url.pathname === "/api/connect/cancel" && req.method === "POST") {
      connect.cancel();
      return json(res, 200, { ok: true });
    }

    // Updates (update.mjs). The worker calls POST /api/update from this machine when the app's Update button is pressed.
    if (url.pathname === "/api/update" && req.method === "GET") return json(res, 200, updater.view());
    if (url.pathname === "/api/update/check" && req.method === "POST") {
      await updater.check();
      return json(res, 200, updater.view());
    }
    if (url.pathname === "/api/update/auto" && req.method === "POST") {
      updater.setAuto((await body(req)).on);
      return json(res, 200, updater.view());
    }
    if (url.pathname === "/api/update" && req.method === "POST") {
      const b = await body(req);
      await updater.check();
      const v = updater.view();
      if (!v.latest) return json(res, 502, { error: "Couldn't reach Spot Solutions to look for an update. Check this server's internet." });
      if (!v.available && !b.force) return json(res, 200, { ok: true, upToDate: true, to: v.current });
      const r = await updater.start({ by: String(b.by ?? "console").slice(0, 80) });
      return json(res, 200, { ...r, to: v.latest?.version ?? null });
    }

    // AI models: the server's Gemini key, model choice, tests, local models, default routing (ai.mjs).
    if (url.pathname === "/api/ai" && req.method === "GET") return json(res, 200, await ai.view());
    if (url.pathname.startsWith("/api/ai/") && req.method === "POST") {
      const b = await body(req);
      const act = url.pathname.slice("/api/ai/".length);
      try {
        if (act === "key") { await ai.setKey(typeof b.key === "string" ? b.key.trim() : ""); return json(res, 200, { ok: true }); }
        if (act === "models") return json(res, 200, { models: await ai.listModels(b.key) });
        if (act === "test") return json(res, 200, await ai.test({ provider: b.provider, model: b.model, key: b.key }));
        if (act === "pull") { await ai.startPull(String(b.model ?? "").trim()); return json(res, 200, { ok: true }); }
        if (act === "defaults") { await ai.setDefaults(b); return json(res, 200, { ok: true }); }
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    // Turn the local model on or off on this computer (installs or stops Ollama; the platform's helper does it).
    if (url.pathname === "/api/local" && req.method === "POST") {
      const b = await body(req);
      if (Boolean(b.enabled) === !noLocalModel()) return json(res, 200, { ok: true, unchanged: true });
      await updater.start({ by: "console", task: b.enabled ? "local-on" : "local-off" });
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/api/key" && req.method === "POST") {
      const k = await body(req);
      if (!isServiceAccountKey(k)) return json(res, 400, { error: "That isn't a Firebase service-account key." });
      await installKey(k);
      return json(res, 200, { ok: true, projectId: k.project_id });
    }

    // Join with a code from the app (Account, Server, Add a server): the function makes this device's own key.
    if (url.pathname === "/api/join" && req.method === "POST") {
      const b = await body(req);
      const code = String(b.code ?? "").trim();
      if (!code) return json(res, 400, { error: "Enter the join code." });
      const deviceName = String(b.deviceName ?? "").trim() || os.hostname();
      let r, out;
      try {
        r = await fetch(JOIN_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, deviceName }),
          signal: AbortSignal.timeout(90_000),
        });
        out = await r.json().catch(() => ({}));
      } catch {
        return json(res, 502, { error: "Couldn't reach Spot Solutions. Check this server's internet and try again." });
      }
      if (!r.ok) return json(res, r.status === 429 ? 429 : 400, { error: out.error || "That code didn't work." });
      if (!isServiceAccountKey(out.key)) return json(res, 502, { error: "Spot Solutions sent back something that isn't a key." });
      await installKey(out.key);
      return json(res, 200, { ok: true, projectId: out.key.project_id, serviceAccount: out.serviceAccount });
    }

    if (url.pathname === "/api/config" && req.method === "POST") {
      const b = await body(req);
      const patch = {};
      if (Array.isArray(b.admins)) {
        const emails = b.admins.map((e) => String(e).trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
        patch.SPOT_ADMIN_EMAILS = emails.join(",");
      }
      if (typeof b.geminiKey === "string") patch.GEMINI_API_KEY = b.geminiKey.trim();
      if (!Object.keys(patch).length) return json(res, 400, { error: "Nothing to change" });
      writeEnv(patch);
      await restart("spot-worker");
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/api/restart" && req.method === "POST") {
      const { service } = await body(req);
      if (service === "ollama" && noLocalModel()) return json(res, 400, { error: "This server runs without a local model (Gemini only)." });
      const unit = service === "ollama" ? "ollama" : "spot-worker";
      await restart(unit);
      return json(res, 200, { ok: true, active: await isActive(unit) });
    }

    json(res, 404, { error: "Not found" });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`[console] http://${lanIps()[0] ?? "localhost"}:${PORT}/?token=${TOKEN}`);
});
