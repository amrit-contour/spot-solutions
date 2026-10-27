import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import Icons from "unplugin-icons/vite";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath } from "node:url";
import { iconVersion } from "../../packages/ui/icon-version.ts";
import { buildVersion } from "../../packages/ui/build-version.ts";

// ?v=<hash of the icon files> on every icon/manifest-icon URL, so a changed icon is never served from a stale browser cache.
const icons = iconVersion(fileURLToPath(new URL("./public", import.meta.url)));

export default defineConfig(({ command }) => {
  // __APP_VERSION__ / __APP_BUILT_AT__ in the bundle, and the same pair as /version.json (what the running app polls).
  const ver = buildVersion(command);
  return {
  plugins: [
    react(),
    ver.plugin,
    icons.plugin,
    tailwindcss(),
    Icons({ compiler: "jsx", jsx: "react", scale: 1 }),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "favicon-nbc.svg", "favicon.ico", "favicon-nbc.ico", "icons/apple-touch-icon.png", "icons/*.png", "icons/nbc/*.png", "manifest-classic.webmanifest"],
      // This is the NBC (default) manifest; the Classic one is public/manifest-classic.webmanifest (see @spot/ui theme).
      manifest: {
        id: "/",
        name: "Nothing BOT Curate",
        short_name: "nBOT Curate",
        description: "Open-mic lineups sorted from your WhatsApp by a Gemma model on your own laptop.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#000000",
        theme_color: "#000000",
        categories: ["productivity", "entertainment"],
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
          { name: "Calendar", url: "/", icons: [{ src: icons.versioned("/icons/nbc/icon-192.png"), sizes: "192x192" }] },
          { name: "Requests", url: "/requests", icons: [{ src: icons.versioned("/icons/nbc/icon-192.png"), sizes: "192x192" }] },
          { name: "Lineup", url: "/lineup", icons: [{ src: icons.versioned("/icons/nbc/icon-192.png"), sizes: "192x192" }] },
        ],
      },
      workbox: {
        // App shell only. Firestore traffic is live data and must never be served stale.
        // The app shell (index.html) is NetworkFirst: a normal reopen loads the newest release when online, and the last
        // copy when offline. It is never served from the precache, so it can't pin an old release.
        globPatterns: ["**/*.{js,css,svg,png,woff2}"],
        // Push (FCM) handlers live in public/fcm-sw.js and run inside this same service worker.
        // Loaded with importScripts, so it stays out of the precache and the browser re-checks it on its own.
        importScripts: ["fcm-sw.js"],
        globIgnores: ["fcm-sw.js"],
        runtimeCaching: [
          // Installer downloads, the policy pages and press assets are plain files: straight to the network.
          { urlPattern: ({ request, url }: { request: Request; url: URL }) => request.mode === "navigate" && !/^\/(dl\/|brand\/|press\/|uninstall|migrate-mac|restore-backup|privacy|terms)|^\/install(-mac)?\.(sh|ps1)$/.test(url.pathname), handler: "NetworkFirst", options: { cacheName: "pages", networkTimeoutSeconds: 4 } },

          { urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/, handler: "StaleWhileRevalidate", options: { cacheName: "fonts" } },
        ],
      },
    }),
  ],
  // Changes every build; appended to installer links so a stale browser cache can never answer them.
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)), ...ver.define },
  server: { port: 5173 },
  build: {
    rolldownOptions: {
      output: {
        // Firebase is the bulk of the bundle; split it so app code updates stay small.
        advancedChunks: { groups: [{ name: "firebase", test: /node_modules[\\/](@firebase|firebase)/ }, { name: "motion", test: /node_modules[\\/](motion|framer-motion)/ }] },
      },
    },
  },
};
});
