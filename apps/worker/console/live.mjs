// Live stats for the console's dashboard. The worker (src/liveStats.ts) writes a small JSON file every few seconds;
// this reads it, checks it, and shapes it for the page (24 fixed hourly slots, sums, shares). It never holds message
// text, and anything that looks like a full phone number is masked again here, whatever the file says.
import { readFileSync, statSync } from "node:fs";

const HOUR = 3600_000;
const STALE_MS = 15_000; // the worker writes every 3 s; this long without a write means it isn't running
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const str = (v, max = 120) => (typeof v === "string" ? v.slice(0, max) : null);
const FIELDS = ["in", "spot", "sent", "err", "ai", "aiLocal", "aiGemini", "aiMs", "aiFail", "aiFallback"];

/** Keeps a masked number, masks a raw one, drops anything else. */
export function safePhone(p) {
  if (typeof p !== "string" || !p) return null;
  if (p.includes("•")) return /^[+\d •\s]{3,24}$/.test(p) ? p : null;
  const d = p.replace(/\D/g, "");
  return d.length >= 7 ? `+${d.slice(0, 2)} ${d.slice(2, 4)}•••${d.slice(-2)}` : null;
}

/** Turns the worker's file contents into what the page draws. `now` is injectable for tests. */
export function shape(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object" || raw.v !== 1) return null;
  const end = Math.floor(now / HOUR) * HOUR;
  const byHour = new Map((Array.isArray(raw.hourly) ? raw.hourly : []).filter((b) => b && typeof b.h === "number").map((b) => [Math.floor(b.h / HOUR) * HOUR, b]));
  const series = Array.from({ length: 24 }, (_, i) => {
    const h = end - (23 - i) * HOUR;
    const b = byHour.get(h) ?? {};
    return { h, ...Object.fromEntries(FIELDS.map((f) => [f, num(b[f])])) };
  });
  const sum = (f) => series.reduce((n, b) => n + b[f], 0);
  const t = raw.totals ?? {};
  const totals = Object.fromEntries(FIELDS.map((f) => [f, num(t[f])]));
  const accounts = (Array.isArray(raw.accounts) ? raw.accounts : []).slice(0, 500).map((a) => ({
    key: str(a.key, 160),
    role: a.role === "agent" ? "agent" : "client",
    status: str(a.status, 20) ?? "unknown",
    since: num(a.since) || null,
    phone: safePhone(a.phone),
    name: str(a.name),
    email: str(a.email),
    in: num(a.in), spot: num(a.spot), sent: num(a.sent), err: num(a.err),
  }));
  const count = (st) => accounts.filter((a) => a.status === st).length;
  const ai24 = sum("ai");
  const writtenAt = num(raw.writtenAt);
  return {
    state: now - writtenAt > STALE_MS ? "stale" : "live",
    ageMs: Math.max(0, now - writtenAt),
    server: { id: str(raw.server?.id, 80), hostname: str(raw.server?.hostname, 80) },
    version: str(raw.version, 40),
    startedAt: num(raw.startedAt) || null,
    uptimeMs: raw.startedAt ? Math.max(0, writtenAt - num(raw.startedAt)) : null,
    accounts,
    counts: { accounts: accounts.length, ready: count("ready"), qr: count("qr"), starting: count("starting") + count("authenticated"), disconnected: count("disconnected") + count("error") },
    series,
    day: { in: sum("in"), spot: sum("spot"), sent: sum("sent"), err: sum("err") },
    totals,
    ai: {
      day: ai24,
      local: sum("aiLocal"),
      gemini: sum("aiGemini"),
      avgMs: ai24 ? Math.round(sum("aiMs") / ai24) : null,
      fail: sum("aiFail"),
      fallback: sum("aiFallback"),
      total: totals.ai,
      avgMsAll: totals.ai ? Math.round(totals.aiMs / totals.ai) : null,
      failAll: totals.aiFail,
      fallbackAll: totals.aiFallback,
    },
    queue: { pending: num(raw.queue?.pending), lastSendAt: num(raw.queue?.lastSendAt) || null },
  };
}

export function createLive({ file, now = Date.now }) {
  let mtime = 0, size = -1, cached = null;
  /** Re-reads only when the file changed; a half-written or missing file keeps the last good copy. */
  function view() {
    try {
      const st = statSync(file);
      if (st.mtimeMs !== mtime || st.size !== size) {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        cached = raw;
        mtime = st.mtimeMs; size = st.size;
      }
    } catch (e) {
      if (e?.code === "ENOENT") cached = null;
    }
    return shape(cached, now());
  }
  return { view };
}
