// Spot Solutions server console: a small local web UI on the server itself (port 7420).
// It solves the bootstrap problem (the worker can't reach Firebase until it has a key),
// and shows service health, machine stats and logs. No dependencies, plain Node.
//
// Env: SPOT_DATA_DIR, SPOT_ENV_FILE, SPOT_CONSOLE_PORT (7420), SPOT_CONSOLE_TOKEN_FILE
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);
const DATA = process.env.SPOT_DATA_DIR ?? "/var/lib/spot-solutions";
const ENV_FILE = process.env.SPOT_ENV_FILE ?? "/opt/spot-solutions/apps/worker/.env";
const PORT = Number(process.env.SPOT_CONSOLE_PORT ?? 7420);
const TOKEN_FILE = process.env.SPOT_CONSOLE_TOKEN_FILE ?? path.join(DATA, "console-token");
const KEY_FILE = path.join(DATA, "service-account.json");
const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const HTML = readFileSync(new URL("./index.html", import.meta.url));

if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, randomBytes(18).toString("base64url"), { mode: 0o600 });
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
  chmodSync(ENV_FILE, 0o600);
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
const isActive = async (unit) => (await sh("systemctl", ["is-active", unit])) === "active";
async function disk() {
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
async function ollama() {
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

async function status() {
  const env = readEnv();
  const [worker, ollamaSvc, o, d, logs] = await Promise.all([
    isActive("spot-worker"),
    isActive("ollama"),
    ollama(),
    disk(),
    sh("journalctl", ["-u", "spot-worker", "-n", "150", "--no-pager", "-o", "short-iso"], 8000),
  ]);
  const gk = env.GEMINI_API_KEY ?? "";
  return {
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()}`,
    distro: (existsSync("/etc/os-release") && readFileSync("/etc/os-release", "utf8").match(/PRETTY_NAME="([^"]+)"/)?.[1]) || null,
    arch: os.arch(),
    uptime: os.uptime(),
    ips: lanIps(),
    cpu: { model: os.cpus()[0]?.model?.trim(), cores: os.cpus().length, usage: cpu(), load: os.loadavg() },
    memory: { total: os.totalmem(), free: os.freemem() },
    disk: d,
    services: { worker, ollama: ollamaSvc },
    ollama: o,
    config: {
      key: keyInfo(),
      admins: (env.SPOT_ADMIN_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      geminiServerKey: gk ? `••••${gk.slice(-4)}` : null,
      serverId: env.SPOT_SERVER_ID || os.hostname(),
    },
    logs: logs ?? "No logs yet (or this account can't read the journal).",
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
function authed(req) {
  const cookie = /(?:^|;\s*)spot_console=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
  const a = Buffer.from(cookie), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
const restart = (unit) => sh("sudo", ["-n", "/usr/bin/systemctl", "restart", unit], 30000);

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    // First visit with ?token=… sets a cookie, then the token leaves the URL.
    if (url.searchParams.get("token") === TOKEN) {
      res.writeHead(302, { "set-cookie": `spot_console=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, location: "/" });
      return res.end();
    }
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(HTML);
    }
    if (!url.pathname.startsWith("/api/")) return json(res, 404, { error: "Not found" });
    if (!authed(req)) return json(res, 401, { error: "Open the link with ?token=… printed by the installer (sudo cat " + TOKEN_FILE + ")" });

    if (url.pathname === "/api/status") return json(res, 200, await status());

    if (url.pathname === "/api/key" && req.method === "POST") {
      const k = await body(req);
      if (k.type !== "service_account" || !k.project_id || !k.private_key) return json(res, 400, { error: "That isn't a Firebase service-account key." });
      writeFileSync(KEY_FILE, JSON.stringify(k, null, 2), { mode: 0o600 });
      writeEnv({ FIREBASE_SERVICE_ACCOUNT: KEY_FILE, FIREBASE_PROJECT_ID: k.project_id });
      await restart("spot-worker");
      return json(res, 200, { ok: true, projectId: k.project_id });
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
