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
      includeAssets: ["favicon.svg", "favicon-nbc.svg", "icons/apple-touch-icon.png", "icons/nbc/*.png", "manifest-classic.webmanifest"],
      // This is the NBC (default) manifest; the Classic one is public/manifest-classic.webmanifest (see @spot/ui theme).
      manifest: {
        id: "/",
        name: "Nothing BOT Comedy",
        short_name: "NBot Comedy",
        description: "Rooms, spots and group alerts for comics.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#000000",
        theme_color: "#000000",
        categories: ["entertainment", "productivity"],
        icons: [
          { src: "/icons/nbc/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/nbc/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/nbc/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        shortcuts: [
          { name: "Rooms", url: "/rooms", icons: [{ src: "/icons/nbc/icon-192.png", sizes: "192x192" }] },
          { name: "My spots", url: "/spots", icons: [{ src: "/icons/nbc/icon-192.png", sizes: "192x192" }] },
        ],
      },
      workbox: {
        // App shell only. Firestore traffic is live data and must never be served stale.
        navigateFallback: "/index.html",
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
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
