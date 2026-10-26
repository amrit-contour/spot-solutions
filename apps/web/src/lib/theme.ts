// Generates the full Material 3 colour scheme from one seed and writes it as CSS variables.
import { useSyncExternalStore } from "react";
import { Hct, MaterialDynamicColors, SchemeTonalSpot, argbFromHex, hexFromArgb } from "@material/material-color-utilities";

export const SEED = "#E8A33D"; // marigold spotlight

const ROLES = [
  "primary", "onPrimary", "primaryContainer", "onPrimaryContainer",
  "secondary", "onSecondary", "secondaryContainer", "onSecondaryContainer",
  "tertiary", "onTertiary", "tertiaryContainer", "onTertiaryContainer",
  "error", "onError", "errorContainer", "onErrorContainer",
  "surface", "onSurface", "onSurfaceVariant", "surfaceDim", "surfaceBright",
  "surfaceContainerLowest", "surfaceContainerLow", "surfaceContainer", "surfaceContainerHigh", "surfaceContainerHighest",
  "outline", "outlineVariant", "inverseSurface", "inverseOnSurface", "inversePrimary", "scrim", "shadow",
] as const;

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function vars(seed: string, dark: boolean) {
  const scheme = new SchemeTonalSpot(Hct.fromInt(argbFromHex(seed)), dark, 0, "2025");
  const m = new MaterialDynamicColors() as unknown as Record<string, () => { getArgb: (s: unknown) => number }>;
  return ROLES.map((r) => `--md-sys-color-${kebab(r)}:${hexFromArgb(m[r]().getArgb(scheme))};`).join("");
}

export type ThemeMode = "system" | "light" | "dark";

export type Brand = "nbc" | "classic";
export const BRANDS: Brand[] = ["nbc", "classic"];

// NBC (Nothing But Comedy): true neutrals plus one lime accent. Light mode uses a darker green for primary so
// green text and filled buttons pass WCAG AA on white; the brand lime lives in the containers and in dark mode.
export const NBC_GREEN = "#7ED957";
const NBC_LIGHT: Record<(typeof ROLES)[number], string> = {
  primary: "#2A6F13", onPrimary: "#FFFFFF", primaryContainer: NBC_GREEN, onPrimaryContainer: "#000000",
  secondary: "#3F3F3F", onSecondary: "#FFFFFF", secondaryContainer: "#E6E6E6", onSecondaryContainer: "#0A0A0A",
  tertiary: "#454545", onTertiary: "#FFFFFF", tertiaryContainer: "#D4D4D4", onTertiaryContainer: "#0A0A0A",
  error: "#B3261E", onError: "#FFFFFF", errorContainer: "#F9DEDC", onErrorContainer: "#410E0B",
  surface: "#FFFFFF", onSurface: "#0A0A0A", onSurfaceVariant: "#5C5C5C", surfaceDim: "#E0E0E0", surfaceBright: "#FFFFFF",
  surfaceContainerLowest: "#FFFFFF", surfaceContainerLow: "#F7F7F7", surfaceContainer: "#F1F1F1", surfaceContainerHigh: "#EBEBEB", surfaceContainerHighest: "#E5E5E5",
  outline: "#767676", outlineVariant: "#D6D6D6", inverseSurface: "#0A0A0A", inverseOnSurface: "#F5F5F5", inversePrimary: NBC_GREEN, scrim: "#000000", shadow: "#000000",
};
const NBC_DARK: Record<(typeof ROLES)[number], string> = {
  primary: NBC_GREEN, onPrimary: "#000000", primaryContainer: "#1F4A12", onPrimaryContainer: "#B4F28E",
  secondary: "#C8C8C8", onSecondary: "#000000", secondaryContainer: "#262626", onSecondaryContainer: "#F2F2F2",
  tertiary: "#BDBDBD", onTertiary: "#000000", tertiaryContainer: "#333333", onTertiaryContainer: "#F5F5F5",
  error: "#F2B8B5", onError: "#601410", errorContainer: "#8C1D18", onErrorContainer: "#F9DEDC",
  surface: "#0A0A0A", onSurface: "#F2F2F2", onSurfaceVariant: "#A8A8A8", surfaceDim: "#050505", surfaceBright: "#2A2A2A",
  surfaceContainerLowest: "#000000", surfaceContainerLow: "#101010", surfaceContainer: "#161616", surfaceContainerHigh: "#1E1E1E", surfaceContainerHighest: "#272727",
  outline: "#7A7A7A", outlineVariant: "#2E2E2E", inverseSurface: "#F2F2F2", inverseOnSurface: "#0A0A0A", inversePrimary: "#2A6F13", scrim: "#000000", shadow: "#000000",
};
// Extra roles outside the M3 set: the connected/online dot, and the active pill in the nav.
const EXTRA = {
  classic: { light: "--md-sys-color-ok:#3fb950;--md-sys-color-nav-active:var(--md-sys-color-secondary-container);--md-sys-color-on-nav-active:var(--md-sys-color-on-secondary-container);", dark: "" },
  nbc: {
    light: `--md-sys-color-ok:#3DA32A;--md-sys-color-nav-active:${NBC_GREEN};--md-sys-color-on-nav-active:#000000;`,
    dark: `--md-sys-color-ok:${NBC_GREEN};--md-sys-color-nav-active:${NBC_GREEN};--md-sys-color-on-nav-active:#000000;`,
  },
};
const nbcVars = (t: Record<string, string>) => ROLES.map((r) => `--md-sys-color-${kebab(r)}:${t[r]};`).join("");

export function installTheme(seed = SEED) {
  const light = vars(seed, false) + EXTRA.classic.light;
  const dark = vars(seed, true);
  const nbcLight = nbcVars(NBC_LIGHT) + EXTRA.nbc.light;
  const nbcDark = nbcVars(NBC_DARK) + EXTRA.nbc.dark;
  let el = document.getElementById("md-theme") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "md-theme";
    document.head.appendChild(el);
  }
  el.textContent = `:root{${light}color-scheme:light}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${dark}color-scheme:dark}}
:root[data-theme="dark"]{${dark}color-scheme:dark}
:root[data-brand="nbc"]{${nbcLight}color-scheme:light}
@media (prefers-color-scheme: dark){:root[data-brand="nbc"]:not([data-theme="light"]){${nbcDark}color-scheme:dark}}
:root[data-brand="nbc"][data-theme="dark"]{${nbcDark}color-scheme:dark}`;
}

export function setMode(mode: ThemeMode) {
  const root = document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
  try {
    localStorage.setItem("theme", mode);
  } catch {
    /* private mode */
  }
  syncThemeColor();
}

export function savedMode(): ThemeMode {
  try {
    return (localStorage.getItem("theme") as ThemeMode) || "system";
  } catch {
    return "system";
  }
}

// ---- Brand (NBC / Classic) ----

const BRAND_KEY = "brand";
const THEME_COLOR: Record<Brand, { light: string; dark: string }> = {
  classic: { light: "#fff8f4", dark: "#19120c" },
  nbc: { light: "#ffffff", dark: "#0a0a0a" },
};

/** Cached choice so the first paint matches. With no cache (first visit, signed out) the public pages stay Classic. */
export function savedBrand(): Brand {
  try {
    const b = localStorage.getItem(BRAND_KEY);
    return b === "nbc" || b === "classic" ? b : "classic";
  } catch {
    return "classic";
  }
}

let current: Brand = "classic";
const listeners = new Set<() => void>();

/** Keeps <meta name="theme-color"> in step with the brand and any forced light/dark mode. */
function syncThemeColor() {
  const c = THEME_COLOR[current];
  const forced = document.documentElement.getAttribute("data-theme");
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  const add = (content: string, media?: string) => {
    const m = document.createElement("meta");
    m.name = "theme-color";
    m.content = content;
    if (media) m.media = media;
    document.head.appendChild(m);
  };
  if (forced === "light") add(c.light);
  else if (forced === "dark") add(c.dark);
  else {
    add(c.light, "(prefers-color-scheme: light)");
    add(c.dark, "(prefers-color-scheme: dark)");
  }
}

export function setBrand(brand: Brand, opts: { persist?: boolean; animate?: boolean } = {}) {
  const root = document.documentElement;
  if (brand === current && root.dataset.brand === brand) return;
  // A short colour cross-fade, skipped for reduced motion and for the very first paint.
  if (opts.animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    root.classList.add("brand-fade");
    setTimeout(() => root.classList.remove("brand-fade"), 400);
  }
  current = brand;
  root.dataset.brand = brand;
  if (opts.persist !== false) {
    try {
      localStorage.setItem(BRAND_KEY, brand);
    } catch {
      /* private mode */
    }
  }
  syncThemeColor();
  syncBrandIcons(brand);
  listeners.forEach((l) => l());
}

/**
 * Tab icon, home-screen icon and install manifest follow the brand. An app already on the home screen keeps
 * the icon it was installed with (phones save it at install); a new install picks up the current brand.
 */
function syncBrandIcons(brand: Brand) {
  const nbc = brand === "nbc";
  const set = (sel: string, href: string) => document.querySelectorAll<HTMLLinkElement>(sel).forEach((l) => l.getAttribute("href") !== href && l.setAttribute("href", href));
  set('link[rel="icon"]', nbc ? "/favicon-nbc.svg" : "/favicon.svg");
  set('link[rel="apple-touch-icon"]', nbc ? "/icons/nbc/apple-touch-icon.png" : "/icons/apple-touch-icon.png");
  set('link[rel="manifest"]', nbc ? "/manifest-nbc.webmanifest" : "/manifest.webmanifest");
}

export function useBrand(): Brand {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    () => current,
  );
}
