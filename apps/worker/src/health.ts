// WhatsApp health watchdog. A WhatsApp Web page can wedge (memory pressure, a hung tab) while the worker's heartbeat and the
// session state keep saying "ready": nothing comes in, nothing goes out, and nobody is told. This probes the page on a timer and
// after any protocol-level failure; if it stays dead it says so in the app, restarts the client with its saved login (no QR),
// backs off, and after repeated failures gives the account up so another server can take it. Decisions only: the effects
// (probe, restart, state, notice) come in through `deps`, so tests use fakes. sessions.ts wires the real ones.

export type WaHealth = "ok" | "unresponsive" | "failing";

export interface WatchdogDeps {
  /** Rejects when the page doesn't answer (the cheap `evaluate(() => 1)`). */
  probe: () => Promise<unknown>;
  /** Stop the client and start it again after `delayMs`. */
  restart: (delayMs: number) => Promise<void>;
  setHealth: (h: WaHealth, note: string | null) => void;
  /** `key` lets the caller dedupe repeated notices. */
  notify: (key: string, level: "info" | "warn", text: string) => void;
  /** Called once when restarts keep failing: release the account so another server can run it. */
  giveUp?: () => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  serverName: string;
}

export const PROBE_TIMEOUT_MS = 15_000;
export const PROBE_EVERY_MS = 60_000;
export const CONFIRM_DELAY_MS = 8_000;
export const MAX_RESTARTS = 3;
/** Restart delays: 5 s, 30 s, 2 min. */
export const RESTART_BACKOFF_MS = [5_000, 30_000, 120_000];
/** A session must answer for this long before its restart count is forgotten (a flapping page keeps counting). */
export const STABLE_MS = 10 * 60_000;

/** Errors that mean the browser page (not the request) is the problem. */
export const isWedgeError = (e: unknown) => /ProtocolError|TargetCloseError|Target closed|Session closed|Runtime\.callFunctionOn timed out|Waiting failed|Execution context was destroyed|Navigating frame was detached|detached Frame/i.test(`${(e as Error)?.name ?? ""} ${(e as Error)?.message ?? e}`);

export class WaWatchdog {
  health: WaHealth = "ok";
  restarts = 0;
  private busy = false;
  private healthySince: number | null = null;
  private gaveUp = false;
  private gaveUpAt = 0;
  constructor(private d: WatchdogDeps) {}

  private async probeOnce() {
    let t: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.d.probe(), new Promise((_, rej) => (t = setTimeout(() => rej(new Error("no answer from the WhatsApp page")), PROBE_TIMEOUT_MS)))]);
      return null;
    } catch (e) {
      return (e as Error).message || String(e);
    } finally {
      clearTimeout(t);
    }
  }

  /** After a give-up, a fresh start (the account came back minutes later) gets a clean slate. */
  resetIfStale(now: number) {
    if (this.gaveUp && now - this.gaveUpAt > 10 * 60_000) {
      this.gaveUp = false;
      this.restarts = 0;
      this.health = "ok";
    }
  }

  /** One check. `trigger` is the error that prompted it, if any. Returns what it found. */
  async check(trigger?: unknown): Promise<"ok" | "restarted" | "gave-up" | "busy"> {
    if (this.busy || this.gaveUp) return "busy";
    this.busy = true;
    try {
      let err = await this.probeOnce();
      if (!err) {
        const t = this.d.now();
        this.healthySince ??= t;
        if (this.health !== "ok") {
          this.health = "ok";
          this.d.setHealth("ok", null);
          this.d.notify("recovered", "info", `WhatsApp on ${this.d.serverName} is responding again.`);
        }
        if (t - this.healthySince >= STABLE_MS) this.restarts = 0;
        return "ok";
      }
      this.healthySince = null;
      // One slow answer isn't a wedge (a big chat read can hold the page for a moment): ask again before acting.
      await this.d.sleep(CONFIRM_DELAY_MS);
      err = await this.probeOnce();
      if (!err) return "ok";
      const why = trigger ? `${(trigger as Error).message ?? trigger}`.slice(0, 160) : err;
      this.restarts++;
      if (this.restarts > MAX_RESTARTS) {
        this.gaveUp = true;
        this.gaveUpAt = this.d.now();
        this.health = "failing";
        this.d.setHealth("failing", `WhatsApp isn't responding on ${this.d.serverName} (${why}). Restarting it didn't help.`);
        this.d.notify("failing", "warn", `WhatsApp on ${this.d.serverName} keeps not responding even after ${MAX_RESTARTS} restarts (${why}). ${this.d.giveUp ? "Handing this account to another server if one is online; otherwise restart the server from its console." : "Restart the server from its console."}`);
        this.d.giveUp?.();
        return "gave-up";
      }
      this.health = "unresponsive";
      this.d.setHealth("unresponsive", `WhatsApp on ${this.d.serverName} stopped responding (${why}). Restarting it.`);
      this.d.notify("unresponsive", "warn", `WhatsApp on ${this.d.serverName} stopped responding; restarting it${this.restarts > 1 ? ` (try ${this.restarts} of ${MAX_RESTARTS})` : ""}. Nothing is lost; messages are read again once it's back.`);
      await this.d.restart(RESTART_BACKOFF_MS[Math.min(this.restarts, RESTART_BACKOFF_MS.length) - 1]);
      return "restarted";
    } finally {
      this.busy = false;
    }
  }
}

/** True (and records it) when `key` hasn't fired within `windowMs`: one notice per cause, not one per retry. */
export function dueOnce(seen: Map<string, number>, key: string, windowMs: number, now: number) {
  if (now - (seen.get(key) ?? -Infinity) < windowMs) return false;
  seen.set(key, now);
  return true;
}
