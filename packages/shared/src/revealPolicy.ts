/**
 * Decides whether a sheet may scroll or move itself to keep the focused field visible. iOS runs its own autoscroll and caret
 * magnifier while the user drags a caret or a selection; if the app scrolls at the same moment the two fight and the page
 * flickers or zooms. So nothing may move while a finger is down in a field, while text is selected, or right after the
 * selection changed (a handle drag fires no touch events on the page).
 */
export type RevealTrigger = "focus" | "input" | "viewport";

export const SELECTION_QUIET_MS = 350;

export function shouldReveal(s: { trigger: RevealTrigger; touching: boolean; selectionActive: boolean; msSinceSelectionChange: number }): boolean {
  if (s.touching || s.selectionActive) return false;
  // Typing moves the caret (a selectionchange each key), so only focus-less viewport noise is held back by recent selection.
  if (s.trigger === "viewport" && s.msSinceSelectionChange < SELECTION_QUIET_MS) return false;
  return true;
}
