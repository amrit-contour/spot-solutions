// "Installed" detection: the PWA opened from the home screen or dock, with no browser chrome around it.
// `?standalone=1` forces it for testing in a normal browser tab (it is only read, never stored).

const QUERIES = ["(display-mode: standalone)", "(display-mode: minimal-ui)", "(display-mode: window-controls-overlay)", "(display-mode: fullscreen)"];

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).has("standalone")) return true;
    // iOS Safari's home-screen apps expose navigator.standalone instead of the media query.
    if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
    return QUERIES.some((q) => window.matchMedia(q).matches);
  } catch {
    return false;
  }
}
