import { describe, expect, it } from "vitest";
import path from "node:path";
import { runDoctor, summarize, hasCriticalFailure, sameServerDeps } from "./doctor.mjs";
import { parseEnv } from "./doctor-run.mjs";

const P = { appDir: "/app", dataDir: "/new/data", envFile: "/app/apps/worker/.env", legacyDataDirs: ["/old/data"], legacyChromeDirs: ["/old/chrome"] };
const KEY = JSON.stringify({ private_key: "k", client_email: "e@x" });

/** An in-memory machine: files is a Map path -> text|dir marker; every side effect is recorded in `log`. */
function machine(files = {}, over = {}) {
  const f = new Map(Object.entries(files));
  const log = [];
  const isDir = (p) => [...f.keys()].some((k) => k.startsWith(p + "/"));
  const d = {
    paths: P, nodeVersion: "v22.1.0", defaultModel: "gemma3:4b", parseEnv,
    readText: (p) => (f.has(p) ? f.get(p) : null),
    writeText: (p, t) => { f.set(p, t); log.push(["write", p]); },
    fs: {
      existsSync: (p) => f.has(p) || isDir(p),
      readdirSync: (p) => { const s = new Set([...f.keys()].filter((k) => k.startsWith(p + "/")).map((k) => k.slice(p.length + 1).split("/")[0])); if (!s.size) throw new Error("ENOENT"); return [...s]; },
      mkdirSync: (p) => { f.set(p + "/.dir", ""); log.push(["mkdir", p]); },
      cpSync: (from, to, o) => { log.push(["cp", from, to, o.force]); f.set(to + "/x", "copied"); },
      accessWritable: () => {},
    },
    freeBytes: async () => 50 * 1024 ** 3,
    installDeps: async () => { log.push(["installDeps"]); f.set("/app/apps/worker/node_modules/whatsapp-web.js/x", ""); f.set("/app/apps/worker/node_modules/tsx/x", ""); },
    browserCheck: async () => ({ ok: f.has("/chrome-ok"), build: "146.0.7680.31" }),
    browserEnsure: async (from) => { log.push(["browserEnsure", from]); f.set("/chrome-ok", ""); },
    ollamaTags: async () => ["gemma3:4b"], ollamaEnsure: async () => { log.push(["ollamaEnsure"]); },
    servicesCheck: async () => ({ ok: true }),
    ...over,
  };
  return { d, f, log };
}
const healthy = () => ({
  "/app/apps/worker/package.json": "{}", "/app/apps/worker/node_modules/whatsapp-web.js/x": "", "/app/apps/worker/node_modules/tsx/x": "",
  "/new/data/.dir": "", "/chrome-ok": "", "/app/apps/worker/.env": "FIREBASE_SERVICE_ACCOUNT=/new/data/service-account.json\n", "/new/data/service-account.json": KEY,
});
const byId = (r, id) => r.results.find((x) => x.id === id);

describe("doctor", () => {
  it("passes on a healthy machine", async () => {
    const { d } = machine(healthy());
    const r = await runDoctor(d);
    expect(r.ok).toBe(true);
    expect(summarize(r)).toBe("All checks passed");
  });

  it("reuses an old Chrome / downloads through browserEnsure with the old cache dirs, then re-checks", async () => {
    const files = healthy(); delete files["/chrome-ok"];
    const { d, log } = machine(files);
    const check = await runDoctor(d);
    expect(byId(check, "browser").ok).toBe(false);
    expect(hasCriticalFailure(check)).toBe(true);
    const fixed = await runDoctor(d, { repair: true });
    expect(log).toContainEqual(["browserEnsure", ["/old/chrome"]]);
    expect(byId(fixed, "browser")).toMatchObject({ ok: true, fixed: true });
    expect(summarize(fixed)).toMatch(/repaired/);
  });

  it("says a repair that didn't work, and stays critical", async () => {
    const files = healthy(); delete files["/chrome-ok"];
    const { d } = machine(files, { browserEnsure: async () => {} });
    const r = await runDoctor(d, { repair: true });
    expect(byId(r, "browser").ok).toBe(false);
    expect(byId(r, "browser").detail).toMatch(/still isn't right/);
    expect(hasCriticalFailure(r)).toBe(true);
  });

  it("reinstalls packages when node_modules is incomplete or older than the lockfile", async () => {
    const files = healthy(); delete files["/app/apps/worker/node_modules/tsx/x"];
    const { d, log } = machine(files);
    expect((await runDoctor(d, { repair: true })).ok).toBe(true);
    expect(log).toContainEqual(["installDeps"]);
    const stale = machine({ ...healthy(), "/app/pnpm-lock.yaml": "new", "/app/node_modules/.pnpm/lock.yaml": "old" });
    expect(byId(await runDoctor(stale.d), "deps").ok).toBe(false);
  });

  it("brings old data over only when the new server has no logins, and never overwrites", async () => {
    const files = { ...healthy(), "/old/data/wwebjs/s1/a": "", "/old/data/server.json": "{}", "/old/data/console-token": "t", "/old/data/service-account.json": "OLD", "/new/data/server.json": "mine" };
    const { d, log, f } = machine(files);
    const r = await runDoctor(d, { repair: true });
    expect(byId(r, "legacy-data")).toMatchObject({ ok: true, fixed: true });
    const copied = log.filter((l) => l[0] === "cp").map((l) => path.basename(l[1]));
    expect(copied).toEqual(["wwebjs"]); // server.json and service-account.json exist already, the token is machine-specific
    expect(log.filter((l) => l[0] === "cp").every((l) => l[3] === false)).toBe(true);
    expect(f.get("/new/data/server.json")).toBe("mine");
  });

  it("leaves old data alone when the new server already has logins", async () => {
    const { d } = machine({ ...healthy(), "/old/data/wwebjs/s1/a": "", "/new/data/wwebjs/s2/a": "" });
    expect(byId(await runDoctor(d), "legacy-data").ok).toBe(true);
  });

  it("maps legacy SPOT_ settings and flags a missing Firebase key", async () => {
    const { d, f } = machine({ ...healthy(), "/app/apps/worker/.env": "SPOT_ADMIN_EMAILS=a@b.c\nFIREBASE_SERVICE_ACCOUNT=/new/data/service-account.json\n" });
    const r = await runDoctor(d, { repair: true });
    expect(byId(r, "settings").ok).toBe(true);
    expect(f.get("/app/apps/worker/.env")).toContain("NBS_ADMIN_EMAILS=a@b.c");
    const noKey = machine({ ...healthy(), "/new/data/service-account.json": undefined });
    noKey.f.delete("/new/data/service-account.json");
    const nk = byId(await runDoctor(noKey.d, { repair: true }), "settings");
    expect(nk.ok).toBe(false);
    expect(nk.fix).toMatch(/console/);
  });

  it("starts the local AI repair in the background, and skips it on Gemini-only servers", async () => {
    const { d, log } = machine(healthy(), { ollamaTags: async () => null });
    const r = await runDoctor(d, { repair: true });
    expect(log).toContainEqual(["ollamaEnsure"]);
    expect(byId(r, "ai")).toMatchObject({ ok: true, fixed: true });
    const g = machine({ ...healthy(), "/app/apps/worker/.env": "FIREBASE_SERVICE_ACCOUNT=/new/data/service-account.json\nNBS_NO_LOCAL_MODEL=1\n" }, { ollamaTags: async () => { throw new Error("must not probe"); } });
    expect(byId(await runDoctor(g.d), "ai").detail).toMatch(/Gemini only/);
  });

  it("flags old Node, low disk and unregistered services in plain words; quick mode skips network checks", async () => {
    const { d } = machine(healthy(), { nodeVersion: "v18.0.0", freeBytes: async () => 1024 ** 3, servicesCheck: async () => ({ ok: false, detail: "A launch agent isn't registered" }) });
    const r = await runDoctor(d);
    expect(byId(r, "node").ok).toBe(false);
    expect(byId(r, "disk").detail).toMatch(/Only 1\.0 GB/);
    expect(byId(r, "services").ok).toBe(false);
    const q = await runDoctor(machine(healthy()).d, { quick: true });
    expect(q.results.map((x) => x.id)).toEqual(["node", "deps", "data", "settings", "disk"]);
  });

  it("a check that throws becomes a failed check, not a crash", async () => {
    const { d } = machine(healthy(), { browserCheck: async () => { throw new Error("boom"); } });
    expect(byId(await runDoctor(d, { only: ["browser"] }), "browser").detail).toMatch(/boom/);
  });
});

describe("sameServerDeps", () => {
  const lock = (worker, comic) => `lockfileVersion: '9.0'\n\nimporters:\n\n  apps/comic:\n    dependencies:\n      ${comic}\n\n  apps/worker:\n    dependencies:\n      ${worker}\n\n  packages/shared:\n    devDependencies:\n      vitest: 5.0.5\n\npackages:\n\n  a@1: {}\n`;
  it("ignores changes outside the server (a filtered install keeps a pruned lockfile)", () => {
    const pruned = lock("tsx: 4.0.0", "react: 19.0.0").replace("  a@1: {}\n", "");
    expect(sameServerDeps(pruned, lock("tsx: 4.0.0", "react: 19.2.0"))).toBe(true);
  });
  it("notices when the server's own packages changed", () => {
    expect(sameServerDeps(lock("tsx: 4.0.0", "react: 19.0.0"), lock("tsx: 4.1.0", "react: 19.0.0"))).toBe(false);
  });
});
