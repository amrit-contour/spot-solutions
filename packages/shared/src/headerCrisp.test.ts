// Guards the iPhone "blurry header" fix. iOS rasterises anything on a compositing layer at low resolution, so the pinned
// page header and the account avatar must never be transformed, scaled or animated with transform/opacity. Twice a later
// change brought that back (a scroll-linked header collapse, then a scale+opacity pulse on the status dot). These tests
// read the shared UI source and fail if either pattern returns.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ui = (f: string) => readFileSync(fileURLToPath(new URL(`../../ui/src/${f}`, import.meta.url)), "utf8");

/** The body of a CSS @keyframes block. */
function keyframes(css: string, name: string) {
  const start = css.indexOf(`@keyframes ${name}`);
  if (start < 0) return "";
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  return css.slice(start);
}

const noComments = (s: string) => s.replace(/\/\/.*$|\{\/\*[\s\S]*?\*\/\}|\/\*[\s\S]*?\*\//gm, "");

/** The source of the PageHeader component (up to the next top-level export). */
function pageHeader(src: string) {
  const start = src.indexOf("export function PageHeader");
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

describe("crisp header on iPhone", () => {
  it("the status pulse animates box-shadow only, never transform or opacity", () => {
    const k = keyframes(ui("styles.css"), "status-pulse");
    expect(k).toContain("box-shadow");
    expect(k).not.toMatch(/transform|opacity|scale|filter/);
  });

  it("the account avatar button has no press scale or transform", () => {
    const src = ui("AccountMenu.tsx");
    const trigger = noComments(src.slice(src.indexOf("trigger="), src.indexOf("{(close) =>")));
    expect(trigger).not.toMatch(/pressable|scale-|translate|will-change|transform/);
  });

  it("the page header has no scroll-linked transforms, scale, will-change or backdrop blur", () => {
    const h = noComments(pageHeader(ui("Shell.tsx")));
    expect(h).not.toMatch(/style\.transform|translate[XY3]?\(|scale\(|will-change|backdrop-blur|backdrop-filter/);
  });
});
