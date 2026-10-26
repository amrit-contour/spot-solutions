import { useBrand, NBC_GREEN, type Brand } from "../lib/theme";

// Classic: a mic standing in a spotlight. Uses theme roles so it follows light/dark.
function ClassicMark({ bg = "var(--md-sys-color-primary)", fg = "var(--md-sys-color-on-primary)" }: { bg?: string; fg?: string }) {
  return (
    <>
      <rect width="48" height="48" rx="14" fill={bg} />
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

// nbc. : outlined "n", solid "bc", green dot. Drawn as paths so it never depends on a font loading.
// Letters inherit `color` (currentColor); the dot is the brand green.
function NbcLetters({ strokeW = 2.6 }: { strokeW?: number }) {
  return (
    <>
      <path
        d="M1.3 36V14.3h5.2v2.2C8.6 14.8 11 14.3 14 14.3c6.6 0 11.7 3.9 11.7 11V36h-6.4V26.3c0-3.2-2.2-5.1-5.2-5.1-3.7 0-6.8 2-6.8 5.3V36z"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeW}
        strokeLinejoin="round"
      />
      <g transform="translate(33 0)" fill="none" stroke="currentColor" strokeWidth="7">
        <path d="M3.5 4V36" strokeLinecap="butt" />
        <circle cx="17.5" cy="25" r="7.5" />
        <path d="M47.6 19.5A7.5 7.5 0 1 0 47.6 30.5" />
      </g>
      <circle cx="90.5" cy="31.5" r="4.5" fill={NBC_GREEN} />
    </>
  );
}

export function NbcWordmark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 2 97 36" className={className} role="img" aria-label="nbc.">
      <NbcLetters strokeW={2.4} />
    </svg>
  );
}

function NbcMark({ bg = "var(--md-sys-color-inverse-surface)", fg = "var(--md-sys-color-inverse-on-surface)" }: { bg?: string; fg?: string }) {
  return (
    <>
      <rect width="48" height="48" rx="14" fill={bg} />
      <g transform="translate(3.4 15.2) scale(.44)" style={{ color: fg }}>
        <NbcLetters strokeW={3.2} />
      </g>
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
      {b === "nbc" ? (fixed ? <NbcMark bg="#0A0A0A" fg="#FFFFFF" /> : <NbcMark />) : fixed ? <ClassicMark bg="#7A5416" fg="#FFFFFF" /> : <ClassicMark />}
    </svg>
  );
}
