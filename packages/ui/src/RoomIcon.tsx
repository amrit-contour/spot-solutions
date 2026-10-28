import type { SVGProps } from "react";

/**
 * Rooms / venues: a mic stand standing in a spotlight's beam. Two layers like the Solar duotone set: the beam at half strength,
 * the mic and stand solid, all in currentColor like every other icon. No lamp: the beam itself comes in from a narrow opening near the top-left
 * corner with a flat top edge and widens to a flat bottom on the floor line (y 22), reaching past the stand on the right but never past the 22 edge.
 * The mic sits in the middle of the light, a little right of centre, and everything stays inside the same 2..22 box as the
 * Solar bold icons beside it. Nothing finer than 1.8 units.
 */
export function IconRoom(props: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M5.2 2H8.2L22 22H6Z" opacity=".5" />
      <rect x="10.6" y="4.2" width="6.4" height="10.4" rx="3.2" />
      <rect x="12.9" y="13.6" width="1.8" height="7.2" />
      <rect x="8.3" y="19.6" width="11" height="2.4" rx="1.2" />
    </svg>
  );
}
