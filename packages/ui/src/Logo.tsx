import { useBrand, NBC_GREEN, type Brand } from "./theme";

// Neutral default for the shell rail: a plain rounded tile in the brand's colours (r = 115 of 512, like the app icons) with one dot.
// Each app passes its own mark (CuratingLogo, ComicLogo) to AppShell; this is only the fallback, so no app-specific art lives here.
const TILES: Record<Brand, { bg: string; dot: string }> = {
  nbc: { bg: "#000000", dot: NBC_GREEN },
  classic: { bg: "#7A5416", dot: "#F2BC6E" },
};

/** Follows the user's brand. Pass `brand` to force one. */
export function Logo({ className, brand }: { className?: string; brand?: Brand }) {
  const active = useBrand();
  const t = TILES[brand ?? active];
  return (
    <svg viewBox="0 0 512 512" className={className} aria-hidden>
      <rect width="512" height="512" rx="115" fill={t.bg} />
      <circle cx="256" cy="256" r="72" fill={t.dot} />
    </svg>
  );
}
