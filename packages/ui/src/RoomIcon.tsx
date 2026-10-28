import { useId, type SVGProps } from "react";

/**
 * Rooms / venues: a mic stand standing in a spotlight's beam. Two layers like the Solar duotone set: the beam at half strength,
 * the mic and stand solid, all in currentColor like every other icon. No lamp: the beam comes in from a narrow opening right
 * at the top-left corner and widens to a flat bottom on the floor line (y 22), its left edge landing just beside the mic base
 * and its right edge reaching past the stand, never past the 22 edge. The mic head has three grille slots cut out of it (a
 * mask, so the page shows through on any background). Everything stays inside the same 2..22 box as the Solar bold icons.
 */
export function IconRoom(props: SVGProps<SVGSVGElement>) {
  const grille = `room-grille-${useId().replace(/:/g, "")}`;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <defs>
        <mask id={grille}>
          <rect width="24" height="24" fill="white" />
          <rect x="12.2" y="6.6" width="3.2" height="1" rx=".5" fill="black" />
          <rect x="12.2" y="8.6" width="3.2" height="1" rx=".5" fill="black" />
          <rect x="12.2" y="10.6" width="3.2" height="1" rx=".5" fill="black" />
        </mask>
      </defs>
      <path d="M2 2H4.6L21.6 22H6.6Z" opacity=".5" />
      <rect x="10.6" y="4.2" width="6.4" height="10.4" rx="3.2" mask={`url(#${grille})`} />
      <rect x="12.9" y="13.6" width="1.8" height="7.2" />
      <rect x="8.3" y="19.6" width="11" height="2.4" rx="1.2" />
    </svg>
  );
}
