import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import Icons from "unplugin-icons/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    Icons({ compiler: "jsx", jsx: "react", scale: 1 }),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "favicon-nbc.svg", "favicon.ico", "favicon-nbc.ico", "icons/apple-touch-icon.png", "icons/*.png", "icons/nbc/*.png", "manifest-classic.webmanifest"],
      // This is the NBC (default) manifest; the Classic one is public/manifest-classic.webmanifest (see @spot/ui theme).
      manifest: {
        id: "/",
        name: "Nothing BOT Curating",
        short_name: "NBot Curate",
        description: "Open-mic lineups sorted from your WhatsApp by a Gemma model on your own laptop.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#000000",
        theme_color: "#000000",
        categories: ["productivity", "entertainment"],
        icons: [
          { src: "/icons/nbc/icon-48.png", sizes: "48x48", type: "image/png", purpose: "any" },
          { src: "/icons/nbc/icon-64.png", sizes: "64x64", type: "image/png", purpose: "any" },
          { src: "/icons/nbc/icon-96.png", sizes: "96x96", type: "image/png", purpose: "any" },
          { src: "/icons/nbc/icon-128.png", sizes: "128x128", type: "image/png", purpose: "any" },
          { src: "/icons/nbc/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/nbc/icon-256.png", sizes: "256x256", type: "image/png", purpose: "any" },
          { src: "/icons/nbc/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/nbc/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        shortcuts: [
          { name: "Calendar", url: "/", icons: [{ src: "/icons/nbc/icon-192.png", sizes: "192x192" }] },
          { name: "Requests", url: "/requests", icons: [{ src: "/icons/nbc/icon-192.png", sizes: "192x192" }] },
          { name: "Lineup", url: "/lineup", icons: [{ src: "/icons/nbc/icon-192.png", sizes: "192x192" }] },
        ],
      },
      workbox: {
        // App shell only. Firestore traffic is live data and must never be served stale.
        navigateFallback: "/index.html",
        // Installer downloads must reach the network, never the app shell.
        navigateFallbackDenylist: [/^\/dl\//, /^\/install(-mac)?\.(sh|ps1)$/, /^\/(privacy|terms)(\.html)?$/, /^\/brand\//, /^\/press\//],
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        // Push (FCM) handlers live in public/fcm-sw.js and run inside this same service worker.
        // Loaded with importScripts, so it stays out of the precache and the browser re-checks it on its own.
        importScripts: ["fcm-sw.js"],
        globIgnores: ["fcm-sw.js"],
        runtimeCaching: [
          { urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/, handler: "StaleWhileRevalidate", options: { cacheName: "fonts" } },
        ],
      },
    }),
  ],
  // Changes every build; appended to installer links so a stale browser cache can never answer them.
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
  server: { port: 5173 },
  build: {
    rolldownOptions: {
      output: {
        // Firebase is the bulk of the bundle; split it so app code updates stay small.
        advancedChunks: { groups: [{ name: "firebase", test: /node_modules[\\/](@firebase|firebase)/ }, { name: "motion", test: /node_modules[\\/](motion|framer-motion)/ }] },
      },
    },
  },
});
