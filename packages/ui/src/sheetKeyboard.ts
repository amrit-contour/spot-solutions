import { useEffect, type RefObject } from "react";

const KEYBOARD_MIN = 80; // px the visual viewport must lose before it counts as an on-screen keyboard
const FIELD = "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, select, [contenteditable=true], [contenteditable='']";

/**
 * Keeps a full-screen sheet usable while the on-screen keyboard is up. iOS (and Android's default) shrink the *visual* viewport, not
 * the layout one, so a `fixed inset-0` sheet keeps its old height and its bottom half hides under the keyboard. This sizes the sheet
 * to what you can see (top = visualViewport.offsetTop, height = visualViewport.height) and, when a field gets focus, scrolls it inside
 * the sheet's scroller clear of the keyboard and the footer. When the keyboard closes the inline sizing is removed, so the sheet
 * goes back to plain `inset-0` with no leftover gap.
 */
export function useSheetKeyboard(root: RefObject<HTMLElement | null>, scroller: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const el = root.current;
    const sc = scroller.current;
    const vv = window.visualViewport;
    if (!enabled || !el || !sc || !vv) return;
    let raf = 0;
    let timer = 0;
    const open = () => window.innerHeight - vv.height - vv.offsetTop > KEYBOARD_MIN || window.innerHeight - vv.height > KEYBOARD_MIN;
    const frame = () => {
      if (open()) {
        el.style.top = `${vv.offsetTop}px`;
        el.style.height = `${vv.height}px`;
        el.style.bottom = "auto";
        // The home-indicator padding is under the keyboard now: drop it (the footer reads --sheet-safe).
        el.style.setProperty("--sheet-safe", "0");
      } else {
        el.style.removeProperty("--sheet-safe");
        el.style.top = "";
        el.style.height = "";
        el.style.bottom = "";
      }
    };
    /**
     * Scroll the focused field into the visible part of the scroller, with room above the keyboard and below the header.
     * A field inside `[data-keep-visible]` keeps that whole block (the field plus its results) in view when it fits; when it
     * is taller than the visible area the field goes to the top so what it lists fills the space under it.
     */
    const reveal = () => {
      const t = document.activeElement as HTMLElement | null;
      if (!t || !sc.contains(t) || !t.matches(FIELD)) return;
      const box = sc.getBoundingClientRect();
      const field = t.getBoundingClientRect();
      const block = (t.closest("[data-keep-visible]") ?? t).getBoundingClientRect();
      const pad = 16;
      const room = box.height - pad * 2;
      if (block.height > room) sc.scrollTop += field.top - (box.top + pad);
      else if (block.bottom > box.bottom - pad) sc.scrollTop += block.bottom - (box.bottom - pad);
      else if (block.top < box.top + pad) sc.scrollTop -= box.top + pad - block.top;
    };
    const onViewport = () => {
      frame();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(reveal);
    };
    const onFocusIn = () => {
      // The keyboard animates in after focus: reveal now, and again once the viewport has settled.
      onViewport();
      window.clearTimeout(timer);
      timer = window.setTimeout(onViewport, 320);
    };
    frame();
    vv.addEventListener("resize", onViewport);
    vv.addEventListener("scroll", frame);
    el.addEventListener("focusin", onFocusIn);
    // Typing can grow what sits under the field (search results): keep it in view.
    el.addEventListener("input", onViewport);
    window.addEventListener("orientationchange", onViewport);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      vv.removeEventListener("resize", onViewport);
      vv.removeEventListener("scroll", frame);
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("input", onViewport);
      window.removeEventListener("orientationchange", onViewport);
      el.style.top = el.style.height = el.style.bottom = "";
      el.style.removeProperty("--sheet-safe");
    };
  }, [root, scroller, enabled]);
}
