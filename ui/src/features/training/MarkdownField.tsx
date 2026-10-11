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

import { useRef, useState, type ReactNode } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { Markdown, type FigureAlign } from "./markdown";

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  ownPreview?: boolean;
  /**
   * Take pictures the author picked, pasted or dropped, and answer with the
   * Markdown to insert where the caret is. Absent where a field has nowhere to
   * send a picture, and then the field offers none.
   */
  onAttach?: (files: File[]) => string;
  /** The file types `onAttach` takes, for the picker. */
  accept?: string;
}

/** What a toolbar button does to the selected range. */
type Action =
  | { kind: "wrap"; before: string; after: string }
  | { kind: "prefix"; prefix: string }
  /** Each line a numbered step: `1. `, `2. `, ... */
  | { kind: "numbered" }
  /** The selection as keys: `alt+right click` becomes two caps joined by a plus. */
  | { kind: "keys" };

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
  { id: "numbered", action: { kind: "numbered" }, glyph: "1." },
  { id: "key", action: { kind: "keys" }, glyph: "\u2328" },
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
  if (action.kind === "keys") {
    const selected = value.slice(start, end);
    if (selected.trim() === "") {
      const next = `${value.slice(0, start)}<kbd></kbd>${value.slice(end)}`;
      return { value: next, start: start + 5, end: start + 5 };
    }
    const keys = selected
      .split("+")
      .map((key) => key.trim())
      .filter(Boolean)
      .map((key) => `<kbd>${key}</kbd>`)
      .join("+");
    const next = `${value.slice(0, start)}${keys}${value.slice(end)}`;
    return { value: next, start, end: start + keys.length };
  }

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
  const prefixOf = (index: number) =>
    action.kind === "numbered" ? `${index + 1}. ` : action.prefix;
  const prefixed = lines.map((line, index) => `${prefixOf(index)}${line}`).join("\n");
  const next = `${value.slice(0, lineStart)}${prefixed}${value.slice(lineEnd)}`;
  const added = prefixed.length - (lineEnd - lineStart);
  return {
    value: next,
    start: start + prefixOf(0).length,
    end: end + added,
  };
}

/**
 * The tabs a guide shows one faction at a time: the wiki's tabset, a heading
 * the reader never draws over one heading per tab. The factions in the
 * game's own order, with nothing under them yet.
 */
export function factionTabs(title: string): string {
  const tabs = ["UEF", "Aeon", "Cybran", "Seraphim"].map((faction) => `### ${faction}\n\n`);
  return `## ${title}{.tabset}\n\n${tabs.join("\n")}`;
}

/** A picture on a line of its own, as the editor can change it. */
export interface PictureLine {
  start: number;
  end: number;
  alt: string;
  src: string;
  align: FigureAlign | null;
}

const PICTURE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)\)(?:\{([^}]*)\})?\s*$/;

/** The picture on the line `caret` is on, when that line is one. */
export function pictureAt(value: string, caret: number): PictureLine | null {
  const start = value.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
  const endIndex = value.indexOf("\n", caret);
  const end = endIndex === -1 ? value.length : endIndex;
  const match = PICTURE_LINE.exec(value.slice(start, end).trim());
  if (!match) return null;
  const align = /\.align-(left|right|center)\b/.exec(match[3] ?? "")?.[1] as FigureAlign | undefined;
  return { start, end, alt: match[1], src: match[2], align: align ?? null };
}

/** `value` with that picture's caption and alignment replaced. */
export function withPicture(
  value: string,
  picture: PictureLine,
  change: { alt?: string; align?: FigureAlign | null },
): string {
  // A bracket would end the caption early and turn the rest into text.
  const alt = (change.alt ?? picture.alt).replace(/[[\]\n]/g, "");
  const align = change.align === undefined ? picture.align : change.align;
  const line = `![${alt}](${picture.src})${align ? `{.align-${align}}` : ""}`;
  return `${value.slice(0, picture.start)}${line}${value.slice(picture.end)}`;
}

/** The four places a picture can sit, drawn as what they look like. */
const PLACEMENTS: { align: FigureAlign | null; key: MessageKey; glyph: ReactNode }[] = [
  {
    align: null,
    key: "training.editor.align.full",
    glyph: <rect x="2" y="3" width="12" height="7" rx="1" />,
  },
  {
    align: "left",
    key: "training.editor.align.left",
    glyph: (
      <>
        <rect x="2" y="3" width="6" height="5" rx="1" />
        <path d="M10 4h4M10 7h4M2 11h12" />
      </>
    ),
  },
  {
    align: "center",
    key: "training.editor.align.center",
    glyph: (
      <>
        <rect x="4.5" y="3" width="7" height="5" rx="1" />
        <path d="M2 11h12" />
      </>
    ),
  },
  {
    align: "right",
    key: "training.editor.align.right",
    glyph: (
      <>
        <rect x="8" y="3" width="6" height="5" rx="1" />
        <path d="M2 4h4M2 7h4M2 11h12" />
      </>
    ),
  },
];

/**
 * The line breaks that put something inserted into a paragraph of its own:
 * none against the edge of the text or an existing blank line, one against a
 * single line break, two against text. `side` is which edge of `text` the
 * insertion touches.
 */
export function paragraphBreak(text: string, side: "start" | "end"): string {
  if (text === "") return "";
  const edge = side === "end" ? text.slice(-2) : text.slice(0, 2);
  if (edge === "\n\n") return "";
  const touching = side === "end" ? edge.endsWith("\n") : edge.startsWith("\n");
  return touching ? "\n" : "\n\n";
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
  onAttach,
  accept,
}: Props) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState(false);
  const [caret, setCaret] = useState<number | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  // The picture the caret is on, which the bar under the toolbar edits.
  const picture = caret === null ? null : pictureAt(value, caret);
  const changePicture = (change: { alt?: string; align?: FigureAlign | null }) => {
    if (!picture) return;
    onChange(withPicture(value, picture, change));
    // Held at the line's start, so a caption that grows or shrinks never
    // carries the caret onto the next line and the bar away with it.
    setCaret(picture.start);
  };
  const pickerRef = useRef<HTMLInputElement>(null);

  /**
   * Insert the Markdown for `files` at the caret, on lines of its own: a
   * picture glued to the end of a sentence is an inline icon, not a figure.
   */
  const attachAtCaret = (files: File[]) => {
    if (!onAttach || files.length === 0) return;
    insertBlock(onAttach(files));
  };

  /** Put `snippet` at the caret as paragraphs of its own. */
  const insertBlock = (snippet: string, caretAt?: number) => {
    if (!snippet) return;
    const area = areaRef.current;
    const start = area?.selectionStart ?? value.length;
    const end = area?.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const lead = paragraphBreak(before, "end");
    const trail = paragraphBreak(after, "start");
    const inserted = `${lead}${snippet}${trail}`;
    onChange(`${before}${inserted}${after}`);
    const next = start + (caretAt === undefined ? inserted.length : lead.length + caretAt);
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(next, next);
      setCaret(next);
    });
  };

  /** The pictures among a paste's or a drop's files, if it carried any. */
  const picturesIn = (list: FileList | null | undefined) =>
    Array.from(list ?? []).filter((file) => file.type.startsWith("image/"));

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

  const insertTabs = () => {
    const snippet = factionTabs(t("training.editor.tabsTitle"));
    // The caret lands under the first tab's heading, where its text goes.
    const firstTab = snippet.indexOf("### ");
    insertBlock(snippet, snippet.indexOf("\n\n", firstTab) + 2);
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
          <button
            type="button"
            title={t("training.editor.tabs")}
            aria-label={t("training.editor.tabs")}
            onClick={insertTabs}
          >
            <Icon name="grid" size={13} />
          </button>
          {onAttach && (
            <>
              <button
                type="button"
                title={t("training.editor.image")}
                aria-label={t("training.editor.image")}
                onClick={() => pickerRef.current?.click()}
              >
                <Icon name="upload" size={13} />
              </button>
              <input
                ref={pickerRef}
                type="file"
                accept={accept}
                multiple
                hidden
                onChange={(event) => {
                  attachAtCaret(Array.from(event.target.files ?? []));
                  // The same file picked twice in a row is still a change.
                  event.target.value = "";
                }}
              />
            </>
          )}
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
          onChange={(event) => {
            onChange(event.target.value);
            setCaret(event.target.selectionStart);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          placeholder={placeholder}
          rows={rows}
          // A screenshot is usually on the clipboard or in a folder window,
          // and the shortest way in is the way it is already travelling.
          onPaste={(event) => {
            const pictures = onAttach ? picturesIn(event.clipboardData?.files) : [];
            if (pictures.length === 0) return;
            event.preventDefault();
            attachAtCaret(pictures);
          }}
          onDragOver={(event) => {
            // "Files" is the drag's type for files from the system, not text.
            const files = event.dataTransfer?.types.some((type) => type === "Files");
            if (onAttach && files) event.preventDefault();
          }}
          onDrop={(event) => {
            const pictures = onAttach ? picturesIn(event.dataTransfer?.files) : [];
            if (pictures.length === 0) return;
            event.preventDefault();
            attachAtCaret(pictures);
          }}
        />
      )}
      {/* The picture the caret is on: what it says under it, and where it
          sits. Shown only there, so the toolbar stays the size of the
          things that apply everywhere, and under the text so the line being
          edited does not move when it appears. */}
      {picture && !(ownPreview && preview) && (
        <div className="training-picture-bar">
          <span className="training-picture-bar-label">{t("training.editor.picture")}</span>
          <input
            type="text"
            value={picture.alt}
            aria-label={t("training.editor.caption")}
            placeholder={t("training.editor.captionPlaceholder")}
            onChange={(event) => changePicture({ alt: event.target.value })}
          />
          <div className="training-picture-bar-place" role="group">
            {PLACEMENTS.map((place) => (
              <button
                key={place.key}
                type="button"
                className={place.align === picture.align ? "is-on" : undefined}
                aria-pressed={place.align === picture.align}
                title={t(place.key)}
                aria-label={t(place.key)}
                onClick={() => changePicture({ align: place.align })}
              >
                <svg
                  viewBox="0 0 16 14"
                  width="16"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  aria-hidden
                >
                  {place.glyph}
                </svg>
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="muted training-markdown-hint">{t("training.editor.hint")}</p>
    </div>
  );
}
