// A message box with a WhatsApp formatting toolbar, keyboard shortcuts and an emoji picker.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type RefObject } from "react";
import { applyFormat, insertText, SAMPLE_VARS, shortcutOp, type Edit, type FormatOp, type TemplateVars } from "@spot/shared";
import { cx } from "../ui";
import { IconEye, IconPen } from "../icons";
import { Popover } from "../Popover";
import { EmojiPicker } from "./EmojiPicker";
import { TemplateBubble } from "./TemplatePreview";

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

const SHORT: Partial<Record<FormatOp, string>> = { strike: "Strike", code: "Code", mono: "Monospace", bullet: "Bullets", number: "Numbers" };

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
        if (focus && document.activeElement !== el) el.focus({ preventScroll: true });
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
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onFormat(t.op)}
            aria-label={t.label}
            title={t.keys ? `${t.label} (${t.keys})` : t.label}
            className="state-layer pressable touch-manipulation grid size-8 place-items-center rounded-sm text-sm text-on-surface-variant"
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
          <button type="button" onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()} onClick={toggle} aria-label="Emoji" aria-expanded={open} title="Emoji" className="state-layer pressable touch-manipulation grid size-8 place-items-center rounded-sm text-base">
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

/** A variable the page offers: `{{key}}` goes into the field. `hint` is a short plain-words description (what it fills in). */
export interface Variable {
  key: string;
  label: string;
  hint?: string;
}

/** What each common variable fills in, so the menu can say it in a few words. A page's own `hint` wins. */
const VARIABLE_HINTS: Record<string, string> = {
  name: "The comic's first name",
  show: "The show's name",
  venue: "The venue's name",
  day: "Day of the show, like Monday",
  date: "Date of the show, like 27 Oct",
  time: "When the show starts",
  minutes: "Set length, only if one is set",
  mapsLink: "A Google Maps link to the venue",
  lineup: "The running order, one comic per line",
  count: "How many comics are on the lineup",
  nextDate: "The date of next week's show",
  pocs: "The POCs, tagged in WhatsApp",
  shows: "Every active show",
  lastShow: "The last show they did",
  lastDate: "When they last did a show",
  opens: "When requests open",
  lastWhen: "When they were last up",
  askAgain: "When they can ask again",
};

/** What goes into the text for a variable ("minutes" wraps itself so nothing shows when no length is set). */
export const variableToken = (key: string) => (key === "minutes" ? "{{#minutes}}⏱ {{minutes}} min{{/minutes}}" : `{{${key}}}`);

/** A 36px icon button for a field's toolbar. Never takes focus or moves the selection from the box (iOS would zoom or jump). */
export function FieldIconButton({ label, active, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      aria-label={label}
      title={label}
      className={cx("state-layer pressable touch-manipulation grid size-9 flex-none place-items-center rounded-full text-on-surface-variant disabled:opacity-40", active && "bg-secondary-container text-on-secondary-container", className)}
      {...rest}
    >
      {children}
    </button>
  );
}

/** The eye / pen toggle pinned to a field's bottom-right corner. */
export function PreviewToggle({ previewing, onClick, className }: { previewing: boolean; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      // Pressing it must not move focus or the selection (iOS would zoom or jump).
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      aria-label={previewing ? "Edit message" : "Preview message"}
      aria-pressed={previewing}
      title={previewing ? "Edit" : "Preview"}
      data-preview-toggle
      className={cx("state-layer pressable touch-manipulation grid size-9 place-items-center rounded-full", previewing ? "bg-secondary-container text-on-secondary-container" : "text-on-surface-variant", className)}
    >
      {previewing ? <IconPen className="icon size-5" /> : <IconEye className="icon size-5" />}
    </button>
  );
}

const BraceGlyph = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden className={className} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 4.5c-2 0-3 1-3 3v2c0 1.2-.7 2-2 2.5 1.3.5 2 1.3 2 2.5v2c0 2 1 3 3 3M15 4.5c2 0 3 1 3 3v2c0 1.2.7 2 2 2.5-1.3.5-2 1.3-2 2.5v2c0 2-1 3-3 3" />
  </svg>
);

/** "{ }" button: a menu of the variables the page offers, each with what it fills in; picking one calls `onPick(key)`. */
export function VariableMenu({ variables, onPick, disabled, className }: { variables: readonly Variable[]; onPick: (key: string) => void; disabled?: boolean; className?: string }) {
  if (!variables.length) return null;
  return (
    <Popover
      title="Insert a variable"
      width={340}
      anchorClassName={cx("relative inline-flex flex-none", className)}
      trigger={(toggle, open) => (
        <FieldIconButton label="Insert a variable" active={open} aria-expanded={open} disabled={disabled} onClick={toggle}>
          <BraceGlyph className="size-5" />
        </FieldIconButton>
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-0.5">
          <p className="pb-1 type-body-s text-on-surface-variant">Filled in with the real value when the message goes out.</p>
          {variables.map((v) => (
            <button
              key={v.key}
              type="button"
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (onPick(v.key), close())}
              className="state-layer touch-manipulation flex min-h-12 w-full items-center gap-3 rounded-md px-2 py-1.5 text-left"
            >
              <span className="min-w-0 flex-1">
                <span className="block type-body-l">{v.label}</span>
                <span className="block type-body-s text-on-surface-variant">{v.hint ?? VARIABLE_HINTS[v.key] ?? "Filled in when it goes out"}</span>
              </span>
              <code className="flex-none rounded-xs bg-surface-high px-1.5 py-0.5 font-mono text-xs text-on-surface-variant">{`{{${v.key}}}`}</code>
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

/** "Aa" button: one popover with every format (bold, italic, strike, mono, quote, lists) and its keyboard shortcut. */
export function FormatMenu({ onFormat, disabled, className }: { onFormat: (op: FormatOp) => void; disabled?: boolean; className?: string }) {
  return (
    <Popover
      title="Format"
      width={300}
      anchorClassName={cx("relative inline-flex flex-none", className)}
      trigger={(toggle, open) => (
        <FieldIconButton label="Formatting" active={open} aria-expanded={open} disabled={disabled} onClick={toggle} className="type-label-l">
          Aa
        </FieldIconButton>
      )}
    >
      {(close) => (
        <div className="grid grid-cols-2 gap-1">
          {TOOLS.map((t) => (
            <button
              key={t.op}
              type="button"
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (onFormat(t.op), close())}
              title={t.keys ? `${t.label} (${t.keys})` : t.label}
              className="state-layer touch-manipulation flex min-h-11 items-center gap-2.5 rounded-md px-2 text-left type-body-m"
            >
              <span aria-hidden className="grid size-7 flex-none place-items-center rounded-sm bg-surface-high text-sm">
                {t.glyph}
              </span>
              <span className="min-w-0 truncate">{SHORT[t.op] ?? t.label}</span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

/** The emoji button: opens the picker, drops the emoji at the caret. */
export function EmojiMenu({ onPick, disabled, className }: { onPick: (emoji: string) => void; disabled?: boolean; className?: string }) {
  return (
    <Popover
      title="Emoji"
      width={328}
      anchorClassName={cx("relative inline-flex flex-none", className)}
      trigger={(toggle, open) => (
        <FieldIconButton label="Emoji" active={open} aria-expanded={open} disabled={disabled} onClick={toggle} className="text-base">
          <span aria-hidden>🙂</span>
        </FieldIconButton>
      )}
    >
      {() => <EmojiPicker onPick={onPick} />}
    </Popover>
  );
}

/**
 * The message box used by every editor, built like the chat composer: the text in the normal UI font at 16px, and inside the box a
 * bottom row of small icon buttons (Aa formats, emoji, {} variables, then whatever the page adds: a photo, templates) with the
 * eye / pen preview toggle pinned to the bottom-right corner. Previewing swaps the text for a WhatsApp bubble of the rendered message.
 */
export function RichField({
  value,
  onChange,
  rows = 4,
  id,
  placeholder,
  ariaLabel,
  className,
  onFocus,
  fieldRef,
  preview = true,
  previewing: controlled,
  previewVars,
  knownVars,
  onPreviewChange,
  variables,
  toolbarExtra,
  above,
  previewExtra,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  id?: string;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  onFocus?: () => void;
  fieldRef?: (el: HTMLTextAreaElement | null) => void;
  /** Offer the eye / pen toggle in the box's bottom-right corner (swaps the editor for a WhatsApp bubble of the rendered text). */
  preview?: boolean;
  /** Lets the page own the preview state (so a poll or pin can preview in the same mode). */
  previewing?: boolean;
  /** Values for the variables in the preview. Sample values fill in for any not given. */
  previewVars?: TemplateVars;
  /** Variable names the page offers, so they are never flagged as unknown. */
  knownVars?: readonly string[];
  /** Told when this field switches between editing and previewing. */
  onPreviewChange?: (previewing: boolean) => void;
  /** Variables the "{ }" button offers. */
  variables?: readonly Variable[];
  /** More icon buttons for the bottom row (a photo, templates). */
  toolbarExtra?: ReactNode;
  /** Shown inside the box above the bottom row (the attached photo's thumbnail). */
  above?: ReactNode;
  /** Shown under the text bubble while previewing (a venue pin that follows the text). */
  previewExtra?: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [own, setOwn] = useState(false);
  const showPreview = controlled ?? own;
  const height = useRef(0);
  const caret = useRef<[number, number] | null>(null);
  const { format, insert } = useTextEditing(ref, value, onChange);
  const minHeight = rows * 24 + 16;

  // The box grows with its text (never shorter than `rows`), up to about 14 lines.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || showPreview) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, minHeight), 344)}px`;
  }, [value, showPreview, minHeight]);

  const notify = useRef(onPreviewChange);
  notify.current = onPreviewChange;
  useEffect(() => () => notify.current?.(false), []);

  const toPreview = () => {
    const el = ref.current;
    height.current = el?.offsetHeight ?? 0;
    caret.current = el ? [el.selectionStart, el.selectionEnd] : null;
    setOwn(true);
    onPreviewChange?.(true);
  };
  const toEdit = () => {
    setOwn(false);
    onPreviewChange?.(false);
    // The textarea stayed mounted (hidden), so its text and selection are intact; put the caret back and focus it.
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      if (caret.current) el.setSelectionRange(caret.current[0], caret.current[1]);
    });
  };

  return (
    <div className={cx("relative flex min-w-0 flex-col rounded-xl border border-outline-variant bg-surface-container transition-[border-color] duration-150 focus-within:border-primary", className)}>
      <textarea
        ref={(el) => {
          ref.current = el;
          fieldRef?.(el);
        }}
        id={id}
        value={value}
        rows={rows}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onFocus={onFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
          const op = shortcutOp(e.key, e.shiftKey);
          if (!op) return;
          e.preventDefault();
          format(op);
        }}
        style={{ minHeight }}
        className={cx("block w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-base leading-6 text-on-surface outline-none placeholder:text-on-surface-variant/60", showPreview && "hidden")}
      />
      {showPreview && (
        <div style={{ minHeight: height.current || undefined }} aria-live="polite" className="flex flex-col gap-1.5 px-3 pb-1 pt-3">
          <TemplateBubble text={value} vars={previewVars ?? SAMPLE_VARS} known={knownVars} />
          {previewExtra}
        </div>
      )}
      {above && <div className="px-2.5 pb-1">{above}</div>}
      <div inert={showPreview} className={cx("flex min-h-12 flex-wrap items-center gap-0.5 px-1.5 pb-1.5 pt-0.5", preview && "pr-12", showPreview && "pointer-events-none opacity-40 transition-opacity")} role="toolbar" aria-label="Formatting and extras">
        <FormatMenu onFormat={format} />
        <EmojiMenu onPick={(e) => insert(e, false)} />
        {variables && <VariableMenu variables={variables} onPick={(k) => insert(variableToken(k))} />}
        {toolbarExtra}
      </div>
      {preview && <PreviewToggle previewing={showPreview} onClick={showPreview ? toEdit : toPreview} className="absolute bottom-2 right-2" />}
    </div>
  );
}
