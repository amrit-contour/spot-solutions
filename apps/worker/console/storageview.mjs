// The console's side of "where the data lives": what's in the data folder, how much room is left, and starting a move.
// The move itself runs outside this process (move.mjs, started through the platform's task runner via update.mjs).
import { existsSync } from "node:fs";
import path from "node:path";
import { contextFor, planMove } from "./move.mjs";
import { HEADROOM_BYTES, LOW_DISK_BYTES, freeBytes, inspectTarget, isInside, measure, readJson, summariseData } from "./storage.mjs";

const RESCAN_MS = 120_000;
const EXAMPLE = { win32: "D:\\SpotSolutions\\data", darwin: "/Volumes/Backup HDD/SpotSolutions/data", linux: "/mnt/disk/SpotSolutions/data" };

export function createStorage({ data, envFile, platform = process.platform, env = process.env, ollama, noLocalModel, updater, run = null, now = Date.now }) {
  // Everything about where things live comes from move.mjs, so this view and the mover can never disagree.
  const ctx = () => Object.assign(contextFor(platform, env), { current: data, envFile });
  const cache = { at: 0, data: null, models: null, running: false };

  /** The record of the last move. One that stopped reporting an hour ago counts as failed, so it can never block a new one. */
  function moveState(c) {
    const st = readJson(c.stateFile) ?? {};
    if ((st.phase === "running" || st.phase === "cleaning") && now() - (st.updatedAt ?? 0) > 3_600_000) return { ...st, phase: st.phase === "running" ? "failed" : "awaiting-cleanup", error: "The move stopped without finishing. Your data is still in the old folder.", step: "Stopped" };
    return st;
  }

  function rescan(c) {
    if (cache.running) return;
    cache.running = true;
    Promise.all([summariseData(c.current, { platform }), measure(c.currentModels, { platform, skip: new Set() }).catch(() => ({ bytes: 0 }))])
      .then(([d, m]) => { cache.data = d; cache.models = m.bytes; cache.at = now(); })
      .catch(() => { cache.at = now(); })
      .finally(() => { cache.running = false; });
  }

  /** Free space on the data drive, cheaply: the status page and the low-space banner use this on every refresh. */
  function drive() {
    try { return { dir: data, ...freeBytes(data) }; } catch { return { dir: data, free: null, total: null }; }
  }

  async function view({ scan = false } = {}) {
    const c = ctx();
    if (scan && now() - cache.at > RESCAN_MS) rescan(c);
    const d = drive();
    let modelsDrive = null;
    try { modelsDrive = freeBytes(existsSync(c.currentModels) ? c.currentModels : path.dirname(c.currentModels)); } catch { /* not there */ }
    const o = await ollama().catch(() => ({ up: false, models: [] }));
    const apiBytes = (o.models ?? []).reduce((a, m) => a + (m.size || 0), 0);
    const inside = isInside(c.currentModels, c.current, platform);
    const external = platform === "darwin" && existsSync(path.join(c.root, ".external-ollama"));
    const gemini = noLocalModel();
    const st = moveState(c);
    return {
      platform, dataDir: c.current, example: EXAMPLE[platform] ?? EXAMPLE.linux,
      drive: d, low: d.free != null && d.free < LOW_DISK_BYTES,
      entries: cache.data?.entries ?? null, bytes: cache.data?.bytes ?? null, files: cache.data?.files ?? null, scannedAt: cache.at || null, scanning: cache.running,
      models: {
        dir: c.currentModels, bytes: cache.models || apiBytes || 0, free: modelsDrive?.free ?? null, total: modelsDrive?.total ?? null,
        used: !gemini, inside,
        movable: !gemini && !external,
        reason: gemini ? "This server runs without a local model." : external ? "This Mac uses an Ollama that isn't Spot Solutions' own, so its models stay where Ollama keeps them." : null,
      },
      move: st.phase ? {
        phase: st.phase, step: st.step ?? null, pct: st.pct ?? null, error: st.error ?? null, old: st.old ?? null, target: st.target ?? null,
        moveModels: Boolean(st.moveModels), modelsOld: st.modelsOld ?? null, bytes: st.bytes ?? null, finishedAt: st.finishedAt ?? null, startedAt: st.startedAt ?? null, rolledBack: Boolean(st.rolledBack),
        // Only offer the delete when this console is running from the new folder.
        canDelete: st.phase === "awaiting-cleanup" && st.verified === true && st.target && path.resolve(st.target) === path.resolve(c.current),
      } : null,
    };
  }

  /** Checks a typed path against the real disk, with what the move needs. */
  async function check(input, { models = false } = {}) {
    const c = ctx();
    const probe = !(platform === "linux" && process.getuid?.() !== 0); // see storage.mjs: on Ubuntu only the root helper can try writing
    const first = await inspectTarget(input, { platform, current: c.current, forbidden: c.forbidden, run, probe });
    if (!first.ok) return first;
    const plan = planMove(c, { target: first.path, models });
    const dataBytes = cache.data?.bytes ?? (await measure(c.current, { platform })).bytes;
    const modelsBytes = plan.models?.separate ? (cache.models || (await measure(plan.models.old, { platform, skip: new Set() }).catch(() => ({ bytes: 0 }))).bytes) : 0;
    const need = dataBytes + modelsBytes + HEADROOM_BYTES;
    const room = await inspectTarget(first.path, { platform, current: c.current, forbidden: c.forbidden, run, needBytes: need, probe });
    return { ...room, dataBytes, modelsBytes, needBytes: need, movesModels: Boolean(plan.models), modelsInside: Boolean(plan.models && !plan.models.separate) };
  }

  /** Re-checks, then hands the job to the platform's task runner. The request carries only the path and the models yes/no. */
  async function start(input, { models = false, by = "console" } = {}) {
    const c = ctx();
    const st = moveState(c);
    if (st.phase === "running" || st.phase === "cleaning") throw new Error("A move is already running.");
    const r = await check(input, { models });
    if (!r.ok) throw new Error(r.error);
    const useModels = models && !noLocalModel();
    const started = await updater.start({ by, task: "move-data", extra: { target: r.path, models: useModels } });
    if (started.already) throw new Error("An update or another task is already running. Wait for it to finish.");
    return { ok: true, target: r.path };
  }

  async function cleanup({ by = "console" } = {}) {
    const v = await view();
    if (!v.move?.canDelete) throw new Error("There is no verified move waiting for its old copy to be deleted.");
    const started = await updater.start({ by, task: "move-cleanup" });
    if (started.already) throw new Error("An update or another task is already running. Wait for it to finish.");
    return { ok: true };
  }

  return { view, check, start, cleanup, drive, ctx };
}
