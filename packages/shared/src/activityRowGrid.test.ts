// Guards the Activity row layout: one grid (icon | text block | time), everything vertically centred, subtext below the title.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const src = readFileSync(fileURLToPath(new URL("../../../apps/web/src/components/ShowCardParts.tsx", import.meta.url)), "utf8");

it("every Activity row uses the same centred three-column grid", () => {
  const li = src.slice(src.indexOf("<li key={r.key}"), src.indexOf("</li>", src.indexOf("<li key={r.key}")));
  expect(li).toMatch(/grid-cols-\[2rem_minmax\(0,1fr\)_auto\]/);
  expect(li).toMatch(/items-center/);
  expect(li).not.toMatch(/mt-0\.5|items-start|items-baseline/); // no nudges to fake alignment
  expect(li).toMatch(/<p className="type-body-m[^"]*">\{r\.text\}<\/p>[\s\S]*type-body-s/); // title first, subtext below
});
