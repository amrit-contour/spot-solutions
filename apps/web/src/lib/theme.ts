// Generates the full Material 3 colour scheme from one seed and writes it as CSS variables.
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

export function installTheme(seed = SEED) {
  const light = vars(seed, false);
  const dark = vars(seed, true);
  let el = document.getElementById("md-theme") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "md-theme";
    document.head.appendChild(el);
  }
  el.textContent = `:root{${light}color-scheme:light}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${dark}color-scheme:dark}}
:root[data-theme="dark"]{${dark}color-scheme:dark}`;
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
}

export function savedMode(): ThemeMode {
  try {
    return (localStorage.getItem("theme") as ThemeMode) || "system";
  } catch {
    return "system";
  }
}
