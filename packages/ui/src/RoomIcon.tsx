import type { SVGProps } from "react";

/**
 * Rooms: a mic stand under a spotlight. Drawn in the same two layers as the Solar duotone set (the light at half strength, the
 * fixture, mic and stand solid) and kept to shapes that survive 20px: nothing finer than a 1.6 stroke.
 */
export function IconRoom(props: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M8.8 6.2 19.5 12.5 12.5 19.5 6.2 8.8Z" opacity=".5" />
      <g transform="rotate(45 5.2 5.2)">
        <rect x="1.6" y="3" width="7.2" height="4.4" rx="1.6" />
      </g>
      <rect x="13.4" y="7" width="4.2" height="7.2" rx="2.1" />
      <path d="M15.5 14.2v5.6M11.8 21.2h7.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </svg>
  );
}
