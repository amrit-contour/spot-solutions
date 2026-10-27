import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/**
 * Pins a fixed full-screen element to what you can actually see. On iOS the keyboard shrinks the *visual* viewport (not the layout
 * one), so a bottom composer would sit under it; this sizes the element to the visual viewport and follows its offset, so the
 * composer rides the keyboard with no gap. Returns whether the keyboard looks open (the home-indicator padding then goes).
 */
export function useVisualViewportFrame(ref: RefObject<HTMLElement | null>, enabled: boolean): { keyboard: boolean } {
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const el = ref.current;
    const vv = window.visualViewport;
    if (!enabled || !el || !vv) return;
    const apply = () => {
      el.style.height = `${vv.height}px`;
      el.style.transform = `translate3d(0, ${vv.offsetTop}px, 0)`;
      setKeyboard(window.innerHeight - vv.height - vv.offsetTop > 120);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    window.addEventListener("orientationchange", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      window.removeEventListener("orientationchange", apply);
      el.style.height = "";
      el.style.transform = "";
    };
  }, [ref, enabled]);
  return { keyboard };
}
