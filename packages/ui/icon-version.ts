import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Cache-busting for favicons, app icons and the install manifests. Icon files keep their names (they are linked from
 * many places, including pages an installed app already has), so every link gets `?v=<hash of the icon files>`:
 * change an icon and every link changes with it, so no browser can answer from a stale copy.
 *
 * `v` is for vite.config (manifest icon URLs). The plugin rewrites the icon links in index.html, adds
 * <meta name="icon-version"> (read by setBrand in @spot/ui, which swaps icons at runtime) and versions the icon
 * URLs inside the static Classic manifest in the build output.
 */
export function iconVersion(publicDir: string) {
  const hash = createHash("sha256");
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const full = path.join(dir, f);
      if (statSync(full).isDirectory()) walk(full);
      else hash.update(path.relative(publicDir, full)).update(readFileSync(full));
    }
  };
  walk(path.join(publicDir, "icons"));
  for (const f of readdirSync(publicDir).sort()) if (f.startsWith("favicon")) hash.update(f).update(readFileSync(path.join(publicDir, f)));
  const v = hash.digest("hex").slice(0, 8);
  const ICON_URL = /^\/(icons\/|favicon)[^?#]*$/;
  const versioned = (url: string) => (ICON_URL.test(url) ? `${url}?v=${v}` : url);
  const plugin = {
    name: "icon-version",
    transformIndexHtml(html: string) {
      const out = html.replace(/\b(href|data-icon-nbc|data-icon-classic)="(\/[^"]*)"/g, (m, attr: string, url: string) => (ICON_URL.test(url) ? `${attr}="${versioned(url)}"` : m));
      return out.replace("<head>", `<head>\n    <meta name="icon-version" content="${v}" />`);
    },
    writeBundle(options: { dir?: string }) {
      const file = path.join(options.dir ?? "dist", "manifest-classic.webmanifest");
      if (!existsSync(file)) return;
      writeFileSync(file, readFileSync(file, "utf8").replace(/"src": "(\/icons\/[^"?]+)"/g, (_m, url: string) => `"src": "${versioned(url)}"`));
    },
  };
  return { v, plugin, versioned };
}
