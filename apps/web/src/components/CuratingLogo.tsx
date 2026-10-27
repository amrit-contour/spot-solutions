import { useId } from "react";

// The Curating mark (people in a lineup, one picked out in green). Hand-drawn art from the final icon set (512 grid).
const FIG = (bg: string, fg: string, ring: string, pick: string) =>
  `<rect width="512" height="512" fill="${bg}"/><g transform="translate(254.00 355.50) scale(1.0374)"><g transform="translate(-180.00 -210.00) scale(1.7)"><g fill="${bg}" stroke="${bg}" stroke-width="9.41" stroke-linejoin="round"><circle cx="50" cy="27" r="21"/><path d="M6 123.5V86C6 66 26 56 50 56C74 56 94 66 94 86V123.5Z"/></g><g fill="${fg}"><circle cx="50" cy="27" r="21"/><path d="M6 123.5V86C6 66 26 56 50 56C74 56 94 66 94 86V123.5Z"/></g></g><g transform="translate(10.00 -210.00) scale(1.7)" fill="${bg}" stroke="${ring}" stroke-width="4.71" stroke-linecap="round" stroke-linejoin="round"><circle cx="50" cy="27" r="21"/><path d="M6 117.5V86C6 66 26 56 50 56C74 56 94 66 94 86V117.5"/></g><g transform="translate(-100.00 -200.00) scale(2.0)"><g fill="${bg}" stroke="${bg}" stroke-width="10.00" stroke-linejoin="round"><circle cx="50" cy="27" r="21"/><path d="M6 100V86C6 66 26 56 50 56C74 56 94 66 94 86V100Z"/></g><g fill="${pick}"><circle cx="50" cy="27" r="21"/><path d="M6 100V86C6 66 26 56 50 56C74 56 94 66 94 86V100Z"/></g></g></g>`;

const DARK = FIG("#000000", "#FFFFFF", "#FFFFFF", "#7ED957");
const LIGHT = FIG("#FFFFFF", "#000000", "#000000", "#7ED957") + `<rect x="2" y="2" width="508" height="508" fill="none" stroke="#000" stroke-opacity=".14" stroke-width="4"/>`;
const CLASSIC = FIG("#7A5416", "#FFF8F4", "#FFF8F4", "#F2BC6E");

/**
 * Nothing BOT Curating's mark. Which tile shows is pure CSS (see index.css), so it never flashes:
 * NBC brand: the light tile in a dark UI and the dark tile in a light UI, so the tile always contrasts with the page;
 * Classic brand: the brown tile. `brand` pins one (the Appearance preview): nbc = the dark tile, classic = brown.
 */
export function CuratingLogo({ className, brand }: { className?: string; brand?: "nbc" | "classic" }) {
  const id = useId().replace(/:/g, "");
  const tile = (cls: string, art: string) => (
    <svg viewBox="0 0 512 512" className={`${cls} size-full`} aria-hidden>
      <clipPath id={`${id}${cls}`}><rect width="512" height="512" rx="112" /></clipPath>
      <g clipPath={`url(#${id}${cls})`} dangerouslySetInnerHTML={{ __html: art }} />
    </svg>
  );
  if (brand) return <span className={`cu-logo ${className ?? ""}`} aria-hidden>{brand === "nbc" ? tile("", DARK) : tile("", CLASSIC)}</span>;
  return (
    <span className={`cu-logo ${className ?? ""}`} aria-hidden>
      {tile("cu-logo-d", DARK)}
      {tile("cu-logo-l", LIGHT)}
      {tile("cu-logo-c", CLASSIC)}
    </span>
  );
}
