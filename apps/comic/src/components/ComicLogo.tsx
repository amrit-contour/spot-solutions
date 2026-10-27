const DARK = "<rect width=\"512\" height=\"512\" rx=\"115\" fill=\"#000000\"/><g transform=\"translate(0 3)\"><rect x=\"186\" y=\"84\" width=\"140\" height=\"194\" rx=\"70\" fill=\"#7ED957\"/><g fill=\"none\" stroke=\"#FFFFFF\" stroke-width=\"34\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M153 160V208A103 103 0 0 0 359 208V160\"/><path d=\"M256 311V388\"/></g><rect x=\"176\" y=\"388\" width=\"160\" height=\"34\" rx=\"17\" fill=\"#FFFFFF\"/></g>";
const LIGHT = "<rect width=\"512\" height=\"512\" rx=\"115\" fill=\"#FFFFFF\"/><g transform=\"translate(0 3)\"><rect x=\"186\" y=\"84\" width=\"140\" height=\"194\" rx=\"70\" fill=\"#7ED957\"/><g fill=\"none\" stroke=\"#000000\" stroke-width=\"34\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M153 160V208A103 103 0 0 0 359 208V160\"/><path d=\"M256 311V388\"/></g><rect x=\"176\" y=\"388\" width=\"160\" height=\"34\" rx=\"17\" fill=\"#000000\"/></g><rect x=\"2\" y=\"2\" width=\"508\" height=\"508\" rx=\"113\" fill=\"none\" stroke=\"#000\" stroke-opacity=\".14\" stroke-width=\"4\"/>";
const CLASSIC = "<rect width=\"512\" height=\"512\" rx=\"115\" fill=\"#7A5416\"/><g transform=\"translate(0 3)\"><rect x=\"186\" y=\"84\" width=\"140\" height=\"194\" rx=\"70\" fill=\"#F2BC6E\"/><g fill=\"none\" stroke=\"#FFF8F4\" stroke-width=\"34\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M153 160V208A103 103 0 0 0 359 208V160\"/><path d=\"M256 311V388\"/></g><rect x=\"176\" y=\"388\" width=\"160\" height=\"34\" rx=\"17\" fill=\"#FFF8F4\"/></g>";

/**
 * Nothing BOT Comedy's mark (the mic-on-a-stand icon, rounded tiles of the final icon set, comedy-M3a). Which tile shows is pure CSS (see index.css), so it never flashes:
 * NBC brand: the light tile in a dark UI and the dark tile in a light UI, so the tile always contrasts with the page;
 * Classic brand: the brown tile.
 */
export function ComicLogo({ className }: { className?: string }) {
  const tile = (cls: string, art: string) => <svg viewBox="0 0 512 512" className={`${cls} size-full`} aria-hidden dangerouslySetInnerHTML={{ __html: art }} />;
  return (
    <span className={`cm-logo ${className ?? ""}`} aria-hidden>
      {tile("cm-logo-d", DARK)}
      {tile("cm-logo-l", LIGHT)}
      {tile("cm-logo-c", CLASSIC)}
    </span>
  );
}
