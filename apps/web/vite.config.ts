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
      includeAssets: ["favicon.svg", "icons/apple-touch-icon.png"],
      manifest: {
        id: "/",
        name: "Spot Solutions by Amrit Dash",
        short_name: "Spots",
        description: "Open-mic lineups sorted from your WhatsApp by a Gemma model on your own laptop. By Amrit Dash.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#fff8f4",
        theme_color: "#7a5416",
        categories: ["productivity", "entertainment"],
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        shortcuts: [
          { name: "Requests", url: "/", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
          { name: "Lineup", url: "/lineup", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
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
