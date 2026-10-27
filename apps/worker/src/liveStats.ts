// Live numbers for this server's local console (apps/worker/console) and a compact summary for the heartbeat.
// The worker and the console are separate processes, so the worker writes one small JSON file every few seconds
// (atomically: temp file, then rename) and the console reads it. Nothing in it is message text, and phone numbers
// are masked before they get here. Per-hour buckets live in the file too, so a restart doesn't zero the 24 h chart.
//
// Accounts are keyed by `${uid}:${role}`: today every account has one "client" session (the curator's own WhatsApp);
// an "agent" session per account can be added later by passing role "agent" to recordSession / bindClient.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type SessionRole = "client" | "agent";
export const STATS_VERSION = 1;
const HOUR = 3600_000;
const KEEP_HOURS = 25; // the current hour plus the 24 before it
const WRITE_EVERY_MS = 3000;

/** One hour of activity. `ai` counts successful model calls; `aiFail` every failed attempt; `aiFallback` successes that needed a second route. */
export interface Bucket {
  h: number; // start of the hour, epoch ms
  in: number;
  spot: number;
  sent: number;
  err: number;
  ai: number;
  aiLocal: number;
  aiGemini: number;
  aiMs: number; // summed latency of the successful calls
  aiFail: number;
  aiFallback: number;
}
type Totals = Omit<Bucket, "h">;
export interface AccountStat {
  key: string;
  uid: string;
  role: SessionRole;
  status: string;
  /** WhatsApp page health (health.ts): "ok", "unresponsive" or "failing"; note says why. */
  health?: string;
  healthNote?: string | null;
  /** When the status last changed. */
  since: number;
  /** Masked, e.g. "+91 98•••12". */
  phone: string | null;
  name: string | null;
  email: string | null;
  in: number;
  spot: number;
  sent: number;
  err: number;
}
export interface LiveStats {
  v: number;
  server: { id: string; hostname: string };
  version: string;
  pid: number;
  startedAt: number;
  writtenAt: number;
  /** Oldest first, one entry per hour that had activity, at most the last 25 hours. */
  hourly: Bucket[];
  /** Since this worker process started. */
  totals: Totals;
  accounts: AccountStat[];
  queue: { pending: number; lastSendAt: number | null };
}

const emptyTotals = (): Totals => ({ in: 0, spot: 0, sent: 0, err: 0, ai: 0, aiLocal: 0, aiGemini: 0, aiMs: 0, aiFail: 0, aiFallback: 0 });

/** "919812345612" -> "+91 98•••12". Country-code length is a best guess; it only shapes the mask. */
export function maskPhone(raw: string | null | undefined): string | null {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.length < 7) return d ? "•••" : null;
  const three = /^(21|22|23|24|25|26|29|35|37|38|42|50|59|67|68|69|80|85|87|88|97|99)/.test(d);
  const cc = d[0] === "1" || d[0] === "7" ? 1 : three ? 3 : 2;
  const rest = d.slice(cc);
  return `+${d.slice(0, cc)} ${rest.slice(0, 2)}•••${rest.slice(-2)}`;
}

const hourOf = (t: number) => Math.floor(t / HOUR) * HOUR;

/** Reads a previous file's hourly buckets (only those still inside the window); anything unreadable is ignored. */
export function loadHourly(file: string, now = Date.now()): Bucket[] {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as Partial<LiveStats>;
    if (j.v !== STATS_VERSION || !Array.isArray(j.hourly)) return [];
    const base = emptyTotals();
    return j.hourly
      .filter((b) => b && typeof b.h === "number" && b.h > now - KEEP_HOURS * HOUR && b.h <= now)
      .map((b) => ({ ...base, ...Object.fromEntries(Object.entries(b).filter(([, v]) => typeof v === "number")), h: hourOf(b.h) }) as Bucket);
  } catch {
    return [];
  }
}

export interface LiveOptions {
  file: string;
  serverId: string;
  version: string;
  startedAt?: number;
  now?: () => number;
}

export function createLiveStats(opts: LiveOptions) {
  const now = opts.now ?? Date.now;
  const startedAt = opts.startedAt ?? now();
  let hourly = loadHourly(opts.file, now());
  const totals = emptyTotals();
  const accounts = new Map<string, AccountStat>();
  const directory = new Map<string, { name?: string | null; email?: string | null }>();
  let directorySeen = false;
  const clients = new WeakMap<object, string>();
  let pending = 0;
  let lastSendAt: number | null = null;
  let dirty = true;
  let timer: NodeJS.Timeout | null = null;

  const bucket = (): Bucket => {
    const h = hourOf(now());
    let b = hourly[hourly.length - 1];
    if (!b || b.h !== h) {
      b = { h, ...emptyTotals() };
      hourly.push(b);
      hourly = hourly.filter((x) => x.h > h - KEEP_HOURS * HOUR);
    }
    return b;
  };
  const keyOf = (uid: string, role: SessionRole = "client") => `${uid}:${role}`;
  const account = (uid: string, role: SessionRole = "client"): AccountStat => {
    const key = keyOf(uid, role);
    let a = accounts.get(key);
    if (!a) {
      a = { key, uid, role, status: "starting", since: now(), phone: null, name: null, email: null, in: 0, spot: 0, sent: 0, err: 0 };
      accounts.set(key, a);
    }
    return a;
  };
  const bump = (f: keyof Totals, by = 1, uid?: string | null, role?: SessionRole) => {
    totals[f] += by;
    bucket()[f] += by;
    if (uid && (f === "in" || f === "spot" || f === "sent" || f === "err")) account(uid, role)[f] += by;
    dirty = true;
  };

  const api = {
    /** A session changed state (status and linked number come from sessions.ts's setState). */
    recordSession(uid: string, s: { status?: string; phone?: string | null; health?: string; error?: string | null }, role: SessionRole = "client") {
      const a = account(uid, role);
      if (s.health !== undefined) {
        a.health = s.health;
        a.healthNote = s.health === "ok" ? null : (s.error ?? null);
      }
      if (s.status && s.status !== a.status) {
        a.status = s.status;
        a.since = now();
      }
      if (s.phone !== undefined) a.phone = maskPhone(s.phone);
      dirty = true;
    },
    /** Names and emails, and which accounts this server still holds (from the 30 s heartbeat). Others drop off the list. */
    setDirectory(list: { uid: string; email?: string | null; name?: string | null }[]) {
      directory.clear();
      for (const d of list) directory.set(d.uid, { name: d.name ?? null, email: d.email ?? null });
      directorySeen = true;
      // A session that just started may not be in this list yet: only drop ones that have sat unlisted for a while.
      for (const [k, a] of accounts) if (!directory.has(a.uid) && a.since < now() - 45_000) accounts.delete(k);
      dirty = true;
    },
    /** Lets a send (which only knows the WhatsApp client) be credited to its account. */
    bindClient(uid: string, client: object, role: SessionRole = "client") {
      clients.set(client, keyOf(uid, role));
    },
    noteIn(uid: string) {
      bump("in", 1, uid);
    },
    noteSpot(uid: string) {
      bump("spot", 1, uid);
    },
    noteSent(client?: object) {
      lastSendAt = now();
      const key = client ? clients.get(client) : undefined;
      const a = key ? accounts.get(key) : undefined;
      bump("sent", 1, a?.uid, a?.role);
    },
    noteError(client?: object) {
      const key = client ? clients.get(client) : undefined;
      const a = key ? accounts.get(key) : undefined;
      bump("err", 1, a?.uid, a?.role);
    },
    /** A successful model call. `fellBack`: the first route failed and a later one answered. */
    noteAi(provider: "ollama" | "gemini", ms: number, fellBack = false) {
      bump("ai");
      bump(provider === "gemini" ? "aiGemini" : "aiLocal");
      bump("aiMs", Math.max(0, Math.round(ms)));
      if (fellBack) bump("aiFallback");
    },
    /** One failed model attempt (a route that threw). */
    noteAiFail() {
      bump("aiFail");
    },
    queueDelta(n: number) {
      pending = Math.max(0, pending + n);
      dirty = true;
    },
    snapshot(extra: { hostname?: string } = {}): LiveStats {
      bucket();
      return {
        v: STATS_VERSION,
        server: { id: opts.serverId, hostname: extra.hostname ?? os.hostname() },
        version: opts.version,
        pid: process.pid,
        startedAt,
        writtenAt: now(),
        hourly: hourly.map((b) => ({ ...b })),
        totals: { ...totals },
        accounts: [...accounts.values()]
          .map((a) => ({ ...a, name: directory.get(a.uid)?.name ?? a.name, email: directory.get(a.uid)?.email ?? a.email }))
          .sort((x, y) => x.key.localeCompare(y.key)),
        queue: { pending, lastSendAt },
      };
    },
    /** Compact numbers for the Firestore heartbeat (no extra write: it rides on the existing one). */
    summary() {
      const since = now() - 24 * HOUR;
      const sum = (f: keyof Totals) => hourly.filter((b) => b.h + HOUR > since).reduce((n, b) => n + b[f], 0);
      const held = [...accounts.values()];
      return {
        accounts: held.length,
        ready: held.filter((a) => a.status === "ready").length,
        in24h: sum("in"),
        spot24h: sum("spot"),
        sent24h: sum("sent"),
        err24h: sum("err"),
        queue: pending,
      };
    },
    /** Atomic write: a reader sees the old file or the new one, never half of one. */
    write() {
      const body = JSON.stringify(api.snapshot());
      const tmp = `${opts.file}.${process.pid}.tmp`;
      try {
        mkdirSync(path.dirname(opts.file), { recursive: true });
        writeFileSync(tmp, body);
        try {
          renameSync(tmp, opts.file);
        } catch {
          writeFileSync(opts.file, body); // Windows can refuse a rename over a file a reader has open
        }
        dirty = false;
      } catch (e) {
        console.warn("[live-stats] couldn't write", opts.file, (e as Error).message);
      }
    },
    start() {
      if (timer) return;
      api.write();
      timer = setInterval(() => api.write(), WRITE_EVERY_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    get dirty() {
      return dirty;
    },
    get directorySeen() {
      return directorySeen;
    },
  };
  return api;
}
