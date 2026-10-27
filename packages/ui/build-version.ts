import { execSync } from "node:child_process";

/**
 * The release identity of a build: git short SHA ("+" when the tree has uncommitted changes) and build time.
 * `define` bakes it into the bundle (__APP_VERSION__, __APP_BUILT_AT__); `plugin` emits the same pair as /version.json,
 * which the running app polls to learn a newer release is deployed. `vite dev` is "dev" and never asks to update.
 */
export function buildVersion(command: "build" | "serve") {
  let version = "dev";
  if (command === "build") {
    const git = (args: string) => execSync(`git ${args}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    try {
      version = git("rev-parse --short HEAD") + (git("status --porcelain --untracked-files=no") ? "+" : "");
    } catch {
      version = process.env.APP_VERSION ?? "unknown";
    }
  }
  const builtAt = new Date().toISOString();
  return {
    version,
    builtAt,
    define: { __APP_VERSION__: JSON.stringify(version), __APP_BUILT_AT__: JSON.stringify(builtAt) },
    plugin: {
      name: "app-version-json",
      apply: "build" as const,
      generateBundle(this: { emitFile(f: { type: "asset"; fileName: string; source: string }): void }) {
        this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ version, builtAt }) + "\n" });
      },
    },
  };
}
