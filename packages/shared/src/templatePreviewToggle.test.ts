// Guards the in-field Preview toggle on template editors: eye / pen icon button bottom-right, labelled, touch-safe,
// the editor stays mounted (hidden) so text and caret survive, and one shared bubble renders it with unknown variables flagged.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const read = (f: string) => readFileSync(fileURLToPath(new URL(`../../ui/src/rich/${f}`, import.meta.url)), "utf8");
const field = read("RichField.tsx");
const composer = read("MessageComposer.tsx");
const preview = read("TemplatePreview.tsx");

it("the toggle is an eye/pen icon button with a label, tooltip, touch-manipulation and pointerdown preventDefault", () => {
  const btn = field.slice(field.indexOf("data-preview-toggle") - 700, field.indexOf("data-preview-toggle") + 400);
  expect(btn).toMatch(/onPointerDown=\{\(e\) => e\.preventDefault\(\)\}/);
  expect(btn).toMatch(/aria-label=\{showPreview \? "Edit message" : "Preview message"\}/);
  expect(btn).toMatch(/title=/);
  expect(btn).toMatch(/touch-manipulation/);
  expect(btn).toMatch(/bottom-1\.5 right-5/);
  expect(field).toMatch(/IconPen/);
  expect(field).toMatch(/IconEye/);
});

it("switching keeps the text and caret: the textarea is hidden, not unmounted", () => {
  expect(field).toMatch(/showPreview && "hidden"/);
  expect(field).toMatch(/setSelectionRange\(caret\.current\[0\], caret\.current\[1\]\)/);
});

it("the composer's side preview and the in-field preview share one renderer, and chips park while previewing", () => {
  expect(field).toMatch(/TemplateBubble/);
  expect(composer).toMatch(/TemplateBubble/);
  expect(composer).toMatch(/hidden lg:flex/);
  expect(composer).toMatch(/disabled=\{previewing\}/);
  expect(preview).toMatch(/links: true/);
  expect(preview).toMatch(/Not a known variable/);
});

it("keeps the iOS behaviours from the field refactor", () => {
  expect(composer).toMatch(/onPointerDown=\{\(e\) => e\.preventDefault\(\)\}[^>]*onMouseDown/);
});
