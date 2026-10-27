// Route-level code splitting shared by both apps. Each page is its own chunk, fetched when first needed; the shell and nav stay in
// the main bundle so they appear at once. Likely next pages are fetched while the browser is idle, or the moment a link is hovered.
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;
type Loader<C extends AnyComponent> = () => Promise<{ default: C }>;
export type RouteComponent<C extends AnyComponent = AnyComponent> = LazyExoticComponent<C> & { preload: () => void };

const RELOAD_KEY = "chunk-reload-at";

/** A chunk that 404s means a new release replaced the files this tab was opened with: reload once to pick them up. */
function withReload<C extends AnyComponent>(load: Loader<C>): Loader<C> {
  return () =>
    load().catch((e: unknown) => {
      try {
        const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
        if (Date.now() - last > 30_000) {
          sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
          location.reload();
          return new Promise<never>(() => undefined); // the page is going away
        }
      } catch {
        /* storage blocked: fall through to the error boundary */
      }
      throw e;
    });
}

export function lazyRoute<C extends AnyComponent>(load: Loader<C>): RouteComponent<C> {
  const loader = withReload(load);
  let started: Promise<unknown> | undefined;
  const C = lazy(() => (started = loader())) as RouteComponent<C>;
  C.preload = () => {
    started ??= loader().catch(() => undefined);
  };
  return C;
}

/**
 * Warms page chunks: the one being opened right now, then the rest one at a time while idle (not on data saver / 2G), and any
 * page whose link is hovered or touched. Returns a cleanup for the link listeners.
 */
export function prefetchRoutes(byPath: Record<string, RouteComponent>, order: string[]) {
  byPath[location.pathname]?.preload();
  const conn = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (!conn?.saveData && !/(^|-)2g$/.test(conn?.effectiveType ?? "")) {
    const queue = order.map((p) => byPath[p]).filter(Boolean);
    const idle = (fn: () => void) => ("requestIdleCallback" in window ? window.requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 800));
    const next = () => {
      const r = queue.shift();
      if (!r) return;
      r.preload();
      idle(() => setTimeout(next, 150));
    };
    idle(() => setTimeout(next, 1500));
  }
  const onIntent = (e: Event) => {
    const a = (e.target as Element | null)?.closest?.("a[href^='/']");
    const path = a?.getAttribute("href")?.split(/[?#]/)[0];
    if (path) byPath[path]?.preload();
  };
  document.addEventListener("pointerover", onIntent, { passive: true });
  document.addEventListener("touchstart", onIntent, { passive: true });
  return () => {
    document.removeEventListener("pointerover", onIntent);
    document.removeEventListener("touchstart", onIntent);
  };
}
