// The one preview used by every template editor: the message as the comic will read it. Variables are filled
// from sample (or real) values, conditional sections resolve, WhatsApp formatting and links show, and anything
// that is not a known variable is highlighted.
import { renderTemplate, SAMPLE_VARS, templateKeys, type TemplateVars } from "@spot/shared";
import { Bubble, cx } from "../ui";
import { UNKNOWN_MARK, WaText } from "./WaText";

/** The text with its variables filled in. Unknown {{names}} become markers WaText can highlight (they would go out blank). */
export function previewTemplate(text: string, vars: TemplateVars, known: readonly string[] = []): { text: string; unknown: string[] } {
  const ok = new Set([...Object.keys(vars), ...known]);
  const unknown = templateKeys(text).filter((k) => !ok.has(k));
  if (!unknown.length) return { text: renderTemplate(text, vars), unknown };
  const marked = text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (unknown.includes(k) ? `${UNKNOWN_MARK}${unknown.indexOf(k)}${UNKNOWN_MARK}` : m));
  return { text: renderTemplate(marked, vars), unknown };
}

/** Sample values for a preview, topped up with the page's real ones. */
export const previewVars = (extra?: TemplateVars): TemplateVars => ({ ...SAMPLE_VARS, ...extra });

/** What goes under a preview when something in the text is not a variable. */
export function UnknownNote({ unknown, className }: { unknown: string[]; className?: string }) {
  if (!unknown.length) return null;
  return (
    <p role="status" className={cx("type-label-s text-error", className)}>
      Not a known variable: {unknown.map((u) => `{{${u}}}`).join(", ")}. It will go out blank.
    </p>
  );
}

/** A WhatsApp-style outgoing bubble of the rendered template. */
export function TemplateBubble({ text, vars, known, meta = "9:41 PM" }: { text: string; vars: TemplateVars; known?: readonly string[]; meta?: string }) {
  const p = previewTemplate(text, vars, known);
  return (
    <div className="flex flex-col gap-1.5" data-template-preview>
      <Bubble outgoing meta={meta}>
        {p.text.trim() ? <WaText text={p.text} deco={{ unknown: p.unknown, links: true }} /> : <span className="opacity-50">Empty message</span>}
      </Bubble>
      <UnknownNote unknown={p.unknown} />
    </div>
  );
}
