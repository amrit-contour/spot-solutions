import { useEffect, type RefObject } from "react";
import { shouldReveal, type RevealTrigger } from "@spot/shared";

const KEYBOARD_MIN = 80; // px the visual viewport must lose before it counts as an on-screen keyboard
const FIELD = "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, select, [contenteditable=true], [contenteditable='']";

/**
 * Keeps a full-screen sheet usable while the on-screen keyboard is up WITHOUT moving the sheet. The sheet keeps its full height and
 * the footer stays at the bottom, under the keyboard; only the focused field moves, inside the sheet's scroller. iOS shrinks the
 * *visual* viewport (not the layout one) and may pan it, so this:
 *  - publishes the covered height as `--sheet-kb` on the sheet; the sheet renders a spacer of that height at the end of the
 *    scroller, so the last field can scroll above the keyboard;
 *  - when iOS has panned the visual viewport (offsetTop > 0), moves the sheet down by that much so its header stays in view and
 *    nothing but the sheet shows (the document itself never scrolls);
 *  - scrolls the focused field into the part of the scroller that is actually visible (above the keyboard).
 * When the keyboard closes everything is removed and the sheet is plain `inset-0` again.
 */
export function useSheetKeyboard(root: RefObject<HTMLElement | null>, scroller: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    const el = root.current;
    const sc = scroller.current;
    const vv = window.visualViewport;
    if (!enabled || !el || !sc || !vv) return;
    let raf = 0;
    let timer = 0;
    let releaseTimer = 0;
    let trigger: RevealTrigger = "viewport";
    // iOS runs its own autoscroll + caret magnifier while a finger drags in a field; nothing here may move then (see revealPolicy).
    let touching = false;
    let lastSelection = 0;
    const selectionActive = () => {
      const a = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      if (a && sc.contains(a) && typeof a.selectionStart === "number" && a.selectionStart !== a.selectionEnd) return true;
      const sel = document.getSelection();
      return !!sel && !sel.isCollapsed && !!sel.anchorNode && sc.contains(sel.anchorNode);
    };
    const allowed = () => shouldReveal({ trigger, touching, selectionActive: selectionActive(), msSinceSelectionChange: Date.now() - lastSelection });
    const covered = () => Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    const open = () => covered() > KEYBOARD_MIN || window.innerHeight - vv.height > KEYBOARD_MIN;
    const frame = () => {
      // The pan compensation jitters while iOS autoscrolls a selection drag: hold it until the finger is up.
      if (touching) return;
      if (open()) {
        el.style.setProperty("--sheet-kb", `${Math.max(covered(), window.innerHeight - vv.height)}px`);
        // iOS panned the visual viewport: follow it so the header stays visible; the sheet keeps its full height.
        if (vv.offsetTop > 0) {
          el.style.top = `${vv.offsetTop}px`;
          el.style.bottom = "auto";
          el.style.height = `${window.innerHeight}px`;
        } else {
          el.style.top = el.style.bottom = el.style.height = "";
        }
      } else {
        el.style.removeProperty("--sheet-kb");
        el.style.top = el.style.bottom = el.style.height = "";
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
      const raw = sc.getBoundingClientRect();
      // Only the part above the keyboard counts as visible.
      const box = { top: raw.top, bottom: Math.min(raw.bottom, vv.offsetTop + vv.height), height: 0 };
      box.height = box.bottom - box.top;
      const field = t.getBoundingClientRect();
      const block = (t.closest("[data-keep-visible]") ?? t).getBoundingClientRect();
      const pad = 16;
      const room = box.height - pad * 2;
      if (block.height > room) sc.scrollTop += field.top - (box.top + pad);
      else if (block.bottom > box.bottom - pad) sc.scrollTop += block.bottom - (box.bottom - pad);
      else if (block.top < box.top + pad) sc.scrollTop -= box.top + pad - block.top;
    };
    const run = (t: RevealTrigger) => {
      trigger = t;
      frame();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => allowed() && reveal());
    };
    const onViewport = () => run("viewport");
    const onInput = () => run("input");
    const onTouchStart = (e: Event) => {
      if (!(e.target as HTMLElement | null)?.closest?.(FIELD)) return;
      touching = true;
      window.clearTimeout(releaseTimer);
    };
    const onTouchEnd = () => {
      if (!touching) return;
      window.clearTimeout(releaseTimer);
      // The magnifier and handles outlive the touch by a beat; catch the sheet position up after that.
      releaseTimer = window.setTimeout(() => {
        touching = false;
        frame();
      }, 400);
    };
    const onSelectionChange = () => { lastSelection = Date.now(); };
    const onFocusIn = () => {
      trigger = "focus";
      // The keyboard animates in after focus: reveal now, and again once the viewport has settled.
      run("focus");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => run("focus"), 320);
    };
    // iOS can leave the (overflow:hidden) document scrolled after the keyboard closes; put it back with no animation.
    const onFocusOut = () => {
      window.setTimeout(() => {
        if (!sc.contains(document.activeElement) && (window.scrollY || document.documentElement.scrollTop)) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      }, 120);
    };
    frame();
    el.addEventListener("focusout", onFocusOut);
    vv.addEventListener("resize", onViewport);
    vv.addEventListener("scroll", onViewport);
    el.addEventListener("focusin", onFocusIn);
    // Typing can grow what sits under the field (search results): keep it in view.
    el.addEventListener("input", onInput);
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("pointerdown", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchEnd, { passive: true });
    window.addEventListener("pointerup", onTouchEnd, { passive: true });
    window.addEventListener("pointercancel", onTouchEnd, { passive: true });
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("orientationchange", onViewport);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      vv.removeEventListener("resize", onViewport);
      vv.removeEventListener("scroll", onViewport);
      el.removeEventListener("focusin", onFocusIn);
      window.clearTimeout(releaseTimer);
      el.removeEventListener("focusout", onFocusOut);
      el.removeEventListener("input", onInput);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("pointerdown", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
      window.removeEventListener("pointerup", onTouchEnd);
      window.removeEventListener("pointercancel", onTouchEnd);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("orientationchange", onViewport);
      el.style.top = el.style.height = el.style.bottom = "";
      el.style.removeProperty("--sheet-kb");
    };
  }, [root, scroller, enabled]);
}
