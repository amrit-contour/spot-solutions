/**
 * Nothing BOT Comedy's mark (the owner's mic-on-a-stand icon). Which tile shows is pure CSS (see index.css), so it never flashes:
 * NBC brand: the light tile in a dark UI and the dark tile in a light UI, so the tile always contrasts with the page;
 * Classic brand: the brown tile.
 */
export function ComicLogo({ className }: { className?: string }) {
  return (
    <span className={`cm-logo ${className ?? ""}`} aria-hidden>
      <svg viewBox="0 0 512 512" className="cm-logo-d size-full" aria-hidden>
        <clipPath id="cmd"><rect width="512" height="512" rx="112" /></clipPath>
        <g clipPath="url(#cmd)" dangerouslySetInnerHTML={{ __html: `<rect width="512" height="512" fill="#000000"/><g transform="translate(0 3)"><rect x="186" y="84" width="140" height="194" rx="70" fill="#7ED957"/><g fill="none" stroke="#FFFFFF" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"><path d="M153 160V208A103 103 0 0 0 359 208V160"/><path d="M256 311V388"/></g><rect x="176" y="388" width="160" height="34" rx="17" fill="#FFFFFF"/></g>` }} />
      </svg>
      <svg viewBox="0 0 512 512" className="cm-logo-l size-full" aria-hidden>
        <clipPath id="cml"><rect width="512" height="512" rx="112" /></clipPath>
        <g clipPath="url(#cml)" dangerouslySetInnerHTML={{ __html: `<rect width="512" height="512" fill="#FFFFFF"/><g transform="translate(0 3)"><rect x="186" y="84" width="140" height="194" rx="70" fill="#7ED957"/><g fill="none" stroke="#000000" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"><path d="M153 160V208A103 103 0 0 0 359 208V160"/><path d="M256 311V388"/></g><rect x="176" y="388" width="160" height="34" rx="17" fill="#000000"/></g><rect x="2" y="2" width="508" height="508" fill="none" stroke="#000" stroke-opacity=".14" stroke-width="4"/>` }} />
      </svg>
      <svg viewBox="0 0 512 512" className="cm-logo-c size-full" aria-hidden>
        <clipPath id="cmc"><rect width="512" height="512" rx="112" /></clipPath>
        <g clipPath="url(#cmc)" dangerouslySetInnerHTML={{ __html: `<rect width="512" height="512" fill="#7A5416"/><g transform="translate(0 3)"><rect x="186" y="84" width="140" height="194" rx="70" fill="#F2BC6E"/><g fill="none" stroke="#FFF8F4" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"><path d="M153 160V208A103 103 0 0 0 359 208V160"/><path d="M256 311V388"/></g><rect x="176" y="388" width="160" height="34" rx="17" fill="#FFF8F4"/></g>` }} />
      </svg>
    </span>
  );
}
