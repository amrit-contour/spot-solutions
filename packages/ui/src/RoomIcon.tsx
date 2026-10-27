import type { SVGProps } from "react";

/**
 * Rooms: a mic stand under a spotlight. Two layers like the Solar duotone set: the beam in the brand's primary (lime in NBC) at half
 * strength, the fixture, mic and stand solid in currentColor. The beam widens from the fixture at 45° until it meets the floor, so its
 * bottom edge lies flat on the ground line; the pole ends inside the base so its rounded end never shows. Nothing finer than 1.6 units,
 * so it survives 20px.
 */
export function IconRoom(props: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M5.4 8.2 8.2 5.4 23.6 21.2 8.6 21.2Z" fill="var(--color-primary, currentColor)" opacity=".55" />
      <g transform="rotate(45 5 5)">
        <rect x="1.4" y="2.8" width="7.2" height="4.4" rx="1.6" />
      </g>
      <rect x="13.5" y="8.4" width="4" height="6.6" rx="2" />
      <rect x="14.7" y="14.4" width="1.6" height="6.6" />
      <rect x="11.3" y="19.8" width="8.4" height="2" rx="1" />
    </svg>
  );
}
