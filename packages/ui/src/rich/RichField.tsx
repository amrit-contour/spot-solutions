// A message box with a WhatsApp formatting toolbar, keyboard shortcuts and an emoji picker.
import { useCallback, useRef, useState, type ReactNode, type RefObject } from "react";
import { applyFormat, insertText, shortcutOp, type Edit, type FormatOp } from "@spot/shared";
import { Bubble, TextArea, cx } from "../ui";
import { Popover } from "../Popover";
import { EmojiPicker } from "./EmojiPicker";
import { WaText } from "./WaText";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";
const SHIFT = isMac ? "⇧" : "Shift+";

const TOOLS: { op: FormatOp; label: string; keys?: string; glyph: ReactNode; sep?: boolean }[] = [
  { op: "bold", label: "Bold", keys: `${MOD}B`, glyph: <span className="font-bold">B</span> },
  { op: "italic", label: "Italic", keys: `${MOD}I`, glyph: <span className="font-serif italic">I</span> },
  { op: "strike", label: "Strikethrough", keys: `${MOD}${SHIFT}X`, glyph: <span className="line-through">S</span> },
  { op: "code", label: "Inline code", keys: `${MOD}${SHIFT}E`, glyph: <span className="font-mono">`</span> },
  { op: "mono", label: "Monospace block", keys: `${MOD}${SHIFT}M`, glyph: <span className="font-mono text-[0.8rem]">{"</>"}</span> },
  { op: "quote", label: "Quote", keys: `${MOD}${SHIFT}9`, glyph: <span className="font-mono font-bold">{">"}</span>, sep: true },
  { op: "bullet", label: "Bulleted list", keys: `${MOD}${SHIFT}8`, glyph: <span>•</span> },
  { op: "number", label: "Numbered list", keys: `${MOD}${SHIFT}7`, glyph: <span className="tabular">1.</span> },
];

/** Edits a controlled textarea in place: applies a pure edit, then puts the selection where it says. */
export function useTextEditing(ref: RefObject<HTMLTextAreaElement | HTMLInputElement | null>, value: string, onChange: (v: string) => void) {
  const run = useCallback(
    (edit: (v: string, a: number, b: number) => Edit, focus = true) => {
      const el = ref.current;
      const a = el?.selectionStart ?? value.length;
      const b = el?.selectionEnd ?? value.length;
      const next = edit(value, a, b);
      onChange(next.value);
      requestAnimationFrame(() => {
        if (!el) return;
        if (focus) el.focus();
        el.setSelectionRange(next.start, next.end);
      });
    },
    [ref, value, onChange],
  );
  return {
    format: (op: FormatOp) => run((v, a, b) => applyFormat(v, a, b, op)),
    insert: (text: string, focus = true) => run((v, a, b) => insertText(v, a, b, text), focus),
  };
}

/** The formatting buttons (bold, italic, strike, mono, quote, lists) and the emoji picker. Used by RichField and the Messages composer. */
export function FormatBar({ onFormat, onEmoji, extra, className }: { onFormat: (op: FormatOp) => void; onEmoji: (emoji: string) => void; extra?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex flex-wrap items-center gap-0.5", className)} role="toolbar" aria-label="Formatting">
      {TOOLS.map((t) => (
        <span key={t.op} className="contents">
          {t.sep && <span aria-hidden className="mx-1 h-5 w-px bg-outline-variant" />}
          <button
            type="button"
            // Keep the selection in the box while the button is pressed.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onFormat(t.op)}
            aria-label={t.label}
            title={t.keys ? `${t.label} (${t.keys})` : t.label}
            className="state-layer pressable grid size-8 place-items-center rounded-sm text-sm text-on-surface-variant"
          >
            {t.glyph}
          </button>
        </span>
      ))}
      <span aria-hidden className="mx-1 h-5 w-px bg-outline-variant" />
      <Popover
        title="Emoji"
        width={328}
        trigger={(toggle, open) => (
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={toggle} aria-label="Emoji" aria-expanded={open} title="Emoji" className="state-layer pressable grid size-8 place-items-center rounded-sm text-base">
            <span aria-hidden>🙂</span>
          </button>
        )}
      >
        {() => <EmojiPicker onPick={onEmoji} />}
      </Popover>
      {extra}
    </div>
  );
}

export function RichField({
  value,
  onChange,
  rows = 4,
  id,
  placeholder,
  ariaLabel,
  className,
  mono,
  onFocus,
  fieldRef,
  preview = true,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  id?: string;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  /** Show the raw text in a monospace face (template editors, where {{variables}} matter). */
  mono?: boolean;
  onFocus?: () => void;
  fieldRef?: (el: HTMLTextAreaElement | null) => void;
  /** Offer a Preview toggle under the box (turn off where the page already shows a preview). */
  preview?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [showPreview, setShowPreview] = useState(false);
  const { format, insert } = useTextEditing(ref, value, onChange);

  return (
    <div className="flex flex-col gap-1.5">
      <FormatBar
        onFormat={format}
        onEmoji={(e) => insert(e, false)}
        extra={
          preview ? (
            <button
              type="button"
              onClick={() => setShowPreview((v) => !v)}
              aria-pressed={showPreview}
              className={cx("state-layer pressable ml-auto h-8 rounded-sm px-2.5 type-label-m", showPreview ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant")}
            >
              Preview
            </button>
          ) : null
        }
      />
      <TextArea
        ref={(el) => {
          ref.current = el;
          fieldRef?.(el);
        }}
        id={id}
        value={value}
        rows={rows}
        placeholder={placeholder}
        aria-label={ariaLabel}
        spellCheck={mono ? false : undefined}
        onFocus={onFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
          const op = shortcutOp(e.key, e.shiftKey);
          if (!op) return;
          e.preventDefault();
          format(op);
        }}
        className={cx("min-h-0", mono && "font-mono text-sm", className)}
      />
      {showPreview && (
        <Bubble outgoing>
          <WaText text={value} />
        </Bubble>
      )}
    </div>
  );
}
