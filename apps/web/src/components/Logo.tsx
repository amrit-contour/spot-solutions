// A mic standing in a spotlight. Uses theme roles so it follows light/dark.
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <rect width="48" height="48" rx="14" fill="var(--md-sys-color-primary)" />
      <path d="M19 0h10l9 42H10z" fill="var(--md-sys-color-on-primary)" opacity=".13" />
      <ellipse cx="24" cy="40.5" rx="12" ry="2.6" fill="var(--md-sys-color-on-primary)" opacity=".25" />
      <rect x="18.5" y="9" width="11" height="17" rx="5.5" fill="var(--md-sys-color-on-primary)" />
      <rect x="21" y="14" width="6" height="1.8" rx=".9" fill="var(--md-sys-color-primary)" />
      <rect x="21" y="17.6" width="6" height="1.8" rx=".9" fill="var(--md-sys-color-primary)" />
      <path d="M15 21a9 9 0 0 0 18 0" fill="none" stroke="var(--md-sys-color-on-primary)" strokeWidth="2.4" strokeLinecap="round" />
      <rect x="22.8" y="30" width="2.4" height="9" rx="1.2" fill="var(--md-sys-color-on-primary)" />
    </svg>
  );
}
