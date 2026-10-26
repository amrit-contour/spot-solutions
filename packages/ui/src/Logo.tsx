import { useBrand, NBC_GREEN, type Brand } from "./theme";

const NBC_BLACK = "#000000";

// Classic: a mic standing in a spotlight. Uses theme roles so it follows light/dark.
// NBC uses the same mark in the club's colours: highlighter-green mic on black.
function ClassicMark({ bg = "var(--md-sys-color-primary)", fg = "var(--md-sys-color-on-primary)", ring }: { bg?: string; fg?: string; ring?: boolean }) {
  return (
    <>
      <rect width="48" height="48" rx="14" fill={bg} />
      {/* A hairline so a black tile still reads on a near-black page. */}
      {ring && <rect x=".5" y=".5" width="47" height="47" rx="13.5" fill="none" stroke="#ffffff" strokeOpacity=".14" />}
      <path d="M19 0h10l9 42H10z" fill={fg} opacity=".13" />
      <ellipse cx="24" cy="40.5" rx="12" ry="2.6" fill={fg} opacity=".25" />
      <rect x="18.5" y="9" width="11" height="17" rx="5.5" fill={fg} />
      <rect x="21" y="14" width="6" height="1.8" rx=".9" fill={bg} />
      <rect x="21" y="17.6" width="6" height="1.8" rx=".9" fill={bg} />
      <path d="M15 21a9 9 0 0 0 18 0" fill="none" stroke={fg} strokeWidth="2.4" strokeLinecap="round" />
      <rect x="22.8" y="30" width="2.4" height="9" rx="1.2" fill={fg} />
    </>
  );
}

/** Follows the user's brand. Pass `brand` to force one in fixed light colours (Appearance picker preview). */
export function Logo({ className, brand }: { className?: string; brand?: Brand }) {
  const active = useBrand();
  const b = brand ?? active;
  const fixed = brand !== undefined;
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      {b === "nbc" ? <ClassicMark bg={NBC_BLACK} fg={NBC_GREEN} ring /> : fixed ? <ClassicMark bg="#7A5416" fg="#FFFFFF" /> : <ClassicMark />}
    </svg>
  );
}
