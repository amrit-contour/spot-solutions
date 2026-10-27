// spot-solutions.web.app is retired. An installed copy of the old app still has a service worker here; the browser
// re-checks this file on load, finds this one, and it removes itself and everything cached, then reloads the open pages
// (which now show the "moved" page and forward to nothingbotcurate.web.app). It never intercepts a request.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        for (const k of await caches.keys()) await caches.delete(k);
      } catch {}
      try {
        await self.registration.unregister();
      } catch {}
      try {
        for (const c of await self.clients.matchAll({ type: "window" })) c.navigate(c.url).catch(() => {});
      } catch {}
    })(),
  );
});
