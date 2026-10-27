import type { SVGProps } from "react";

/**
 * Rooms: a mic stand under a spotlight. Two layers like the Solar duotone set: the beam at half strength, the fixture, mic and stand solid,
 * all in currentColor like every other icon. It fills the same 2..22 box as the Solar bold icons beside it (the fixture top-left at 45°,
 * a big mic head, a wide base) so it carries the same visual weight at 24px and 20px. The beam widens from the fixture until it meets
 * the floor, so its bottom edge lies flat on the ground line (y 22); the pole ends inside the base so its rounded end never shows.
 * Nothing finer than 1.8 units.
 */
export function IconRoom(props: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M7.7 11.6 11.6 7.7 22 14.8V22H12.8Z" opacity=".5" />
      <g transform="rotate(45 6.8 6.8)">
        <rect x="2.8" y="4" width="8" height="5.6" rx="1.8" />
      </g>
      <rect x="13.6" y="3.4" width="6.4" height="10.4" rx="3.2" />
      <rect x="15.9" y="13" width="1.8" height="8" />
      <rect x="11" y="19.6" width="11" height="2.4" rx="1.2" />
    </svg>
  );
}
