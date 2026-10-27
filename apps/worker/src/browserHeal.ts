// WhatsApp runs in Chrome, which puppeteer normally downloads at install time. pnpm skips that download when it installs
// from its cache (see deploy/ensure-browser.mjs), so a fresh install can end up without a browser. When the launch fails
// for exactly that reason the worker runs the same ensure-browser step once and retries, instead of showing puppeteer's text.
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BROWSER_MISSING_MESSAGE = "WhatsApp's browser isn't installed on this server; open the console and press Check and repair (or run Update)";
/** Where an older (pre-rename) install kept its browser cache; an identical build there is copied instead of downloaded. */
const LEGACY_CHROME = process.platform === "win32" ? ["C:\\SpotSolutions\\chrome"]
  : process.platform === "darwin" ? [path.join(os.homedir(), "Library", "Application Support", "SpotSolutions", "chrome")]
  : ["/var/lib/spot-solutions/.cache/puppeteer"];
const HEAL_EVERY_MS = 30 * 60_000;

/** puppeteer's "Could not find Chrome (ver. X) ... cache path ..." and its relatives (a bad executablePath, ENOENT on spawn). */
export function isMissingBrowserError(e: unknown): boolean {
  const m = String((e as { message?: string })?.message ?? e ?? "");
  return /could not find (chrome|chromium|browser)|no usable browser|browser was not found|failed to launch the browser process.*(enoent|no such file)/i.test(m)
    || /spawn .*(chrome|chromium).* ENOENT/i.test(m);
}

let healing: Promise<boolean> | null = null;
let lastTry = 0;

/** Runs deploy/ensure-browser.mjs; true when a browser is in place afterwards. Concurrent callers share one run; one run per 30 minutes. */
export function healBrowser(): Promise<boolean> {
  if (healing) return healing;
  if (Date.now() - lastTry < HEAL_EVERY_MS) return Promise.resolve(false);
  lastTry = Date.now();
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "deploy", "ensure-browser.mjs");
  console.warn("[browser] Chrome is missing; installing it now (one time, this can take a few minutes)");
  healing = new Promise<boolean>((resolve) => {
    execFile(process.execPath, [script, ...LEGACY_CHROME.flatMap((d) => ["--from", d])], { timeout: 15 * 60_000, maxBuffer: 4_000_000, env: process.env }, (err, out, errOut) => {
      for (const l of `${out}${errOut}`.split("\n").filter(Boolean).slice(-6)) console.log(l);
      resolve(!err);
    });
  }).finally(() => { healing = null; });
  return healing;
}

/** At worker start: a quick look (no download) and, only if the browser is missing, the repair in the background. */
export function checkBrowserAtStart(): void {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "deploy", "ensure-browser.mjs");
  execFile(process.execPath, [script, "--check"], { timeout: 60_000, env: process.env }, (err) => { if (err) void healBrowser(); });
}
