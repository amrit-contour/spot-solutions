// WhatsApp-style rendering of a message, built as React nodes from the parsed tree. User text never goes
// through innerHTML, so nothing typed into a template can inject markup.
import type { ReactNode } from "react";
import { parseWhatsApp, splitMentions, type Block, type Inline, type MentionRef, type PollSpec } from "@spot/shared";
import { cx } from "../ui";
import { IconMap } from "../icons";

/** Someone tagged in the text, as WhatsApp shows it: their name, in colour, where the raw "@digits" were. */
export type WaMention = MentionRef;

/** Tapping a tag (when the page can open that person). */
export type OnMention = (m: MentionRef) => void;

/** Preview-only decoration: unknown {{variables}} (swapped for a marker by previewTemplate) and link underlining. */
export interface WaDeco {
  /** Names behind the \u2063<index>\u2063 markers in the text. */
  unknown?: string[];
  /** Underline links the way a chat does. */
  links?: boolean;
}

export const UNKNOWN_MARK = "\u2063";
const MARK_RE = /\u2063(\d+)\u2063/;
const URL_RE = /(https?:\/\/[^\s<]*[^\s<.,;:!?)\]'"])/;

function decorated(text: string, deco: WaDeco | undefined, mentions: WaMention[], onMention?: OnMention): ReactNode {
  if (!deco || (!deco.unknown?.length && !deco.links)) return withMentions(text, mentions, onMention);
  const out: ReactNode[] = [];
  text.split(MARK_RE).forEach((part, i) => {
    if (i % 2 === 1) {
      const name = deco.unknown?.[Number(part)] ?? part;
      out.push(
        <mark key={`u${i}`} data-unknown={name} title="Not a known variable, it will go out blank" className="rounded-xs bg-error-container px-1 font-mono text-[0.9em] text-on-error-container">
          {`{{${name}}}`}
        </mark>,
      );
    } else if (deco.links) {
      part.split(URL_RE).forEach((seg, j) => out.push(j % 2 === 1 ? <span key={`l${i}-${j}`} className="text-primary underline underline-offset-2">{seg}</span> : <span key={`t${i}-${j}`} className="contents">{withMentions(seg, mentions, onMention)}</span>));
    } else out.push(<span key={`t${i}`} className="contents">{withMentions(part, mentions, onMention)}</span>);
  });
  return out;
}

function withMentions(text: string, mentions: WaMention[], onMention?: OnMention): ReactNode {
  if (!mentions.length) return text;
  return splitMentions(text, mentions).map((s, i) => {
    if (s.t === "text") return s.v;
    const ref = mentions.find((m) => m.token === s.v)!;
    const cls = "mention rounded-xs bg-on-primary-container/10 px-0.5 font-medium text-primary";
    return onMention ? (
      <button key={i} type="button" onClick={() => onMention(ref)} className={cx(cls, "inline cursor-pointer align-baseline hover:underline")} data-mention={s.v}>
        @{s.name}
      </button>
    ) : (
      <span key={i} className={cls} data-mention={s.v}>
        @{s.name}
      </span>
    );
  });
}

function inline(nodes: Inline[], mentions: WaMention[], onMention?: OnMention, deco?: WaDeco): ReactNode {
  return nodes.map((n, i) => {
    if (n.t === "text") return mentions.length || deco ? <span key={i} className="contents">{decorated(n.v, deco, mentions, onMention)}</span> : n.v;
    if (n.t === "code") return <code key={i} className="rounded-xs bg-on-primary-container/10 px-1 font-mono text-[0.9em]">{n.v}</code>;
    const inner = inline(n.c, mentions, onMention, deco);
    return n.t === "b" ? <strong key={i}>{inner}</strong> : n.t === "i" ? <em key={i}>{inner}</em> : <s key={i}>{inner}</s>;
  });
}

function block(b: Block, i: number, mentions: WaMention[], onMention?: OnMention, deco?: WaDeco): ReactNode {
  switch (b.t) {
    case "p":
      // An empty line keeps its height, like in WhatsApp.
      return <div key={i} className="min-h-[1lh]">{b.c.length ? inline(b.c, mentions, onMention, deco) : null}</div>;
    case "quote":
      return (
        <div key={i} className="my-0.5 border-l-[3px] border-on-primary-container/30 pl-2.5 opacity-90">
          {b.lines.map((l, j) => (
            <div key={j} className="min-h-[1lh]">{inline(l, mentions, onMention, deco)}</div>
          ))}
        </div>
      );
    case "ul":
      return (
        <ul key={i} className="my-0.5 pl-1">
          {b.items.map((it, j) => (
            <li key={j} className="flex gap-2">
              <span aria-hidden>•</span>
              <span className="min-w-0">{inline(it, mentions, onMention, deco)}</span>
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={i} className="my-0.5 pl-1">
          {b.items.map((it, j) => (
            <li key={j} className="flex gap-2">
              <span aria-hidden className="tabular">{b.start + j}.</span>
              <span className="min-w-0">{inline(it, mentions, onMention, deco)}</span>
            </li>
          ))}
        </ol>
      );
    case "pre":
      return <pre key={i} className="my-0.5 whitespace-pre-wrap break-words font-mono text-[0.9em]">{deco?.unknown?.length ? b.v.replace(new RegExp(MARK_RE.source, "g"), (_, n) => `{{${deco.unknown?.[Number(n)] ?? n}}}`) : b.v}</pre>;
  }
}

export function WaText({ text, className, mentions = [], onMention, deco }: { text: string; className?: string; mentions?: WaMention[]; onMention?: OnMention; deco?: WaDeco }) {
  return <div className={cx("whitespace-normal break-words", className)}>{parseWhatsApp(text).map((b, i) => block(b, i, mentions, onMention, deco))}</div>;
}

/** A poll as WhatsApp shows it: the question, then the options with a circle (one answer) or a box (several). */
export function PollCard({ poll }: { poll: Pick<PollSpec, "question" | "options" | "multi"> }) {
  const options = poll.options.filter((o) => o.trim());
  return (
    <div className="min-w-56">
      <div className="font-medium">{poll.question.trim() || <span className="opacity-50">Your question</span>}</div>
      <div className="mt-0.5 type-label-s opacity-70">{poll.multi ? "Select one or more" : "Select one"}</div>
      <ul className="mt-2 flex flex-col gap-2">
        {options.map((o, i) => (
          <li key={i} className="flex items-center gap-2.5">
            <span aria-hidden className={cx("size-4.5 flex-none border-[1.5px] border-current opacity-60", poll.multi ? "rounded-xs" : "rounded-full")} />
            <span className="min-w-0 break-words">{o}</span>
          </li>
        ))}
        {options.length === 0 && <li className="opacity-50">Add at least two options</li>}
      </ul>
    </div>
  );
}

/** A location pin as a chat shows it. */
export function PinCard({ name, detail }: { name: string; detail?: string }) {
  return (
    <div className="-mx-1 -mt-0.5 min-w-56 overflow-hidden rounded-md bg-on-primary-container/10">
      <div className="grid h-16 place-items-center bg-on-primary-container/10 text-on-primary-container">
        <IconMap className="icon size-8" />
      </div>
      <div className="px-2.5 py-1.5">
        <div className="font-medium">{name}</div>
        {detail && <div className="type-label-s opacity-70">{detail}</div>}
      </div>
    </div>
  );
}
