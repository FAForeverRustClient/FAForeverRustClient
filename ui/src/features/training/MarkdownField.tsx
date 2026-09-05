// A Markdown field with a toolbar and a preview.
//
// Small on purpose. The destination is the FAF forum, which has its own
// composer, so this does not need to be an editor: it needs to let someone
// write a guide without remembering Markdown syntax, and show them that their
// headings and lists came out as headings and lists. Everything past that
// belongs to the forum.
//
// The toolbar wraps the current selection rather than inserting placeholders,
// because that is the operation people actually reach for: select a phrase,
// press bold.

import { useRef, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { useTranslation } from "../../i18n/useTranslation";
import { Markdown } from "./markdown";

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  ownPreview?: boolean;
}

/** What a toolbar button does to the selected range. */
type Action =
  | { kind: "wrap"; before: string; after: string }
  | { kind: "prefix"; prefix: string };

// Glyphs rather than icons: the design system has no bold or italic mark, and
// three identical pencils would say less than the letters do. `as const`
// matters because the ids are message-key fragments, and a widened `string`
// would make `training.editor.${id}` unresolvable as a key.
const ACTIONS = [
  { id: "bold", action: { kind: "wrap", before: "**", after: "**" }, glyph: "B" },
  { id: "italic", action: { kind: "wrap", before: "_", after: "_" }, glyph: "I" },
  { id: "code", action: { kind: "wrap", before: "`", after: "`" }, glyph: "{ }" },
  { id: "heading", action: { kind: "prefix", prefix: "## " }, glyph: "H" },
  { id: "bullet", action: { kind: "prefix", prefix: "- " }, glyph: "L" },
] as const satisfies readonly { id: string; action: Action; glyph: string }[];

/**
 * Apply `action` to `value` over `[start, end)`.
 *
 * Pure and exported so the behaviour is testable without a DOM: the selection
 * arithmetic is the only part of this component that can be wrong in a way
 * nobody notices, because a prefix applied to the wrong line still looks like
 * a working button.
 */
export function applyAction(
  value: string,
  start: number,
  end: number,
  action: Action,
): { value: string; start: number; end: number } {
  if (action.kind === "wrap") {
    const selected = value.slice(start, end);
    const next = `${value.slice(0, start)}${action.before}${selected}${action.after}${value.slice(end)}`;
    return {
      value: next,
      start: start + action.before.length,
      end: end + action.before.length,
    };
  }

  // A prefix belongs to whole lines, so the range grows to the line the caret
  // is on even when nothing is selected.
  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const lineEndIndex = value.indexOf("\n", end);
  const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
  const lines = value.slice(lineStart, lineEnd).split("\n");
  const prefixed = lines.map((line) => `${action.prefix}${line}`).join("\n");
  const next = `${value.slice(0, lineStart)}${prefixed}${value.slice(lineEnd)}`;
  return {
    value: next,
    start: start + action.prefix.length,
    end: end + action.prefix.length * lines.length,
  };
}

export function MarkdownField({
  label,
  value,
  onChange,
  placeholder,
  rows = 8,
  /**
   * Whether this field owns a preview of its own.
   *
   * Off where a preview is already on screen beside the editor: the toggle
   * would then only ever hide something the author is looking at. The
   * formatting toolbar is unaffected either way, which is the point of the two
   * being separable at all.
   */
  ownPreview = true,
}: Props) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const run = (action: Action) => {
    const area = areaRef.current;
    if (!area) return;
    const next = applyAction(value, area.selectionStart, area.selectionEnd, action);
    onChange(next.value);
    // Restore the selection after React has rewritten the value, otherwise the
    // caret jumps to the end and the next press formats the wrong thing.
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(next.start, next.end);
    });
  };

  return (
    <div className="training-markdown-field">
      <div className="training-markdown-head">
        <span>{label}</span>
        <div className="training-markdown-tools">
          {ACTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              title={t(`training.editor.${entry.id}`)}
              aria-label={t(`training.editor.${entry.id}`)}
              onClick={() => run(entry.action)}
            >
              <span aria-hidden>{entry.glyph}</span>
            </button>
          ))}
          {ownPreview && (
            <Button onClick={() => setPreview(!preview)}>
              <Icon name="eye" size={13} />{" "}
              {t(preview ? "training.editor.write" : "training.editor.preview")}
            </Button>
          )}
        </div>
      </div>

      {ownPreview && preview ? (
        value.trim() === "" ? (
          <p className="muted training-markdown-empty">{t("training.editor.nothingYet")}</p>
        ) : (
          <Markdown source={value} className="training-markdown-preview" />
        )
      ) : (
        <textarea
          ref={areaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          rows={rows}
        />
      )}
      <p className="muted training-markdown-hint">{t("training.editor.hint")}</p>
    </div>
  );
}
