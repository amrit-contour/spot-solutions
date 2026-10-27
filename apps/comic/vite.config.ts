import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import Icons from "unplugin-icons/vite";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath } from "node:url";
import { copyFileSync, readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { iconVersion } from "../../packages/ui/icon-version.ts";

// ?v=<hash of the icon files> on every icon/manifest-icon URL, so a changed icon is never served from a stale browser cache.
const icons = iconVersion(fileURLToPath(new URL("./public", import.meta.url)));

// The privacy policy and terms have one source (apps/web/public); Comedy serves the same files, at build and in dev, never a copy in git.
const LEGAL = ["privacy.html", "terms.html", "legal.css"];
const legalSrc = (f: string) => fileURLToPath(new URL(`../web/public/${f}`, import.meta.url));
const legalFiles = (): Plugin => ({
  name: "shared-legal-pages",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const path = (req.url ?? "").split("?")[0];
      const f = LEGAL.find((n) => path === `/${n}` || path === `/${n.replace(/\.html$/, "")}`);
      if (!f) return next();
      res.setHeader("Content-Type", f.endsWith(".css") ? "text/css" : "text/html; charset=utf-8");
      res.end(readFileSync(legalSrc(f)));
    });
  },
  closeBundle() {
    const out = fileURLToPath(new URL("./dist/", import.meta.url));
    for (const f of LEGAL) copyFileSync(legalSrc(f), out + f);
  },
});

export default defineConfig({
  plugins: [
    react(),
    legalFiles(),
    icons.plugin,
    tailwindcss(),
    Icons({ compiler: "jsx", jsx: "react", scale: 1 }),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "favicon-nbc.svg", "favicon.ico", "favicon-nbc.ico", "icons/apple-touch-icon.png", "icons/*.png", "icons/nbc/*.png", "manifest-classic.webmanifest"],
      // This is the NBC (default) manifest; the Classic one is public/manifest-classic.webmanifest (see @spot/ui theme).
      manifest: {
        id: "/",
        name: "Nothing BOT Comedy",
        short_name: "nBOT Comedy",
        description: "Rooms, spots and group alerts for comics.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#000000",
        theme_color: "#000000",
        categories: ["entertainment", "productivity"],
        icons: [
          { src: icons.versioned("/icons/nbc/icon-48.png"), sizes: "48x48", type: "image/png", purpose: "any" },
          { src: icons.versioned("/icons/nbc/icon-64.png"), sizes: "64x64", type: "image/png", purpose: "any" },
          { src: icons.versioned("/icons/nbc/icon-96.png"), sizes: "96x96", type: "image/png", purpose: "any" },
          { src: icons.versioned("/icons/nbc/icon-128.png"), sizes: "128x128", type: "image/png", purpose: "any" },
          { src: icons.versioned("/icons/nbc/icon-192.png"), sizes: "192x192", type: "image/png", purpose: "any" },
          { src: icons.versioned("/icons/nbc/icon-256.png"), sizes: "256x256", type: "image/png", purpose: "any" },
          { src: icons.versioned("/icons/nbc/icon-512.png"), sizes: "512x512", type: "image/png", purpose: "any" },
          { src: icons.versioned("/icons/nbc/maskable-512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        shortcuts: [
          { name: "Rooms", url: "/rooms", icons: [{ src: icons.versioned("/icons/nbc/icon-192.png"), sizes: "192x192" }] },
          { name: "My spots", url: "/spots", icons: [{ src: icons.versioned("/icons/nbc/icon-192.png"), sizes: "192x192" }] },
        ],
      },
      workbox: {
        // App shell only. Firestore traffic is live data and must never be served stale.
        navigateFallback: "/index.html",
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        // Push (FCM) handlers live in public/fcm-sw.js and run inside this same service worker (spot alerts). Loaded with
        // importScripts, so it stays out of the precache and the browser re-checks it on its own.
        importScripts: ["fcm-sw.js"],
        globIgnores: ["fcm-sw.js"],
        runtimeCaching: [{ urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/, handler: "StaleWhileRevalidate", options: { cacheName: "fonts" } }],
      },
    }),
  ],
  server: { port: 5174, strictPort: true },
  build: {
    rolldownOptions: {
      output: {
        advancedChunks: { groups: [{ name: "firebase", test: /node_modules[\\/](@firebase|firebase)/ }, { name: "motion", test: /node_modules[\\/](motion|framer-motion)/ }] },
      },
    },
  },
});
