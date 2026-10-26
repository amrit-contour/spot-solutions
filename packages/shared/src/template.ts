// Tiny mustache-style renderer for ack + confirmation messages.
//   {{name}}               -> variable
//   {{#minutes}}...{{/minutes}} -> section, rendered only when `minutes` is truthy
//   {{^minutes}}...{{/minutes}} -> inverted section, rendered when falsy

export type TemplateVars = Record<string, string | number | null | undefined>;

export const TEMPLATE_VARIABLES = [
  { key: "name", label: "Comic name", sample: "Rohan" },
  { key: "show", label: "Show", sample: "Monday Mic" },
  { key: "venue", label: "Venue", sample: "The Laugh Store" },
  { key: "day", label: "Day", sample: "Monday" },
  { key: "date", label: "Date", sample: "27 Oct" },
  { key: "time", label: "Start time", sample: "8:30 PM" },
  { key: "minutes", label: "Set length", sample: 5 },
  { key: "mapsLink", label: "Maps link", sample: "https://maps.app.goo.gl/xyz" },
] as const;

export const SAMPLE_VARS: TemplateVars = Object.fromEntries(
  TEMPLATE_VARIABLES.map((v) => [v.key, v.sample]),
);

export const DEFAULT_ACK_TEMPLATE =
  "Hey {{name}}! Got your spot request 🙌 Will get back with confirmation.";

export const DEFAULT_REJECT_TEMPLATE =
  "Hey {{name}}, sorry, there are no spots available for you this week. Hope to see you up there next week! 🙏";

export const DEFAULT_CANCEL_SPOT_TEMPLATE =
  "Hey {{name}}, sorry, I've had to take you off {{show}} on {{day}} {{date}}. Your spot is cancelled. Hope to see you up there soon! 🙏";

export const DEFAULT_CONFIRM_TEMPLATE =
  "Hey {{name}}, you're on! 🎤\n{{show}} · {{day}} {{date}}, {{time}}\n📍 {{venue}}{{#minutes}}\n⏱ {{minutes}} min set{{/minutes}}{{#mapsLink}}\n{{mapsLink}}{{/mapsLink}}";

const present = (v: unknown) => v !== undefined && v !== null && v !== "" && v !== 0 && v !== false;

export function renderTemplate(template: string, vars: TemplateVars): string {
  const sections = /\{\{([#^])\s*(\w+)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g;
  let out = template;
  // Loop handles nested sections from the inside out.
  for (let i = 0; i < 5 && sections.test(out); i++) {
    sections.lastIndex = 0;
    out = out.replace(sections, (_, kind: string, key: string, inner: string) => {
      const show = kind === "#" ? present(vars[key]) : !present(vars[key]);
      return show ? inner : "";
    });
  }
  return out
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
      const v = vars[key];
      return v === undefined || v === null ? "" : String(v);
    })
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function templateKeys(template: string): string[] {
  return [...new Set([...template.matchAll(/\{\{[#^/]?\s*(\w+)\s*\}\}/g)].map((m) => m[1]))];
}
