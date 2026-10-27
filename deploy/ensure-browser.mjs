#!/usr/bin/env node
// Makes sure the browser WhatsApp Web runs in (Chrome for Testing, the exact build the pinned puppeteer expects) is
// in PUPPETEER_CACHE_DIR, on every platform. Used by the installers, the updaters and the worker's self-heal.
//
// Why it exists: puppeteer only downloads Chrome from its own postinstall script. pnpm skips that script when the package
// comes from its store with a "side effects" cache entry (any machine that ever installed puppeteer before), so a
// fresh `pnpm install` can finish "successfully" with an empty chrome cache and the worker later fails with
// "Could not find Chrome (ver. X)". This step doesn't depend on that script.
//
// Usage (from anywhere; PUPPETEER_CACHE_DIR must be set, it decides where the browser lives):
//   node deploy/ensure-browser.mjs [--from <old chrome cache dir>]...   (--from may repeat; a matching build there is copied, not downloaded)
// Exit 0 and prints "browser ok: <path>" when chrome is usable; exit 1 with a plain message otherwise.
import { createRequire } from "node:module";
import { existsSync, cpSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const log = (m) => console.log(`[browser] ${m}`);

/** The browser tooling exactly as the worker resolves it: whatsapp-web.js -> puppeteer -> puppeteer-core -> @puppeteer/browsers. */
function tooling() {
  const fromApp = createRequire(path.join(appRoot, "apps", "worker", "package.json"));
  const fromWwebjs = createRequire(fromApp.resolve("whatsapp-web.js/package.json"));
  const fromPuppeteer = createRequire(fromWwebjs.resolve("puppeteer/package.json"));
  const fromCore = createRequire(fromPuppeteer.resolve("puppeteer-core/package.json"));
  const { PUPPETEER_REVISIONS } = fromCore("puppeteer-core/lib/cjs/puppeteer/revisions.js");
  return { browsers: fromCore("@puppeteer/browsers"), revisions: PUPPETEER_REVISIONS };
}

/** One download attempt that gives up when no bytes arrive for 60 s (a stalled connection otherwise hangs the installer forever). */
function downloadOnce(browsers, opts) {
  return new Promise((resolve, reject) => {
    let timer, last = 0, shown = -1;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => reject(new Error("the download stalled (no data for 60 seconds)")), 60_000); };
    arm();
    browsers.install({
      ...opts, unpack: true,
      downloadProgressCallback: (got, total) => {
        if (got !== last) { last = got; arm(); }
        const pct = total ? Math.floor((got / total) * 10) * 10 : 0;
        if (pct !== shown && total) { shown = pct; log(`${opts.browser} ${pct}%`); }
      },
    }).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

async function downloadWithRetries(browsers, opts, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await downloadOnce(browsers, opts); }
    catch (e) {
      if (i >= tries) throw e;
      log(`attempt ${i} failed (${e.message}); trying again`);
      await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
}

export async function ensureBrowser({ cacheDir, from = [], checkOnly = false } = {}) {
  cacheDir = path.resolve(cacheDir || process.env.PUPPETEER_CACHE_DIR || path.join(homedir(), ".cache", "puppeteer"));
  process.env.PUPPETEER_CACHE_DIR = cacheDir;
  const { browsers, revisions } = tooling();
  const platform = browsers.detectBrowserPlatform();
  if (!platform) throw new Error("This computer's type isn't supported by Chrome for Testing.");
  const exeOf = (browser, cache) => browsers.computeExecutablePath({ browser, buildId: revisions[browser], cacheDir: cache, platform });
  const want = ["chrome", "chrome-headless-shell"];

  if (checkOnly) {
    const e = exeOf("chrome", cacheDir);
    if (!existsSync(e)) throw new Error(`Chrome ${revisions.chrome} isn't installed`);
    return e;
  }

  // 1. A copy from an older install with the same build (no download; works offline).
  for (const b of want) {
    if (existsSync(exeOf(b, cacheDir))) continue;
    for (const old of from.map((d) => path.resolve(d)).filter((d) => d !== cacheDir)) {
      const exe = exeOf(b, old);
      if (!existsSync(exe)) continue;
      const rel = path.relative(old, exe).split(path.sep); // <browser>/<platform>-<build>/...
      const dir = (root) => path.join(root, rel[0], rel[1]);
      log(`copying ${b} ${revisions[b]} from ${old}`);
      try {
        mkdirSync(path.dirname(dir(cacheDir)), { recursive: true });
        cpSync(dir(old), dir(cacheDir), { recursive: true, verbatimSymlinks: true, force: true });
      } catch (e) { log(`couldn't copy from ${old}: ${e.message}`); }
      if (existsSync(exeOf(b, cacheDir))) break;
    }
  }

  // 2. Download whatever is still missing. chrome is required; the headless shell is a bonus.
  for (const b of want) {
    if (existsSync(exeOf(b, cacheDir))) continue;
    log(`downloading ${b} ${revisions[b]} into ${cacheDir}`);
    try {
      await downloadWithRetries(browsers, { browser: b, buildId: revisions[b], cacheDir, platform });
    } catch (e) {
      if (b === "chrome") throw new Error(`Couldn't download Chrome ${revisions[b]}: ${e.message}`);
      log(`(optional) couldn't download ${b}: ${e.message}`);
    }
  }

  const exe = exeOf("chrome", cacheDir);
  if (!existsSync(exe)) throw new Error(`Chrome ${revisions.chrome} is still missing at ${exe}`);
  // Soft check that it starts (missing system libraries on Linux show up here); Windows chrome.exe prints nothing for --version.
  if (process.platform !== "win32") {
    try { execFileSync(exe, ["--version"], { timeout: 30_000, stdio: "pipe" }); }
    catch (e) { log(`warning: ${exe} didn't start (${String(e.message).split("\n")[0]}); the system may be missing libraries it needs`); }
  }
  return exe;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const from = [];
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i] === "--from" && a[i + 1]) from.push(a[++i]);
  // --check: only say whether the browser is there (exit 0 or 2), change nothing.
  const checkOnly = a.includes("--check");
  ensureBrowser({ from, checkOnly }).catch((e) => { if (checkOnly) { console.error(`[browser] ${e.message}`); process.exit(2); } throw e; }).then((exe) => log(`browser ok: ${exe}`), (e) => { console.error(`[browser] ${e.message}`); process.exit(1); });
}
